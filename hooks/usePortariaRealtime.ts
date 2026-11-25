'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabaseAuthClient, getSupabasePublicClient } from '@/lib/supabase';
import {
  AssembleiaConfig,
  AssembleiaRegistro,
  ConexaoRealtimeStatus,
  InadimplenteAdmin,
  MapaInadimplentesPorEscopo,
  PresencaAdmin,
  UnidadeCadastradaAdmin,
} from '@/lib/types';
import { limparCpf } from '@/lib/validators';
import { DEFAULT_ASSEMBLEIA_CONFIG } from './useAssembleiaPublicRealtime';
import { ResultadoOperacaoAdmin } from './useAssembleiaAdminRealtime';

function assembleiaParaConfigPortaria(asm: AssembleiaRegistro | null): AssembleiaConfig {
  if (!asm) return DEFAULT_ASSEMBLEIA_CONFIG;
  const mapaRaw = (asm.inadimplentes_por_escopo ?? {}) as Partial<MapaInadimplentesPorEscopo>;

  return {
    id: 1,
    assembleia_id: asm.id,
    titulo: asm.titulo,
    status: asm.status,
    assembleia_ativa: asm.status === 'ativa' && asm.convocacao_ativa !== 'ENCERRADA',
    exigir_confirmacao_portaria:
      typeof asm.exigir_confirmacao_portaria === 'boolean'
        ? asm.exigir_confirmacao_portaria
        : true,
    convocacao_ativa: asm.convocacao_ativa || 'AGUARDANDO',
    horario_primeira_convocacao: asm.horario_primeira_convocacao || '19:00',
    horario_segunda_convocacao: asm.horario_segunda_convocacao || '19:30',
    escopo_assembleia: asm.escopo_assembleia || 'TODOS',
    descontar_inadimplentes_quorum:
      typeof asm.descontar_inadimplentes_quorum === 'boolean'
        ? asm.descontar_inadimplentes_quorum
        : true,
    total_inadimplentes: Math.max(0, Number(asm.total_inadimplentes ?? 0)),
    inadimplentes_por_escopo: {
      TODOS: Number(mapaRaw.TODOS ?? 0),
      FASE_1: Number(mapaRaw.FASE_1 ?? 0),
      FASE_2: Number(mapaRaw.FASE_2 ?? 0),
      MODULO_1: Number(mapaRaw.MODULO_1 ?? 0),
      MODULO_2: Number(mapaRaw.MODULO_2 ?? 0),
      MODULO_3: Number(mapaRaw.MODULO_3 ?? 0),
      MODULO_4: Number(mapaRaw.MODULO_4 ?? 0),
    },
    timer_duration_seconds: Math.max(10, Number(asm.timer_duration_seconds ?? 120)),
    timer_started_at: asm.timer_started_at ?? null,
    timer_running: Boolean(asm.timer_running),
    version: asm.version ?? 1,
    updated_at: asm.updated_at || new Date().toISOString(),
  };
}

/**
 * Hook dedicado e ultraleve para a Recepção / Portaria (/portaria).
 * - Completamente desacoplado de /admin (nunca consulta votos, pautas, histórico ou auditoria).
 * - Carrega as 544 unidades base (assembleia_unidades) 1 única vez (ou sob demanda explícita).
 * - Sincroniza apenas presenças e inadimplentes da assembleia ativa usando Broadcast sanitizado
 *   (telao_grid) + cooldown/jitter, mantendo busca < 5ms nos tablets/celulares da entrada.
 */
export function usePortariaRealtime(autenticado: boolean) {
  const [config, setConfig] = useState<AssembleiaConfig>(DEFAULT_ASSEMBLEIA_CONFIG);
  const [assembleiaId, setAssembleiaId] = useState<string | null>(null);
  const [unidadesCadastradas, setUnidadesCadastradas] = useState<UnidadeCadastradaAdmin[]>([]);
  const [presencas, setPresencas] = useState<PresencaAdmin[]>([]);
  const [inadimplentes, setInadimplentes] = useState<InadimplenteAdmin[]>([]);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [statusConexao, setStatusConexao] = useState<ConexaoRealtimeStatus>('CONECTANDO');
  const [realtimeAtivo, setRealtimeAtivo] = useState(false);

  const baseCarregadaRef = useRef(false);
  const isFetchingRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const pendingTimerRef = useRef<number | null>(null);

  const recarregarPortaria = useCallback(
    async (opcoes?: { forcar?: boolean; recarregarBaseUnidades?: boolean }) => {
      if (!autenticado) return;
      const forcar = Boolean(opcoes?.forcar);
      const recarregarBase = Boolean(opcoes?.recarregarBaseUnidades) || !baseCarregadaRef.current;

      const agora = Date.now();
      if (isFetchingRef.current) return;
      if (!forcar && agora - lastFetchAtRef.current < 1800) return;

      isFetchingRef.current = true;
      lastFetchAtRef.current = agora;

      try {
        const supabase = getSupabaseAuthClient();

        // 1. Busca apenas a assembleia ativa (ou a mais recente como fallback somente leitura)
        const { data: asmAtiva, error: errAtiva } = await supabase
          .from('assembleias')
          .select('*')
          .eq('status', 'ativa')
          .limit(1)
          .maybeSingle();

        if (errAtiva) throw errAtiva;

        let asmFoco = (asmAtiva as AssembleiaRegistro | null) ?? null;
        if (!asmFoco) {
          const { data: asmRecente } = await supabase
            .from('assembleias')
            .select('*')
            .order('data_assembleia', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          asmFoco = (asmRecente as AssembleiaRegistro | null) ?? null;
        }

        setConfig(assembleiaParaConfigPortaria(asmFoco));
        const asmId = asmFoco?.id ?? null;
        setAssembleiaId(asmId);

        // 2. Carrega presenças + inadimplentes (e base de 544 unidades somente na 1ª carga ou sob demanda)
        const [presencasRes, inadRes, unidadesRes] = await Promise.all([
          asmId
            ? supabase
                .from('assembleia_presencas')
                .select(
                  'id, assembleia_id, bloco, apartamento, fase, modulo, nome_completo, cpf, cpf_procurador, is_construtora, confirmado_portaria, online_conectado, com_procuracao, observacao_portaria, conectado_em, created_at'
                )
                .eq('assembleia_id', asmId)
                .order('bloco', { ascending: true })
                .order('apartamento', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
          asmId
            ? supabase
                .from('assembleia_inadimplentes')
                .select('id, assembleia_id, bloco, apartamento, fase, modulo, observacao, created_at')
                .eq('assembleia_id', asmId)
                .order('bloco', { ascending: true })
                .order('apartamento', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
          recarregarBase
            ? supabase
                .from('assembleia_unidades')
                .select(
                  'id, bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora, observacao, updated_at'
                )
                .order('bloco', { ascending: true })
                .order('apartamento', { ascending: true })
            : Promise.resolve({ data: null, error: null }),
        ]);

        if (presencasRes.error) throw presencasRes.error;
        if (inadRes.error) throw inadRes.error;
        if (unidadesRes.error) throw unidadesRes.error;

        setPresencas((presencasRes.data ?? []) as PresencaAdmin[]);
        setInadimplentes((inadRes.data ?? []) as InadimplenteAdmin[]);
        if (unidadesRes.data) {
          setUnidadesCadastradas(unidadesRes.data as UnidadeCadastradaAdmin[]);
          baseCarregadaRef.current = true;
        }

        setErroConexao(null);
        setStatusConexao('AO_VIVO');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha ao sincronizar Portaria.';
        setErroConexao(msg);
        setStatusConexao('RECONECTANDO');
      } finally {
        isFetchingRef.current = false;
        setCarregandoInicial(false);
      }
    },
    [autenticado]
  );

  // Debounced refresh acionado por eventos Broadcast de outros atendentes na portaria
  const agendarRefreshLeve = useCallback(() => {
    if (pendingTimerRef.current !== null) return;
    const jitterMs = 350 + Math.floor(Math.random() * 550);
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      void recarregarPortaria({ forcar: false, recarregarBaseUnidades: false });
    }, jitterMs);
  }, [recarregarPortaria]);

  // Assinatura ao canal Broadcast sanitizado para sincronizar múltiplos celulares na recepção
  useEffect(() => {
    if (!autenticado || !assembleiaId) return;

    const supabasePublic = getSupabasePublicClient();
    const canal = supabasePublic
      .channel(`assembleia:${assembleiaId}:telao_grid`, {
        config: {
          broadcast: { self: false },
          private: true,
        },
      })
      .on('broadcast', { event: 'grid_delta' }, (msg) => {
        const delta = msg?.payload as
          | { op?: string; b?: number; a?: number; unit?: { b: number; a: number; onl: boolean; port: boolean; proc: boolean } }
          | undefined;
        if (!delta?.op) return;

        if (delta.op === 'PRESENCA_UPSERT' && delta.unit) {
          const u = delta.unit;
          let encontrouLocal = false;
          setPresencas((atual) =>
            atual.map((item) => {
              if (item.bloco === u.b && item.apartamento === u.a) {
                encontrouLocal = true;
                return {
                  ...item,
                  online_conectado: u.onl,
                  confirmado_portaria: u.port,
                  com_procuracao: u.proc,
                };
              }
              return item;
            })
          );
          // Se foi confirmada por outro atendente no portão, busca a lista leve atualizada
          if (!encontrouLocal) {
            agendarRefreshLeve();
          }
        } else if (delta.op === 'PRESENCA_DELETE' && typeof delta.b === 'number' && typeof delta.a === 'number') {
          setPresencas((atual) =>
            atual.filter((item) => !(item.bloco === delta.b && item.apartamento === delta.a))
          );
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeAtivo(true);
          setStatusConexao('AO_VIVO');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeAtivo(false);
          setStatusConexao('RECONECTANDO');
        }
      });

    return () => {
      setRealtimeAtivo(false);
      void supabasePublic.removeChannel(canal);
    };
  }, [agendarRefreshLeve, assembleiaId, autenticado]);

  // Carga inicial + fallback leve com jitter
  useEffect(() => {
    if (!autenticado) return;
    void recarregarPortaria({ forcar: true, recarregarBaseUnidades: true });

    let timeoutId: number | null = null;
    let ativo = true;

    const agendarProximo = () => {
      if (!ativo) return;
      const baseMs = realtimeAtivo ? 20000 : 6000;
      const jitterMs = Math.floor(Math.random() * (realtimeAtivo ? 8000 : 2500));
      timeoutId = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void recarregarPortaria({ forcar: false, recarregarBaseUnidades: false }).finally(
            agendarProximo
          );
        } else {
          agendarProximo();
        }
      }, baseMs + jitterMs);
    };

    agendarProximo();

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        const jitter = 200 + Math.floor(Math.random() * 800);
        window.setTimeout(() => {
          void recarregarPortaria({ forcar: false, recarregarBaseUnidades: false });
        }, jitter);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrOnline);
    window.addEventListener('online', handleVisibilityOrOnline);

    return () => {
      ativo = false;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
      window.removeEventListener('online', handleVisibilityOrOnline);
    };
  }, [autenticado, realtimeAtivo, recarregarPortaria]);

  const confirmarPresencaPortaria = useCallback(
    async (dados: {
      bloco: number;
      apartamento: number;
      com_procuracao?: boolean;
      observacao?: string;
      cpf_procurador?: string;
    }): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_confirmar_portaria', {
        p_bloco: dados.bloco,
        p_apartamento: dados.apartamento,
        p_com_procuracao: Boolean(dados.com_procuracao),
        p_observacao: dados.observacao?.trim() || null,
        p_cpf_procurador: dados.cpf_procurador ? limparCpf(dados.cpf_procurador) : null,
        p_assembleia_id: assembleiaId,
      });

      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as { ok?: boolean; message?: string; presenca?: PresencaAdmin };
      if (!res.ok) {
        return {
          ok: false,
          mensagem: res.message || 'Não foi possível confirmar a entrada na portaria.',
        };
      }

      // Atualização otimista imediata em memória (zero espera pelo próximo poll)
      if (res.presenca) {
        const nova = res.presenca;
        setPresencas((atual) => {
          const idx = atual.findIndex(
            (p) => p.bloco === nova.bloco && p.apartamento === nova.apartamento
          );
          if (idx === -1) {
            return [...atual, nova].sort(
              (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
            );
          }
          return atual.map((p, i) => (i === idx ? nova : p));
        });
      } else {
        await recarregarPortaria({ forcar: true, recarregarBaseUnidades: false });
      }

      return {
        ok: true,
        mensagem:
          res.message ||
          `Bloco ${String(dados.bloco).padStart(2, '0')} • Apto ${dados.apartamento} confirmado na Portaria!`,
      };
    },
    [assembleiaId, recarregarPortaria]
  );

  const removerPresencaPortaria = useCallback(
    async (
      presenca: Pick<PresencaAdmin, 'id' | 'bloco' | 'apartamento'>
    ): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_cancelar_entrada_portaria', {
        p_presenca_id: presenca.id,
      });

      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok) return { ok: false, mensagem: res.message || 'Erro ao remover presença.' };

      setPresencas((atual) => atual.filter((p) => p.id !== presenca.id));
      return {
        ok: true,
        mensagem:
          res.message ||
          `Bloco ${String(presenca.bloco).padStart(2, '0')} • Apto ${presenca.apartamento} removido da lista.`,
      };
    },
    []
  );

  const recarregarTudo = useCallback(async () => {
    await recarregarPortaria({ forcar: true, recarregarBaseUnidades: true });
  }, [recarregarPortaria]);

  return {
    config,
    unidadesCadastradas,
    presencas,
    inadimplentes,
    carregandoInicial,
    erroConexao,
    statusConexao,
    realtimeAtivo,
    recarregarTudo,
    confirmarPresencaPortaria,
    removerPresencaPortaria,
  };
}
