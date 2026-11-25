'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coletarTelemetriaDispositivo } from '@/lib/deviceTelemetry';
import { getSupabaseMoradorClient, getSupabasePublicClient } from '@/lib/supabase';
import {
  AssembleiaConfig,
  ConexaoRealtimeStatus,
  ContadoresPublicosAssembleia,
  GridUnidadeTelaoItem,
  MapaInadimplentesPorEscopo,
  OpcaoVoto,
  PautaAssembleia,
  PlacarPublicoRpc,
  PresencaPublica,
  VotoUnidade,
} from '@/lib/types';

const DEFAULT_INADIMPLENTES_ESCOPO: MapaInadimplentesPorEscopo = {
  TODOS: 0,
  FASE_1: 0,
  FASE_2: 0,
  MODULO_1: 0,
  MODULO_2: 0,
  MODULO_3: 0,
  MODULO_4: 0,
};

export const DEFAULT_ASSEMBLEIA_CONFIG: AssembleiaConfig = {
  id: 1,
  assembleia_id: undefined,
  titulo: undefined,
  status: 'encerrada',
  assembleia_ativa: false,
  exigir_confirmacao_portaria: true,
  convocacao_ativa: 'AGUARDANDO',
  horario_primeira_convocacao: '19:00',
  horario_segunda_convocacao: '19:30',
  escopo_assembleia: 'TODOS',
  descontar_inadimplentes_quorum: true,
  total_inadimplentes: 0,
  inadimplentes_por_escopo: DEFAULT_INADIMPLENTES_ESCOPO,
  timer_duration_seconds: 120,
  timer_started_at: null,
  timer_running: false,
  version: 1,
  updated_at: new Date(0).toISOString(),
};

const DEFAULT_CONTADORES: ContadoresPublicosAssembleia = {
  total: 0,
  fase1: 0,
  fase2: 0,
  construtora: 0,
  confirmados_portaria: 0,
  conectados_online: 0,
  com_procuracao: 0,
  presentes_no_escopo: 0,
};

interface RpcEstadoPublicoPayload {
  ok: boolean;
  server_now?: string;
  assembleia: Record<string, unknown> | null;
  pauta_aberta: PautaAssembleia | null;
  ultima_pauta_encerrada: PautaAssembleia | null;
  pautas: PautaAssembleia[];
  placar: PlacarPublicoRpc | null;
  contadores: ContadoresPublicosAssembleia;
  unidades_grid?: GridUnidadeTelaoItem[];
}

function normalizarConfigPublica(raw: Record<string, unknown> | null): AssembleiaConfig {
  if (!raw) return DEFAULT_ASSEMBLEIA_CONFIG;
  const mapaRaw = (raw.inadimplentes_por_escopo ?? {}) as Partial<MapaInadimplentesPorEscopo>;

  return {
    id: 1,
    assembleia_id: typeof raw.id === 'string' ? raw.id : undefined,
    titulo: typeof raw.titulo === 'string' ? raw.titulo : undefined,
    status: (raw.status as AssembleiaConfig['status']) || 'encerrada',
    assembleia_ativa: Boolean(raw.assembleia_ativa),
    exigir_confirmacao_portaria:
      typeof raw.exigir_confirmacao_portaria === 'boolean'
        ? raw.exigir_confirmacao_portaria
        : true,
    convocacao_ativa:
      (raw.convocacao_ativa as AssembleiaConfig['convocacao_ativa']) || 'AGUARDANDO',
    horario_primeira_convocacao:
      typeof raw.horario_primeira_convocacao === 'string'
        ? raw.horario_primeira_convocacao
        : '19:00',
    horario_segunda_convocacao:
      typeof raw.horario_segunda_convocacao === 'string'
        ? raw.horario_segunda_convocacao
        : '19:30',
    escopo_assembleia:
      (raw.escopo_assembleia as AssembleiaConfig['escopo_assembleia']) || 'TODOS',
    descontar_inadimplentes_quorum:
      typeof raw.descontar_inadimplentes_quorum === 'boolean'
        ? raw.descontar_inadimplentes_quorum
        : true,
    total_inadimplentes: Math.max(0, Number(raw.total_inadimplentes ?? 0)),
    inadimplentes_por_escopo: {
      TODOS: Number(mapaRaw.TODOS ?? 0),
      FASE_1: Number(mapaRaw.FASE_1 ?? 0),
      FASE_2: Number(mapaRaw.FASE_2 ?? 0),
      MODULO_1: Number(mapaRaw.MODULO_1 ?? 0),
      MODULO_2: Number(mapaRaw.MODULO_2 ?? 0),
      MODULO_3: Number(mapaRaw.MODULO_3 ?? 0),
      MODULO_4: Number(mapaRaw.MODULO_4 ?? 0),
    },
    timer_duration_seconds: Math.max(10, Number(raw.timer_duration_seconds ?? 120)),
    timer_started_at:
      typeof raw.timer_started_at === 'string' ? raw.timer_started_at : null,
    timer_running: Boolean(raw.timer_running),
    version: Number(raw.version ?? 1),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  };
}

/**
 * Hook público 100% sanitizado (Zero PII, Zero postgres_changes em tabelas sensíveis).
 * - Modo 'morador': consome apenas assembleia_estado_publico() (~500B, placar agregado)
 *   + lê apenas os próprios votos via JWT assinado.
 * - Modo 'telao': consome assembleia_telao_snapshot() (estado + grid compacto sem PII e sem limite de 1000 linhas).
 * Na Fase 3 receberá também push via Realtime Broadcast sanitizado.
 */
export function useAssembleiaPublicRealtime(
  modo: 'morador' | 'telao' = 'morador',
  moradorJwt?: string | null
) {
  const [config, setConfig] = useState<AssembleiaConfig>(DEFAULT_ASSEMBLEIA_CONFIG);
  const [pautaAberta, setPautaAberta] = useState<PautaAssembleia | null>(null);
  const [ultimaPautaEncerrada, setUltimaPautaEncerrada] = useState<PautaAssembleia | null>(null);
  const [pautas, setPautas] = useState<PautaAssembleia[]>([]);
  const [placarRpc, setPlacarRpc] = useState<PlacarPublicoRpc | null>(null);
  const [contadores, setContadores] = useState<ContadoresPublicosAssembleia>(DEFAULT_CONTADORES);
  const [unidadesGrid, setUnidadesGrid] = useState<GridUnidadeTelaoItem[]>([]);
  const [meusVotos, setMeusVotos] = useState<VotoUnidade[]>([]);
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);

  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [statusConexao, setStatusConexao] = useState<ConexaoRealtimeStatus>('CONECTANDO');

  const isFetchingRef = useRef(false);
  const lastFetchAtRef = useRef(0);

  const recarregarTudo = useCallback(
    async (forcar = false) => {
      const agora = Date.now();
      if (isFetchingRef.current) return;
      if (!forcar && agora - lastFetchAtRef.current < 1500) return;

      isFetchingRef.current = true;
      lastFetchAtRef.current = agora;

      try {
        const supabasePublic = getSupabasePublicClient();
        const rpcName =
          modo === 'telao' ? 'assembleia_telao_snapshot' : 'assembleia_estado_publico';

        const { data, error } = await supabasePublic.rpc(rpcName, {
          p_assembleia_id: null,
        });

        if (error) throw error;

        const payload = (data ?? {}) as RpcEstadoPublicoPayload;

        if (payload.server_now) {
          const srvMs = Date.parse(payload.server_now);
          if (!Number.isNaN(srvMs)) {
            setServerOffsetMs(srvMs - Date.now());
          }
        }

        const novaConfig = normalizarConfigPublica(payload.assembleia);
        setConfig(novaConfig);
        setPautaAberta(payload.pauta_aberta ?? null);
        setUltimaPautaEncerrada(payload.ultima_pauta_encerrada ?? null);
        setPautas(payload.pautas ?? []);
        setPlacarRpc(payload.placar ?? null);
        setContadores(payload.contadores ?? DEFAULT_CONTADORES);
        if (modo === 'telao') {
          setUnidadesGrid(payload.unidades_grid ?? []);
        }

        // No modo morador autenticado via JWT, consulta exclusivamente os próprios votos da rodada vigente (RLS estrito)
        if (modo === 'morador' && moradorJwt && novaConfig.assembleia_id) {
          const pautaFoco = payload.pauta_aberta ?? payload.ultima_pauta_encerrada;
          if (pautaFoco?.id) {
            const clientMorador = getSupabaseMoradorClient(moradorJwt);
            const { data: votosData } = await clientMorador
              .from('assembleia_votos')
              .select('id, assembleia_id, pauta_id, rodada, bloco, apartamento, voto, is_construtora, updated_at')
              .eq('pauta_id', pautaFoco.id)
              .eq('rodada', pautaFoco.rodada ?? 1);
            if (votosData) {
              setMeusVotos(votosData as VotoUnidade[]);
            }
          } else {
            setMeusVotos([]);
          }
        }

        setErroConexao(null);
        setStatusConexao('AO_VIVO');
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Falha ao sincronizar dados da assembleia.';
        setErroConexao(msg);
        setStatusConexao('RECONECTANDO');
      } finally {
        isFetchingRef.current = false;
        setCarregandoInicial(false);
      }
    },
    [modo, moradorJwt]
  );

  useEffect(() => {
    void recarregarTudo(true);
    if (modo === 'morador') {
      void coletarTelemetriaDispositivo();
    }

    // Polling leve com jitter como ponte segura (Zero PII no Realtime) até Broadcast na Fase 3
    let timeoutId: number | null = null;
    let ativo = true;

    const agendarProximo = () => {
      if (!ativo) return;
      const baseMs = modo === 'telao' ? 2000 : 3000;
      const jitterMs = Math.floor(Math.random() * 1000);
      timeoutId = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void recarregarTudo(false).finally(agendarProximo);
        } else {
          agendarProximo();
        }
      }, baseMs + jitterMs);
    };

    agendarProximo();

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        const jitter = Math.floor(Math.random() * 900);
        window.setTimeout(() => {
          void recarregarTudo(false);
        }, jitter);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrOnline);
    window.addEventListener('online', handleVisibilityOrOnline);

    return () => {
      ativo = false;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
      window.removeEventListener('online', handleVisibilityOrOnline);
    };
  }, [modo, recarregarTudo]);

  // Projeção sanitizada de presenças e votos derivada do grid do /telao (para compatibilidade dos cálculos)
  const presencas: PresencaPublica[] = useMemo(() => {
    if (modo !== 'telao') return [];
    return unidadesGrid.map((u) => ({
      id: u.id,
      bloco: u.b,
      apartamento: u.a,
      fase: u.f,
      modulo: u.m,
      is_construtora: u.const,
      confirmado_portaria: u.port,
      online_conectado: u.onl,
      com_procuracao: u.proc,
      created_at: '',
    }));
  }, [modo, unidadesGrid]);

  const votos: VotoUnidade[] = useMemo(() => {
    if (modo === 'morador') return meusVotos;
    const pautaFocoId = pautaAberta?.id ?? ultimaPautaEncerrada?.id ?? '';
    return unidadesGrid
      .filter((u) => u.voto !== null)
      .map((u) => ({
        id: `${pautaFocoId}-${u.b}-${u.a}`,
        pauta_id: pautaFocoId,
        bloco: u.b,
        apartamento: u.a,
        voto: u.voto as OpcaoVoto,
        is_construtora: u.const,
        updated_at: '',
      }));
  }, [meusVotos, modo, pautaAberta?.id, ultimaPautaEncerrada?.id, unidadesGrid]);

  /** Registra voto exclusivamente via RPC autenticada por JWT do morador com chave de idempotência */
  const registrarVotoUnidade = useCallback(
    async (params: {
      jwtToken: string;
      pautaId: string;
      bloco: number;
      apartamento: number;
      voto: 'SIM' | 'NAO';
    }): Promise<{ ok: boolean; erro?: string; jaIgual?: boolean }> => {
      const telemetria = await coletarTelemetriaDispositivo();
      const clientMorador = getSupabaseMoradorClient(params.jwtToken);
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `voto-${params.pautaId}-${params.bloco}-${params.apartamento}-${crypto.randomUUID()}`
          : `voto-${params.pautaId}-${params.bloco}-${params.apartamento}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const { data, error } = await clientMorador.rpc('assembleia_registrar_voto', {
        p_pauta_id: params.pautaId,
        p_bloco: params.bloco,
        p_apartamento: params.apartamento,
        p_voto: params.voto,
        p_ip_address: telemetria.ip_address,
        p_device_id: telemetria.device_id,
        p_device_name: telemetria.device_name,
        p_idempotency_key: idempotencyKey,
      });

      if (error) {
        return { ok: false, erro: error.message };
      }

      const res = (data ?? {}) as {
        ok?: boolean;
        message?: string;
        ja_igual?: boolean;
        id?: string;
        rodada?: number;
        updated_at?: string;
      };

      if (!res.ok) {
        return { ok: false, erro: res.message || 'Não foi possível registrar seu voto.' };
      }

      const novoVoto: VotoUnidade = {
        id: res.id || `${params.pautaId}-${params.bloco}-${params.apartamento}`,
        pauta_id: params.pautaId,
        rodada: res.rodada ?? pautaAberta?.rodada ?? 1,
        bloco: params.bloco,
        apartamento: params.apartamento,
        voto: params.voto,
        is_construtora: false,
        updated_at: res.updated_at || new Date().toISOString(),
      };

      setMeusVotos((atual) => {
        const idx = atual.findIndex(
          (v) =>
            v.pauta_id === params.pautaId &&
            (v.rodada ?? 1) === (novoVoto.rodada ?? 1) &&
            v.bloco === params.bloco &&
            v.apartamento === params.apartamento
        );
        if (idx === -1) return [...atual, novoVoto];
        return atual.map((v, i) => (i === idx ? novoVoto : v));
      });

      void recarregarTudo(true);
      return { ok: true, jaIgual: Boolean(res.ja_igual) };
    },
    [pautaAberta?.rodada, recarregarTudo]
  );

  return {
    config,
    presencas,
    pautas,
    votos,
    meusVotos,
    unidadesGrid,
    placarRpc,
    contadores,
    pautaAberta,
    ultimaPautaEncerrada,
    serverOffsetMs,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    registrarVotoUnidade,
  };
}
