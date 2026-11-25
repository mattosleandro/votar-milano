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
  ok?: boolean;
  server_now?: string;
  assembleia: Record<string, unknown> | null;
  pauta_aberta: PautaAssembleia | null;
  ultima_pauta_encerrada: PautaAssembleia | null;
  pautas?: PautaAssembleia[];
  placar: PlacarPublicoRpc | null;
  contadores: ContadoresPublicosAssembleia;
  unidades_grid?: GridUnidadeTelaoItem[];
}

interface TelaoGridDeltaPayload {
  op: 'PRESENCA_UPSERT' | 'PRESENCA_DELETE' | 'VOTO_UPSERT' | 'VOTO_DELETE' | 'RELOAD_GRID';
  assembleia_id?: string;
  pauta_id?: string;
  rodada?: number;
  status?: string;
  b?: number;
  a?: number;
  voto?: OpcaoVoto | null;
  const?: boolean;
  unit?: {
    id: string;
    b: number;
    a: number;
    f: 1 | 2;
    m: 1 | 2 | 3 | 4;
    pres: boolean;
    port: boolean;
    onl: boolean;
    proc: boolean;
    const: boolean;
  };
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
 * - Usa Realtime Broadcast Read-Only (private: true, RLS SELECT em realtime.messages):
 *   1) Canal assembleia:<id>:placar -> placar_update (~1KB, throttle 500ms, entrega ~80ms)
 *   2) Canal assembleia:<id>:telao_grid (somente /telao) -> grid_delta (~140B, delta incremental)
 * - Fallback automático para polling leve com jitter caso o WebSocket oscile (Modo Contingência).
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
  const [realtimeAtivo, setRealtimeAtivo] = useState(false);

  const isFetchingRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const pautaFocoRef = useRef<{ id: string | null; rodada: number }>({ id: null, rodada: 1 });
  const moradorJwtRef = useRef<string | null>(moradorJwt ?? null);

  useEffect(() => {
    moradorJwtRef.current = moradorJwt ?? null;
  }, [moradorJwt]);

  const carregarMeusVotos = useCallback(async (pautaId: string | null, rodada: number) => {
    const jwt = moradorJwtRef.current;
    if (modo !== 'morador' || !jwt || !pautaId) {
      if (!pautaId) setMeusVotos([]);
      return;
    }
    try {
      const clientMorador = getSupabaseMoradorClient(jwt);
      const { data: votosData } = await clientMorador
        .from('assembleia_votos')
        .select('id, assembleia_id, pauta_id, rodada, bloco, apartamento, voto, is_construtora, updated_at')
        .eq('pauta_id', pautaId)
        .eq('rodada', rodada);
      if (votosData) {
        setMeusVotos(votosData as VotoUnidade[]);
      }
    } catch {
      // Silencioso; será ressincronizado na próxima atualização
    }
  }, [modo]);

  const aplicarEstadoPublico = useCallback(
    (payload: RpcEstadoPublicoPayload, veioDeBroadcast: boolean) => {
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
      if (Array.isArray(payload.pautas)) {
        setPautas(payload.pautas);
      }
      setPlacarRpc(payload.placar ?? null);
      if (payload.contadores) {
        setContadores(payload.contadores);
      }
      if (modo === 'telao' && Array.isArray(payload.unidades_grid)) {
        setUnidadesGrid(payload.unidades_grid);
      }

      const pautaFoco = payload.pauta_aberta ?? payload.ultima_pauta_encerrada;
      const novoFocoId = pautaFoco?.id ?? null;
      const novaRodada = pautaFoco?.rodada ?? 1;
      const mudouPautaOuRodada =
        pautaFocoRef.current.id !== novoFocoId || pautaFocoRef.current.rodada !== novaRodada;
      pautaFocoRef.current = { id: novoFocoId, rodada: novaRodada };

      if (modo === 'morador' && moradorJwtRef.current && (!veioDeBroadcast || mudouPautaOuRodada)) {
        void carregarMeusVotos(novoFocoId, novaRodada);
      }
    },
    [carregarMeusVotos, modo]
  );

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
        aplicarEstadoPublico(payload, false);

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
    [aplicarEstadoPublico, modo]
  );

  // Recarrega meusVotos imediatamente quando o morador conclui o login por CPF
  useEffect(() => {
    if (modo === 'morador' && moradorJwt) {
      void carregarMeusVotos(pautaFocoRef.current.id, pautaFocoRef.current.rodada);
    } else if (modo === 'morador' && !moradorJwt) {
      setMeusVotos([]);
    }
  }, [carregarMeusVotos, modo, moradorJwt]);

  // 1. Assinatura dos Canais Realtime Broadcast Read-Only (private: true, Zero PII)
  const assembleiaIdAtual = config.assembleia_id ?? null;

  useEffect(() => {
    if (!assembleiaIdAtual) return;

    const supabase = getSupabasePublicClient();
    const canalPlacarNome = `assembleia:${assembleiaIdAtual}:placar`;

    const canalPlacar = supabase
      .channel(canalPlacarNome, {
        config: {
          broadcast: { self: false },
          private: true,
        },
      })
      .on('broadcast', { event: 'placar_update' }, (msg) => {
        const payload = (msg?.payload ?? null) as RpcEstadoPublicoPayload | null;
        if (!payload || !payload.assembleia) return;
        aplicarEstadoPublico(payload, true);
        setErroConexao(null);
        setStatusConexao('AO_VIVO');
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeAtivo(true);
          setStatusConexao('AO_VIVO');
          setErroConexao(null);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeAtivo(false);
          setStatusConexao('RECONECTANDO');
        }
      });

    let canalTelao: ReturnType<typeof supabase.channel> | null = null;
    if (modo === 'telao') {
      const canalTelaoNome = `assembleia:${assembleiaIdAtual}:telao_grid`;
      canalTelao = supabase
        .channel(canalTelaoNome, {
          config: {
            broadcast: { self: false },
            private: true,
          },
        })
        .on('broadcast', { event: 'grid_delta' }, (msg) => {
          const delta = (msg?.payload ?? null) as TelaoGridDeltaPayload | null;
          if (!delta || !delta.op) return;

          if (delta.op === 'RELOAD_GRID') {
            const jitter = 120 + Math.floor(Math.random() * 280);
            window.setTimeout(() => {
              void recarregarTudo(true);
            }, jitter);
            return;
          }

          if (delta.op === 'PRESENCA_UPSERT' && delta.unit) {
            const u = delta.unit;
            setUnidadesGrid((atual) => {
              const idx = atual.findIndex((item) => item.b === u.b && item.a === u.a);
              if (idx === -1) {
                const novo: GridUnidadeTelaoItem = { ...u, voto: null };
                return [...atual, novo].sort((x, y) => x.b - y.b || x.a - y.a);
              }
              const existente = atual[idx];
              const atualizado: GridUnidadeTelaoItem = { ...u, voto: existente.voto };
              return atual.map((item, i) => (i === idx ? atualizado : item));
            });
            return;
          }

          if (delta.op === 'PRESENCA_DELETE' && typeof delta.b === 'number' && typeof delta.a === 'number') {
            setUnidadesGrid((atual) =>
              atual.filter((item) => !(item.b === delta.b && item.a === delta.a))
            );
            return;
          }

          if (
            (delta.op === 'VOTO_UPSERT' || delta.op === 'VOTO_DELETE') &&
            typeof delta.b === 'number' &&
            typeof delta.a === 'number'
          ) {
            // Aplica delta apenas se pertencer à pauta e rodada atualmente em foco
            if (
              delta.pauta_id &&
              pautaFocoRef.current.id &&
              delta.pauta_id !== pautaFocoRef.current.id
            ) {
              return;
            }
            if (
              typeof delta.rodada === 'number' &&
              delta.rodada !== pautaFocoRef.current.rodada
            ) {
              return;
            }

            const novoVoto = delta.op === 'VOTO_UPSERT' ? (delta.voto ?? null) : null;
            setUnidadesGrid((atual) =>
              atual.map((item) =>
                item.b === delta.b && item.a === delta.a ? { ...item, voto: novoVoto } : item
              )
            );
          }
        })
        .subscribe();
    }

    return () => {
      setRealtimeAtivo(false);
      void supabase.removeChannel(canalPlacar);
      if (canalTelao) {
        void supabase.removeChannel(canalTelao);
      }
    };
  }, [aplicarEstadoPublico, assembleiaIdAtual, modo, recarregarTudo]);

  // 2. Carga Inicial + Polling de Contingência/Sanidade (25-35s com WS ativo; 4-7s se WS cair)
  useEffect(() => {
    void recarregarTudo(true);
    if (modo === 'morador') {
      void coletarTelemetriaDispositivo();
    }

    let timeoutId: number | null = null;
    let ativo = true;

    const agendarProximo = () => {
      if (!ativo) return;
      // Com WebSocket saudável e assembleia ativa: apenas check de sanidade a cada 25-35s (>90% menos reqs!)
      // Com assembleia encerrada (aguardando criação de nova): 8-12s para descobrir novo UUID
      // Em contingência (WebSocket desconectado): 4-7s para manter operação contínua
      let baseMs = 25000;
      let jitterRange = 10000;
      if (!realtimeAtivo) {
        baseMs = modo === 'telao' ? 4000 : 5000;
        jitterRange = 2000;
      } else if (!config.assembleia_ativa) {
        baseMs = 8000;
        jitterRange = 4000;
      }

      const jitterMs = Math.floor(Math.random() * jitterRange);
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
        const jitter = Math.floor(Math.random() * 1400);
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
  }, [config.assembleia_ativa, modo, realtimeAtivo, recarregarTudo]);

  // Projeção sanitizada de presenças e votos derivada do grid do /telao
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
    const pautaFoco = pautaAberta ?? ultimaPautaEncerrada;
    const pautaFocoId = pautaFoco?.id ?? '';
    const rodadaFoco = pautaFoco?.rodada ?? 1;
    return unidadesGrid
      .filter((u) => u.voto !== null)
      .map((u) => ({
        id: `${pautaFocoId}-${rodadaFoco}-${u.b}-${u.a}`,
        pauta_id: pautaFocoId,
        rodada: rodadaFoco,
        bloco: u.b,
        apartamento: u.a,
        voto: u.voto as OpcaoVoto,
        is_construtora: u.const,
        updated_at: '',
      }));
  }, [meusVotos, modo, pautaAberta, ultimaPautaEncerrada, unidadesGrid]);

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

      // Com Broadcast ativo, o placar já chega via WebSocket em ~80-500ms; força reload só se WS estiver off
      if (!realtimeAtivo) {
        void recarregarTudo(true);
      }
      return { ok: true, jaIgual: Boolean(res.ja_igual) };
    },
    [pautaAberta?.rodada, realtimeAtivo, recarregarTudo]
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
    realtimeAtivo,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    registrarVotoUnidade,
  };
}
