'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { obterInfoBloco, unidadePertenceAoEscopo } from '@/lib/condominio';
import { exportarPacoteCompletoAssembleiaCsv } from '@/lib/csv';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import {
  AssembleiaConfig,
  ConexaoRealtimeStatus,
  EscopoVotacao,
  HistoricoAssembleia,
  InadimplenteAdmin,
  MapaInadimplentesPorEscopo,
  OpcaoVoto,
  PautaAssembleia,
  PresencaAdmin,
  UnidadeCadastradaAdmin,
  VotoUnidade,
} from '@/lib/types';
import { limparCpf } from '@/lib/validators';
import { DEFAULT_ASSEMBLEIA_CONFIG } from './useAssembleiaPublicRealtime';

function normalizarConfigAdmin(raw: Record<string, unknown> | null): AssembleiaConfig {
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

export interface ResultadoOperacaoAdmin {
  ok: boolean;
  mensagem: string;
}

export function useAssembleiaAdminRealtime(autenticado: boolean) {
  const [config, setConfig] = useState<AssembleiaConfig>(DEFAULT_ASSEMBLEIA_CONFIG);
  const [unidadesCadastradas, setUnidadesCadastradas] = useState<UnidadeCadastradaAdmin[]>([]);
  const [presencas, setPresencas] = useState<PresencaAdmin[]>([]);
  const [inadimplentes, setInadimplentes] = useState<InadimplenteAdmin[]>([]);
  const [pautas, setPautas] = useState<PautaAssembleia[]>([]);
  const [votos, setVotos] = useState<VotoUnidade[]>([]);
  const [historicoAssembleias, setHistoricoAssembleias] = useState<HistoricoAssembleia[]>([]);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [statusConexao, setStatusConexao] = useState<ConexaoRealtimeStatus>('CONECTANDO');

  const isFetchingRef = useRef(false);

  const recarregarInadimplentesEUnidades = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const [inadRes, unidRes] = await Promise.all([
      supabase
        .from('assembleia_inadimplentes')
        .select('id, bloco, apartamento, fase, modulo, observacao, created_at')
        .order('bloco', { ascending: true })
        .order('apartamento', { ascending: true }),
      supabase
        .from('assembleia_unidades')
        .select(
          'id, bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora, observacao, updated_at'
        )
        .order('bloco', { ascending: true })
        .order('apartamento', { ascending: true }),
    ]);

    if (!inadRes.error && inadRes.data) {
      setInadimplentes(inadRes.data as InadimplenteAdmin[]);
    }
    if (!unidRes.error && unidRes.data) {
      setUnidadesCadastradas(unidRes.data as UnidadeCadastradaAdmin[]);
    }
  }, []);

  const recarregarTudo = useCallback(async () => {
    if (!autenticado || isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const supabase = getSupabaseBrowserClient();
      const [
        configRes,
        unidadesRes,
        presencasRes,
        inadimplentesRes,
        pautasRes,
        votosRes,
        historicoRes,
      ] = await Promise.all([
        supabase
          .from('assembleia_config')
          .select(
            'id, assembleia_ativa, exigir_confirmacao_portaria, convocacao_ativa, horario_primeira_convocacao, horario_segunda_convocacao, escopo_assembleia, descontar_inadimplentes_quorum, total_inadimplentes, inadimplentes_por_escopo, timer_duration_seconds, timer_started_at, timer_running, updated_at'
          )
          .eq('id', 1)
          .maybeSingle(),
        supabase
          .from('assembleia_unidades')
          .select(
            'id, bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora, observacao, updated_at'
          )
          .order('bloco', { ascending: true })
          .order('apartamento', { ascending: true }),
        supabase
          .from('assembleia_presencas')
          .select(
            'id, bloco, apartamento, fase, modulo, nome_completo, cpf, is_construtora, confirmado_portaria, online_conectado, com_procuracao, observacao_portaria, conectado_em, ip_address, device_id, device_name, user_agent, created_at'
          )
          .order('bloco', { ascending: true })
          .order('apartamento', { ascending: true }),
        supabase
          .from('assembleia_inadimplentes')
          .select('id, bloco, apartamento, fase, modulo, observacao, created_at')
          .order('bloco', { ascending: true })
          .order('apartamento', { ascending: true }),
        supabase
          .from('assembleia_pautas')
          .select(
            'id, ordem, titulo, descricao, escopo, status, created_at, opened_at, closed_at'
          )
          .order('ordem', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase
          .from('assembleia_votos')
          .select(
            'id, pauta_id, bloco, apartamento, voto, is_construtora, ip_address, device_id, device_name, updated_at'
          ),
        supabase
          .from('assembleia_historico')
          .select(
            'id, titulo, created_at, escopo_assembleia, convocacao_ativa, total_presentes, total_pautas, total_votos, dados_snapshot'
          )
          .order('created_at', { ascending: false }),
      ]);

      if (configRes.error) throw configRes.error;
      if (unidadesRes.error) throw unidadesRes.error;
      if (presencasRes.error) throw presencasRes.error;
      if (inadimplentesRes.error) throw inadimplentesRes.error;
      if (pautasRes.error) throw pautasRes.error;
      if (votosRes.error) throw votosRes.error;

      setConfig(normalizarConfigAdmin(configRes.data as Record<string, unknown> | null));
      setUnidadesCadastradas((unidadesRes.data ?? []) as UnidadeCadastradaAdmin[]);
      setPresencas((presencasRes.data ?? []) as PresencaAdmin[]);
      setInadimplentes((inadimplentesRes.data ?? []) as InadimplenteAdmin[]);
      setPautas((pautasRes.data ?? []) as PautaAssembleia[]);
      setVotos((votosRes.data ?? []) as VotoUnidade[]);
      if (!historicoRes.error && historicoRes.data) {
        setHistoricoAssembleias(historicoRes.data as HistoricoAssembleia[]);
      }
      setErroConexao(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao sincronizar painel da Mesa.';
      setErroConexao(msg);
    } finally {
      isFetchingRef.current = false;
      setCarregandoInicial(false);
    }
  }, [autenticado]);

  useEffect(() => {
    if (!autenticado) return;

    void recarregarTudo();

    const supabase = getSupabaseBrowserClient();
    const channelName = `assembleia-admin-${Math.random().toString(36).slice(2, 8)}`;

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_config' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const novaConfig = normalizarConfigAdmin(payload.new as Record<string, unknown>);
            setConfig((anterior) => {
              if (anterior.total_inadimplentes !== novaConfig.total_inadimplentes) {
                void recarregarInadimplentesEUnidades();
              }
              return novaConfig;
            });
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assembleia_presencas' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const registro = payload.new as PresencaAdmin;
            setPresencas((atual) => {
              const idx = atual.findIndex(
                (item) =>
                  item.id === registro.id ||
                  (item.bloco === registro.bloco && item.apartamento === registro.apartamento)
              );
              const proximo =
                idx === -1
                  ? [...atual, registro]
                  : atual.map((item, i) => (i === idx ? registro : item));
              return [...proximo].sort(
                (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
              );
            });
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<PresencaAdmin>;
            setPresencas((atual) =>
              atual.filter((item) => {
                if (oldRow?.id && item.id === oldRow.id) return false;
                if (
                  oldRow?.bloco &&
                  oldRow?.apartamento &&
                  item.bloco === Number(oldRow.bloco) &&
                  item.apartamento === Number(oldRow.apartamento)
                ) {
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
                  v.bloco === Number(oldRow.bloco) &&
                  v.apartamento === Number(oldRow.apartamento)
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
  }, [autenticado, recarregarInadimplentesEUnidades, recarregarTudo]);

  const pautaAberta = useMemo(
    () => pautas.find((p) => p.status === 'aberta') ?? null,
    [pautas]
  );

  // ---------------------------------------------------------------------------
  // 1. CONFIGURAÇÃO DE CONVOCAÇÕES, QUÓRUM E TEMPORIZADOR (CAMPO GRANDE - MS)
  // ---------------------------------------------------------------------------
  const salvarConfiguracao = useCallback(
    async (
      parcial: Partial<
        Pick<
          AssembleiaConfig,
          | 'assembleia_ativa'
          | 'convocacao_ativa'
          | 'horario_primeira_convocacao'
          | 'horario_segunda_convocacao'
          | 'escopo_assembleia'
          | 'descontar_inadimplentes_quorum'
          | 'timer_duration_seconds'
          | 'timer_started_at'
          | 'timer_running'
        >
      >
    ): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('assembleia_config')
        .update({
          ...parcial,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1)
        .select(
          'id, assembleia_ativa, convocacao_ativa, horario_primeira_convocacao, horario_segunda_convocacao, escopo_assembleia, descontar_inadimplentes_quorum, total_inadimplentes, inadimplentes_por_escopo, timer_duration_seconds, timer_started_at, timer_running, updated_at'
        )
        .single();

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      if (data) {
        setConfig(normalizarConfigAdmin(data as Record<string, unknown>));
      }

      return {
        ok: true,
        mensagem: 'Configuração salva e sincronizada! Quórum e horários atualizados.',
      };
    },
    []
  );

  const controlarTimerTelao = useCallback(
    async (
      acao: 'INICIAR' | 'PAUSAR' | 'RESETAR',
      duracaoSegundos?: number
    ): Promise<ResultadoOperacaoAdmin> => {
      const duracao = duracaoSegundos ?? config.timer_duration_seconds ?? 120;
      if (acao === 'INICIAR') {
        const res = await salvarConfiguracao({
          timer_duration_seconds: duracao,
          timer_started_at: new Date().toISOString(),
          timer_running: true,
        });
        return {
          ok: res.ok,
          mensagem: res.ok
            ? `Contador regressivo de ${Math.round(duracao / 60)} min iniciado no Telão!`
            : res.mensagem,
        };
      }

      if (acao === 'PAUSAR') {
        const res = await salvarConfiguracao({
          timer_running: false,
        });
        return {
          ok: res.ok,
          mensagem: res.ok ? 'Contador do Telão pausado.' : res.mensagem,
        };
      }

      const res = await salvarConfiguracao({
        timer_duration_seconds: duracao,
        timer_started_at: null,
        timer_running: false,
      });
      return {
        ok: res.ok,
        mensagem: res.ok ? 'Contador do Telão resetado.' : res.mensagem,
      };
    },
    [config.timer_duration_seconds, salvarConfiguracao]
  );

  // ---------------------------------------------------------------------------
  // 2. CADASTRO BASE COMPLETO DE UNIDADES, CONDÔMINOS E INADIMPLENTES
  // ---------------------------------------------------------------------------
  const salvarUnidadeBase = useCallback(
    async (dados: {
      bloco: number;
      apartamento: number;
      nome_completo: string;
      cpf: string;
      is_inadimplente: boolean;
      is_construtora: boolean;
      observacao?: string;
    }): Promise<ResultadoOperacaoAdmin> => {
      const info = obterInfoBloco(dados.bloco);
      const supabase = getSupabaseBrowserClient();

      const { error } = await supabase.from('assembleia_unidades').upsert(
        {
          bloco: dados.bloco,
          apartamento: dados.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          nome_completo: dados.is_construtora
            ? dados.nome_completo.trim() || 'CONSTRUTORA MILANO'
            : dados.nome_completo.trim(),
          cpf: dados.is_construtora ? 'CONSTRUTORA' : limparCpf(dados.cpf),
          is_inadimplente: dados.is_construtora ? false : dados.is_inadimplente,
          is_construtora: dados.is_construtora,
          observacao: dados.observacao?.trim() || null,
        },
        { onConflict: 'bloco,apartamento' }
      );

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `Bloco ${String(dados.bloco).padStart(2, '0')} • Apto ${dados.apartamento} salvo no cadastro base!`,
      };
    },
    [recarregarTudo]
  );

  const importarUnidadesBaseEmLote = useCallback(
    async (
      lista: readonly {
        bloco: number;
        apartamento: number;
        nome_completo: string;
        cpf: string;
        is_inadimplente: boolean;
        is_construtora: boolean;
        observacao?: string;
      }[]
    ): Promise<ResultadoOperacaoAdmin> => {
      if (lista.length === 0) {
        return { ok: false, mensagem: 'Nenhuma linha válida encontrada para importar.' };
      }

      const payload = lista.map((item) => {
        const info = obterInfoBloco(item.bloco);
        return {
          bloco: item.bloco,
          apartamento: item.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          nome_completo: item.is_construtora
            ? item.nome_completo.trim() || 'CONSTRUTORA MILANO'
            : item.nome_completo.trim(),
          cpf: item.is_construtora ? 'CONSTRUTORA' : limparCpf(item.cpf),
          is_inadimplente: item.is_construtora ? false : item.is_inadimplente,
          is_construtora: item.is_construtora,
          observacao: item.observacao?.trim() || null,
        };
      });

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_unidades')
        .upsert(payload, { onConflict: 'bloco,apartamento' });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${payload.length} unidade(s) importada(s)/atualizada(s) com sucesso no cadastro base!`,
      };
    },
    [recarregarTudo]
  );

  const alternarInadimplenciaUnidadeBase = useCallback(
    async (unidade: UnidadeCadastradaAdmin): Promise<ResultadoOperacaoAdmin> => {
      const novoStatus = !unidade.is_inadimplente;
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_unidades')
        .update({
          is_inadimplente: novoStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', unidade.id);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: novoStatus
          ? `Bloco ${String(unidade.bloco).padStart(2, '0')} • Apto ${unidade.apartamento} marcado como INADIMPLENTE (voto bloqueado).`
          : `Bloco ${String(unidade.bloco).padStart(2, '0')} • Apto ${unidade.apartamento} REGULARIZADO! Check-in e voto liberados.`,
      };
    },
    [recarregarTudo]
  );

  const removerUnidadeBase = useCallback(
    async (id: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from('assembleia_unidades').delete().eq('id', id);
      if (error) {
        return { ok: false, mensagem: error.message };
      }
      await recarregarTudo();
      return { ok: true, mensagem: 'Unidade removida do cadastro base.' };
    },
    [recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 3. GESTÃO DE PAUTAS
  // ---------------------------------------------------------------------------
  const criarPauta = useCallback(
    async (params: {
      titulo: string;
      descricao: string;
      escopo: EscopoVotacao;
    }): Promise<ResultadoOperacaoAdmin> => {
      const tituloLimpo = params.titulo.trim();
      if (tituloLimpo.length < 3) {
        return {
          ok: false,
          mensagem: 'Informe um título claro para a pauta (mínimo 3 caracteres).',
        };
      }

      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from('assembleia_pautas')
        .insert({
          titulo: tituloLimpo,
          descricao: params.descricao.trim() || null,
          escopo: params.escopo,
          status: 'aguardando',
        })
        .select('id, ordem, titulo, descricao, escopo, status, created_at, opened_at, closed_at')
        .single();

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      if (data) {
        const nova = data as PautaAssembleia;
        setPautas((atual) =>
          [...atual.filter((p) => p.id !== nova.id), nova].sort((a, b) => a.ordem - b.ordem)
        );
      }

      return { ok: true, mensagem: 'Nova pauta cadastrada com sucesso!' };
    },
    []
  );

  const abrirPauta = useCallback(
    async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc('assembleia_abrir_pauta', {
        p_pauta_id: pautaId,
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      if (!resposta.ok) {
        return {
          ok: false,
          mensagem: resposta.message || 'Não foi possível abrir a votação desta pauta.',
        };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: resposta.message || 'Votação aberta ao vivo no telão e celulares!',
      };
    },
    [recarregarTudo]
  );

  const encerrarPauta = useCallback(
    async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_pautas')
        .update({
          status: 'encerrada',
          closed_at: new Date().toISOString(),
        })
        .eq('id', pautaId);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: 'Votação encerrada! Todos os votos desta pauta foram congelados.',
      };
    },
    [recarregarTudo]
  );

  const resetarPauta = useCallback(
    async (pautaId: string, reabrir: boolean): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc('assembleia_resetar_pauta', {
        p_pauta_id: pautaId,
        p_reabrir: reabrir,
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();

      if (!resposta.ok) {
        return {
          ok: false,
          mensagem: resposta.message || 'Não foi possível resetar a pauta.',
        };
      }

      return {
        ok: true,
        mensagem:
          resposta.message ||
          (reabrir ? 'Votos zerados e pauta reaberta!' : 'Pauta resetada para aguardando.'),
      };
    },
    [recarregarTudo]
  );

  const excluirPauta = useCallback(
    async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from('assembleia_pautas').delete().eq('id', pautaId);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      setPautas((atual) => atual.filter((p) => p.id !== pautaId));
      setVotos((atual) => atual.filter((v) => v.pauta_id !== pautaId));
      return { ok: true, mensagem: 'Pauta excluída com sucesso.' };
    },
    []
  );

  // ---------------------------------------------------------------------------
  // 4. UNIDADES E VOTO EM LOTE DA CONSTRUTORA
  // ---------------------------------------------------------------------------
  const adicionarUnidadesConstrutora = useCallback(
    async (
      unidades: readonly { bloco: number; apartamento: number }[]
    ): Promise<ResultadoOperacaoAdmin> => {
      if (unidades.length === 0) {
        return { ok: false, mensagem: 'Selecione ao menos uma unidade disponível.' };
      }

      const registros = unidades.map((u) => {
        const info = obterInfoBloco(u.bloco);
        return {
          bloco: u.bloco,
          apartamento: u.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          nome_completo: 'CONSTRUTORA MILANO (UNIDADE NÃO ENTREGUE / NÃO VENDIDA)',
          cpf: 'CONSTRUTORA',
          is_construtora: true,
        };
      });

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_presencas')
        .upsert(registros, { onConflict: 'bloco,apartamento', ignoreDuplicates: true });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${unidades.length} unidade(s) atribuída(s) à Construtora com sucesso!`,
      };
    },
    [recarregarTudo]
  );

  const removerUnidadesConstrutora = useCallback(
    async (ids: readonly string[]): Promise<ResultadoOperacaoAdmin> => {
      if (ids.length === 0) {
        return { ok: false, mensagem: 'Nenhuma unidade da Construtora selecionada para remoção.' };
      }

      const supabase = getSupabaseBrowserClient();

      if (pautaAberta) {
        const alvos = presencas.filter((p) => ids.includes(p.id));
        for (const alvo of alvos) {
          await supabase
            .from('assembleia_votos')
            .delete()
            .eq('pauta_id', pautaAberta.id)
            .eq('bloco', alvo.bloco)
            .eq('apartamento', alvo.apartamento);
        }
      }

      const { error } = await supabase
        .from('assembleia_presencas')
        .delete()
        .in('id', [...ids])
        .eq('is_construtora', true);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${ids.length} unidade(s) da Construtora liberada(s) para check-in de moradores.`,
      };
    },
    [pautaAberta, presencas, recarregarTudo]
  );

  const votarEmLoteConstrutora = useCallback(
    async (
      pautaId: string,
      escopoPauta: EscopoVotacao,
      voto: OpcaoVoto
    ): Promise<ResultadoOperacaoAdmin> => {
      const unidadesAptasConstrutora = presencas.filter(
        (p) => p.is_construtora && unidadePertenceAoEscopo(p, escopoPauta)
      );

      if (unidadesAptasConstrutora.length === 0) {
        return {
          ok: false,
          mensagem: 'A Construtora não possui unidades cadastradas dentro do escopo desta pauta.',
        };
      }

      const payload = unidadesAptasConstrutora.map((u) => ({
        pauta_id: pautaId,
        bloco: u.bloco,
        apartamento: u.apartamento,
        voto,
        is_construtora: true,
      }));

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_votos')
        .upsert(payload, { onConflict: 'pauta_id,bloco,apartamento' });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      const rotulo = voto === 'NAO' ? 'NÃO' : voto === 'ABSTENCAO' ? 'ABSTENÇÃO' : 'SIM';
      return {
        ok: true,
        mensagem: `Voto em lote [${rotulo}] computado para ${unidadesAptasConstrutora.length} unidade(s) da Construtora!`,
      };
    },
    [presencas, recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 5. UNIDADES INADIMPLENTES (BLOQUEIO DE VOTO + TOTAL ANÔNIMO NO PÚBLICO)
  // ---------------------------------------------------------------------------
  const adicionarUnidadesInadimplentes = useCallback(
    async (
      unidades: readonly { bloco: number; apartamento: number }[],
      observacao?: string
    ): Promise<ResultadoOperacaoAdmin> => {
      if (unidades.length === 0) {
        return {
          ok: false,
          mensagem: 'Selecione ao menos uma unidade para marcar como inadimplente.',
        };
      }

      const obsLimpa = observacao?.trim() || null;
      const registros = unidades.map((u) => {
        const info = obterInfoBloco(u.bloco);
        return {
          bloco: u.bloco,
          apartamento: u.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          observacao: obsLimpa,
        };
      });

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_inadimplentes')
        .upsert(registros, { onConflict: 'bloco,apartamento' });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${unidades.length} unidade(s) bloqueada(s) por inadimplência. Apenas a contagem total agregada foi publicada no telão e celulares.`,
      };
    },
    [recarregarTudo]
  );

  const removerUnidadesInadimplentes = useCallback(
    async (ids: readonly string[]): Promise<ResultadoOperacaoAdmin> => {
      if (ids.length === 0) {
        return { ok: false, mensagem: 'Selecione ao menos uma unidade para regularizar/liberar.' };
      }

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_inadimplentes')
        .delete()
        .in('id', [...ids]);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${ids.length} unidade(s) regularizada(s) e liberada(s) para credenciamento e voto!`,
      };
    },
    [recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 6. SUPORTE DE MESA (CREDENCIAMENTO MANUAL, EDIÇÃO E LIBERAÇÃO DE UNIDADE)
  // ---------------------------------------------------------------------------
  const confirmarPresencaPortaria = useCallback(
    async (dados: {
      bloco: number;
      apartamento: number;
      com_procuracao?: boolean;
      observacao?: string;
    }): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc('assembleia_confirmar_portaria', {
        p_bloco: dados.bloco,
        p_apartamento: dados.apartamento,
        p_com_procuracao: Boolean(dados.com_procuracao),
        p_observacao: dados.observacao?.trim() || null,
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      const res = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok) {
        return {
          ok: false,
          mensagem: res.message || 'Não foi possível confirmar a entrada na portaria.',
        };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem:
          res.message ||
          `Bloco ${String(dados.bloco).padStart(2, '0')} • Apto ${dados.apartamento} confirmado na Portaria e liberado para votar!`,
      };
    },
    [recarregarTudo]
  );

  const credenciarManualMesa = useCallback(
    async (dados: {
      bloco: number;
      apartamento: number;
      nome_completo: string;
      cpf: string;
    }): Promise<ResultadoOperacaoAdmin> => {
      const info = obterInfoBloco(dados.bloco);
      const supabase = getSupabaseBrowserClient();

      // Garante também que conste no cadastro base assembleia_unidades
      await supabase.from('assembleia_unidades').upsert(
        {
          bloco: dados.bloco,
          apartamento: dados.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          nome_completo: dados.nome_completo.trim(),
          cpf: limparCpf(dados.cpf),
          is_inadimplente: false,
          is_construtora: false,
        },
        { onConflict: 'bloco,apartamento' }
      );

      const { data, error } = await supabase.rpc('assembleia_checkin_morador', {
        p_bloco: dados.bloco,
        p_apartamento: dados.apartamento,
        p_nome_completo: dados.nome_completo.trim(),
        p_cpf: limparCpf(dados.cpf),
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      const res = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok) {
        return { ok: false, mensagem: res.message || 'Falha ao credenciar unidade.' };
      }

      await recarregarTudo();
      return { ok: true, mensagem: res.message || 'Unidade credenciada manualmente pela Mesa!' };
    },
    [recarregarTudo]
  );

  const atualizarPresencaMesa = useCallback(
    async (
      id: string,
      dados: {
        nome_completo: string;
        cpf: string;
        bloco: number;
        apartamento: number;
      }
    ): Promise<ResultadoOperacaoAdmin> => {
      const info = obterInfoBloco(dados.bloco);
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from('assembleia_presencas')
        .update({
          nome_completo: dados.nome_completo.trim(),
          cpf: limparCpf(dados.cpf),
          bloco: dados.bloco,
          apartamento: dados.apartamento,
          fase: info.fase,
          modulo: info.modulo,
        })
        .eq('id', id);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return { ok: true, mensagem: 'Cadastro do representante atualizado com sucesso!' };
    },
    [recarregarTudo]
  );

  const removerPresencaMesa = useCallback(
    async (
      presenca: Pick<PresencaAdmin, 'id' | 'bloco' | 'apartamento'>
    ): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();

      if (pautaAberta) {
        await supabase
          .from('assembleia_votos')
          .delete()
          .eq('pauta_id', pautaAberta.id)
          .eq('bloco', presenca.bloco)
          .eq('apartamento', presenca.apartamento);
      }

      const { error } = await supabase
        .from('assembleia_presencas')
        .delete()
        .eq('id', presenca.id);

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `Bloco ${String(presenca.bloco).padStart(2, '0')} • Apto ${presenca.apartamento} liberado!`,
      };
    },
    [pautaAberta, recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 7. SALVAR / ARQUIVAR ASSEMBLEIA E RESETAR PARA NOVA ASSEMBLEIA
  // ---------------------------------------------------------------------------
  const salvarAssembleiaNoHistorico = useCallback(
    async (titulo: string): Promise<ResultadoOperacaoAdmin> => {
      const tituloLimpo = titulo.trim() || 'Assembleia Geral Milano';
      const supabase = getSupabaseBrowserClient();

      const snapshot = {
        config,
        presencas,
        pautas,
        votos,
      };

      const { error } = await supabase.from('assembleia_historico').insert({
        titulo: tituloLimpo,
        escopo_assembleia: config.escopo_assembleia,
        convocacao_ativa: config.convocacao_ativa,
        total_presentes: presencas.length,
        total_pautas: pautas.length,
        total_votos: votos.length,
        dados_snapshot: snapshot,
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      exportarPacoteCompletoAssembleiaCsv({
        tituloAssembleia: tituloLimpo,
        config,
        presencas,
        pautas,
        votos,
      });

      await recarregarTudo();
      return {
        ok: true,
        mensagem: `Assembleia "${tituloLimpo}" salva no histórico do banco e relatório CSV completo baixado!`,
      };
    },
    [config, pautas, presencas, recarregarTudo, votos]
  );

  const resetarAssembleiaParaNova = useCallback(
    async (manterCadastroBase: boolean): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc('assembleia_resetar_geral', {
        p_manter_cadastro_base: manterCadastroBase,
      });

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();
      return {
        ok: Boolean(resposta.ok),
        mensagem:
          resposta.message ||
          'Assembleia resetada com sucesso! Sistema pronto para iniciar uma nova assembleia.',
      };
    },
    [recarregarTudo]
  );

  const excluirAssembleiaDoHistorico = useCallback(
    async (id: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from('assembleia_historico').delete().eq('id', id);
      if (error) {
        return { ok: false, mensagem: error.message };
      }
      setHistoricoAssembleias((atual) => atual.filter((item) => item.id !== id));
      return { ok: true, mensagem: 'Registro removido do histórico de assembleias.' };
    },
    []
  );

  return {
    config,
    unidadesCadastradas,
    presencas,
    inadimplentes,
    pautas,
    votos,
    historicoAssembleias,
    pautaAberta,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    salvarConfiguracao,
    controlarTimerTelao,
    salvarUnidadeBase,
    importarUnidadesBaseEmLote,
    alternarInadimplenciaUnidadeBase,
    removerUnidadeBase,
    criarPauta,
    abrirPauta,
    encerrarPauta,
    resetarPauta,
    excluirPauta,
    adicionarUnidadesConstrutora,
    removerUnidadesConstrutora,
    votarEmLoteConstrutora,
    adicionarUnidadesInadimplentes,
    removerUnidadesInadimplentes,
    confirmarPresencaPortaria,
    credenciarManualMesa,
    atualizarPresencaMesa,
    removerPresencaMesa,
    salvarAssembleiaNoHistorico,
    resetarAssembleiaParaNova,
    excluirAssembleiaDoHistorico,
  };
}
