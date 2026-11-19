'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coletarTelemetriaDispositivo } from '@/lib/deviceTelemetry';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import {
  AssembleiaConfig,
  ConexaoRealtimeStatus,
  FaseCondominio,
  MapaInadimplentesPorEscopo,
  ModuloCondominio,
  OpcaoVoto,
  PautaAssembleia,
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
  updated_at: new Date(0).toISOString(),
};

/**
 * Sanitizador estrito: descarta qualquer campo extra (como nome_completo ou cpf)
 * caso venha em um payload bruto do Realtime, garantindo Zero PII no estado público.
 */
function sanitizarPresencaPublica(raw: Record<string, unknown>): PresencaPublica | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const bloco = Number(raw.bloco);
  const apartamento = Number(raw.apartamento);
  const fase = Number(raw.fase) as FaseCondominio;
  const modulo = Number(raw.modulo) as ModuloCondominio;

  if (!bloco || !apartamento) return null;

  return {
    id: raw.id,
    bloco,
    apartamento,
    fase: fase === 1 || fase === 2 ? fase : bloco >= 19 ? 1 : 2,
    modulo:
      modulo >= 1 && modulo <= 4
        ? modulo
        : bloco >= 26
          ? 1
          : bloco >= 19
            ? 2
            : (bloco >= 1 && bloco <= 4) || (bloco >= 9 && bloco <= 11)
              ? 3
              : 4,
    is_construtora: Boolean(raw.is_construtora),
    confirmado_portaria:
      typeof raw.confirmado_portaria === 'boolean' ? raw.confirmado_portaria : true,
    online_conectado:
      typeof raw.online_conectado === 'boolean'
        ? raw.online_conectado
        : Boolean(raw.is_construtora),
    com_procuracao: Boolean(raw.com_procuracao),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
  };
}

function normalizarConfig(raw: Record<string, unknown> | null): AssembleiaConfig {
  if (!raw) return DEFAULT_ASSEMBLEIA_CONFIG;
  const mapaRaw = (raw.inadimplentes_por_escopo ?? {}) as Partial<MapaInadimplentesPorEscopo>;

  return {
    id: 1,
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
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  };
}

export function useAssembleiaPublicRealtime(channelPrefix = 'public') {
  const [config, setConfig] = useState<AssembleiaConfig>(DEFAULT_ASSEMBLEIA_CONFIG);
  const [presencas, setPresencas] = useState<PresencaPublica[]>([]);
  const [pautas, setPautas] = useState<PautaAssembleia[]>([]);
  const [votos, setVotos] = useState<VotoUnidade[]>([]);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [statusConexao, setStatusConexao] = useState<ConexaoRealtimeStatus>('CONECTANDO');

  const isFetchingRef = useRef(false);

  const recarregarTudo = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const supabase = getSupabaseBrowserClient();

      // Carregamento paralelo sem cascata (async-parallel) e projeção estrita sem Nome/CPF
      const [configRes, presencasRes, pautasRes, votosRes] = await Promise.all([
        supabase
          .from('assembleia_config')
          .select(
            'id, assembleia_ativa, exigir_confirmacao_portaria, convocacao_ativa, horario_primeira_convocacao, horario_segunda_convocacao, escopo_assembleia, descontar_inadimplentes_quorum, total_inadimplentes, inadimplentes_por_escopo, timer_duration_seconds, timer_started_at, timer_running, updated_at'
          )
          .eq('id', 1)
          .maybeSingle(),
        supabase
          .from('assembleia_presencas')
          .select(
            'id, bloco, apartamento, fase, modulo, is_construtora, confirmado_portaria, online_conectado, com_procuracao, created_at'
          )
          .order('bloco', { ascending: true })
          .order('apartamento', { ascending: true }),
        supabase
          .from('assembleia_pautas')
          .select('id, ordem, titulo, descricao, escopo, status, created_at, opened_at, closed_at')
          .order('ordem', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase
          .from('assembleia_votos')
          .select('id, pauta_id, bloco, apartamento, voto, is_construtora, updated_at'),
      ]);

      if (configRes.error) throw configRes.error;
      if (presencasRes.error) throw presencasRes.error;
      if (pautasRes.error) throw pautasRes.error;
      if (votosRes.error) throw votosRes.error;

      setConfig(normalizarConfig(configRes.data as Record<string, unknown> | null));

      const presencasLimpas: PresencaPublica[] = [];
      for (const item of presencasRes.data ?? []) {
        const p = sanitizarPresencaPublica(item as unknown as Record<string, unknown>);
        if (p) presencasLimpas.push(p);
      }
      setPresencas(presencasLimpas);
      setPautas((pautasRes.data ?? []) as PautaAssembleia[]);
      setVotos((votosRes.data ?? []) as VotoUnidade[]);
      setErroConexao(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao sincronizar dados em tempo real.';
      setErroConexao(msg);
    } finally {
      isFetchingRef.current = false;
      setCarregandoInicial(false);
    }
  }, []);

  useEffect(() => {
    void recarregarTudo();
    void coletarTelemetriaDispositivo();

    const supabase = getSupabaseBrowserClient();
    const channelName = `assembleia-${channelPrefix}-${Math.random().toString(36).slice(2, 8)}`;

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_config' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            setConfig(normalizarConfig(payload.new as Record<string, unknown>));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_presencas' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const limpa = sanitizarPresencaPublica(payload.new as Record<string, unknown>);
            if (!limpa) return;
            setPresencas((atual) => {
              const idx = atual.findIndex(
                (item) =>
                  item.id === limpa.id ||
                  (item.bloco === limpa.bloco && item.apartamento === limpa.apartamento)
              );
              const proximo =
                idx === -1
                  ? [...atual, limpa]
                  : atual.map((item, i) => (i === idx ? limpa : item));
              return [...proximo].sort(
                (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
              );
            });
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Record<string, unknown>;
            const oldId = typeof oldRow?.id === 'string' ? oldRow.id : null;
            const oldBloco = Number(oldRow?.bloco);
            const oldApto = Number(oldRow?.apartamento);
            setPresencas((atual) =>
              atual.filter((item) => {
                if (oldId && item.id === oldId) return false;
                if (oldBloco && oldApto && item.bloco === oldBloco && item.apartamento === oldApto) {
                  return false;
                }
                return true;
              })
            );
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_pautas' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const nova = payload.new as PautaAssembleia;
            setPautas((atual) => {
              const existe = atual.some((p) => p.id === nova.id);
              const lista = existe
                ? atual.map((p) => (p.id === nova.id ? nova : p))
                : [...atual, nova];
              return [...lista].sort((a, b) => a.ordem - b.ordem);
            });
          } else if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string })?.id;
            if (oldId) {
              setPautas((atual) => atual.filter((p) => p.id !== oldId));
            }
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_votos' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const novo = payload.new as VotoUnidade;
            setVotos((atual) => {
              const idx = atual.findIndex(
                (v) =>
                  v.id === novo.id ||
                  (v.pauta_id === novo.pauta_id &&
                    v.bloco === novo.bloco &&
                    v.apartamento === novo.apartamento)
              );
              if (idx === -1) return [...atual, novo];
              return atual.map((v, i) => (i === idx ? novo : v));
            });
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<VotoUnidade>;
            setVotos((atual) =>
              atual.filter((v) => {
                if (oldRow?.id && v.id === oldRow.id) return false;
                if (
                  oldRow?.pauta_id &&
                  oldRow?.bloco &&
                  oldRow?.apartamento &&
                  v.pauta_id === oldRow.pauta_id &&
                  v.bloco === oldRow.bloco &&
                  v.apartamento === oldRow.apartamento
                ) {
                  return false;
                }
                return true;
              })
            );
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setStatusConexao((anterior) => {
            if (anterior === 'RECONECTANDO') {
              void recarregarTudo();
            }
            return 'AO_VIVO';
          });
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          setStatusConexao('RECONECTANDO');
        }
      });

    // Ressincroniza automaticamente quando o celular volta do bloqueio de tela ou reconecta no 4G/5G
    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        void recarregarTudo();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrOnline);
    window.addEventListener('online', handleVisibilityOrOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
      window.removeEventListener('online', handleVisibilityOrOnline);
      void supabase.removeChannel(channel);
    };
  }, [channelPrefix, recarregarTudo]);

  const pautaAberta = useMemo(
    () => pautas.find((p) => p.status === 'aberta') ?? null,
    [pautas]
  );

  // Última pauta encerrada para exibição elegante de resultado quando não há pauta aberta
  const ultimaPautaEncerrada = useMemo(() => {
    const encerradas = pautas.filter((p) => p.status === 'encerrada');
    if (encerradas.length === 0) return null;
    return encerradas.reduce((maisRecente, atual) => {
      const tA = maisRecente.closed_at ? Date.parse(maisRecente.closed_at) : maisRecente.ordem;
      const tB = atual.closed_at ? Date.parse(atual.closed_at) : atual.ordem;
      return tB >= tA ? atual : maisRecente;
    });
  }, [pautas]);

  /** Registra ou altera voto de forma otimista + upsert transacional no banco */
  const registrarVotoUnidade = useCallback(
    async (params: {
      pautaId: string;
      bloco: number;
      apartamento: number;
      voto: OpcaoVoto;
      isConstrutora?: boolean;
    }): Promise<{ ok: boolean; erro?: string }> => {
      const telemetria = await coletarTelemetriaDispositivo();
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('assembleia_votos')
        .upsert(
          {
            pauta_id: params.pautaId,
            bloco: params.bloco,
            apartamento: params.apartamento,
            voto: params.voto,
            is_construtora: Boolean(params.isConstrutora),
            ip_address: telemetria.ip_address,
            device_id: telemetria.device_id,
            device_name: telemetria.device_name,
          },
          { onConflict: 'pauta_id,bloco,apartamento' }
        )
        .select('id, pauta_id, bloco, apartamento, voto, is_construtora, updated_at')
        .single();

      if (error) {
        return { ok: false, erro: error.message };
      }

      if (data) {
        const novo = data as VotoUnidade;
        setVotos((atual) => {
          const idx = atual.findIndex(
            (v) =>
              v.pauta_id === novo.pauta_id &&
              v.bloco === novo.bloco &&
              v.apartamento === novo.apartamento
          );
          if (idx === -1) return [...atual, novo];
          return atual.map((v, i) => (i === idx ? novo : v));
        });
      }

      return { ok: true };
    },
    []
  );

  return {
    config,
    presencas,
    pautas,
    votos,
    pautaAberta,
    ultimaPautaEncerrada,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    registrarVotoUnidade,
  };
}
