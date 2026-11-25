'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { obterInfoBloco, unidadePertenceAoEscopo } from '@/lib/condominio';
import { exportarPacoteCompletoAssembleiaCsv } from '@/lib/csv';
import { getSupabaseAuthClient, getSupabasePublicClient } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AppRole,
  AssembleiaConfig,
  AssembleiaRegistro,
  AuditoriaVotoItem,
  ConexaoRealtimeStatus,
  EscopoVotacao,
  HistoricoAssembleia,
  InadimplenteAdmin,
  MapaInadimplentesPorEscopo,
  OpcaoPauta,
  OpcaoVoto,
  OperacaoAssembleiaItem,
  PautaAssembleia,
  PresencaAdmin,
  TipoVotacaoPauta,
  UnidadeCadastradaAdmin,
  VotoUnidade,
} from '@/lib/types';
import { limparCpf } from '@/lib/validators';
import { DEFAULT_ASSEMBLEIA_CONFIG } from './useAssembleiaPublicRealtime';

function assembleiaParaConfig(asm: AssembleiaRegistro | null): AssembleiaConfig {
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

const PAGE_SIZE_PGRST = 1000;

/**
 * Busca TODOS os votos de uma assembleia paginando em blocos de 1.000 linhas,
 * eliminando o risco de truncamento silencioso por PGRST_DB_MAX_ROWS=1000
 * (ex.: 544 unidades x 12 pautas = 6.528 votos).
 */
async function buscarTodosVotosPaginados(
  supabase: SupabaseClient,
  assembleiaId: string
): Promise<{ data: VotoUnidade[]; error: Error | null }> {
  const acumulado: VotoUnidade[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('assembleia_votos')
      .select(
        'id, assembleia_id, pauta_id, rodada, bloco, apartamento, voto, escolhas_json, is_construtora, idempotency_key, ip_address, device_id, device_name, updated_at'
      )
      .eq('assembleia_id', assembleiaId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE_PGRST - 1);

    if (error) {
      return { data: [], error: new Error(error.message) };
    }

    const lote = (data ?? []) as VotoUnidade[];
    acumulado.push(...lote);

    if (lote.length < PAGE_SIZE_PGRST) {
      break;
    }
    offset += PAGE_SIZE_PGRST;
    // Guarda de segurança (50.000 votos em uma única assembleia)
    if (offset >= 50_000) break;
  }

  return { data: acumulado, error: null };
}

export interface ResultadoOperacaoAdmin {
  ok: boolean;
  mensagem: string;
}

export function useAssembleiaAdminRealtime(
  autenticado: boolean,
  role: AppRole = 'admin'
) {
  const [assembleias, setAssembleias] = useState<AssembleiaRegistro[]>([]);
  const [assembleiaSelecionadaId, setAssembleiaSelecionadaId] = useState<string | null>(null);
  const [config, setConfig] = useState<AssembleiaConfig>(DEFAULT_ASSEMBLEIA_CONFIG);
  const [unidadesCadastradas, setUnidadesCadastradas] = useState<UnidadeCadastradaAdmin[]>([]);
  const [presencas, setPresencas] = useState<PresencaAdmin[]>([]);
  const [inadimplentes, setInadimplentes] = useState<InadimplenteAdmin[]>([]);
  const [pautas, setPautas] = useState<PautaAssembleia[]>([]);
  const [votos, setVotos] = useState<VotoUnidade[]>([]);
  const [historicoAssembleias, setHistoricoAssembleias] = useState<HistoricoAssembleia[]>([]);
  const [operacoesAuditoria, setOperacoesAuditoria] = useState<OperacaoAssembleiaItem[]>([]);
  const [votosAuditoria, setVotosAuditoria] = useState<AuditoriaVotoItem[]>([]);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroConexao, setErroConexao] = useState<string | null>(null);
  const [statusConexao, setStatusConexao] = useState<ConexaoRealtimeStatus>('CONECTANDO');
  const [realtimeAtivo, setRealtimeAtivo] = useState(false);

  const isFetchingRef = useRef(false);
  const lastFetchAtRef = useRef(0);
  const baseUnidadesCarregadaRef = useRef(false);
  const pendingBroadcastTimerRef = useRef<number | null>(null);
  const isAdmin = role === 'admin';

  const recarregarTudo = useCallback(
    async (opcoes?: { forcar?: boolean; recarregarUnidades?: boolean }) => {
      if (!autenticado) return;
      const forcar = opcoes?.forcar ?? true;
      const recarregarUnidades =
        opcoes?.recarregarUnidades ?? !baseUnidadesCarregadaRef.current;

      const agora = Date.now();
      if (isFetchingRef.current) return;
      if (!forcar && agora - lastFetchAtRef.current < 1500) return;

      isFetchingRef.current = true;
      lastFetchAtRef.current = agora;

      try {
        const supabase = getSupabaseAuthClient();

        // 1. Busca lista de assembleias (para suportar ativa + históricas como 19/11/2026)
        const { data: asmList, error: errAsm } = await supabase
          .from('assembleias')
          .select('*')
          .order('data_assembleia', { ascending: false })
          .order('created_at', { ascending: false });

        if (errAsm) throw errAsm;

        const listaAsm = (asmList ?? []) as AssembleiaRegistro[];
        setAssembleias(listaAsm);

        const asmAtiva = listaAsm.find((a) => a.status === 'ativa') ?? null;
        const asmFoco =
          (assembleiaSelecionadaId
            ? listaAsm.find((a) => a.id === assembleiaSelecionadaId)
            : null) ??
          asmAtiva ??
          listaAsm[0] ??
          null;

        if (asmFoco && asmFoco.id !== assembleiaSelecionadaId) {
          setAssembleiaSelecionadaId(asmFoco.id);
        }

        setConfig(assembleiaParaConfig(asmFoco));

        const asmId = asmFoco?.id ?? null;

        // 2. Carregamento respeitando menor privilégio por perfil (carrega base de 544 unidades 1x ou sob demanda)
        const [unidadesRes, presencasRes, inadRes] = await Promise.all([
          recarregarUnidades
            ? supabase
                .from('assembleia_unidades')
                .select(
                  'id, bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora, observacao, updated_at'
                )
                .order('bloco', { ascending: true })
                .order('apartamento', { ascending: true })
            : Promise.resolve({ data: null, error: null }),
          asmId
            ? supabase
                .from('assembleia_presencas')
                .select(
                  'id, assembleia_id, bloco, apartamento, fase, modulo, nome_completo, cpf, cpf_procurador, is_construtora, confirmado_portaria, online_conectado, com_procuracao, observacao_portaria, conectado_em, ip_address, device_id, device_name, user_agent, created_at'
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
        ]);

        if (unidadesRes.error) throw unidadesRes.error;
        if (presencasRes.error) throw presencasRes.error;
        if (inadRes.error) throw inadRes.error;

        if (unidadesRes.data) {
          setUnidadesCadastradas(unidadesRes.data as UnidadeCadastradaAdmin[]);
          baseUnidadesCarregadaRef.current = true;
        }
        setPresencas((presencasRes.data ?? []) as PresencaAdmin[]);
        setInadimplentes((inadRes.data ?? []) as InadimplenteAdmin[]);

        if (isAdmin) {
          const [pautasRes, votosRes, historicoRes, opsRes, audVotosRes] = await Promise.all([
            asmId
              ? supabase
                  .from('assembleia_pautas')
                  .select(
                    'id, assembleia_id, ordem, titulo, descricao, escopo, tipo_votacao, opcoes_json, max_escolhas, status, rodada, version, motivo_ultima_rodada, created_at, opened_at, closed_at'
                  )
                  .eq('assembleia_id', asmId)
                  .order('ordem', { ascending: true })
                  .order('created_at', { ascending: true })
              : Promise.resolve({ data: [], error: null }),
            asmId
              ? buscarTodosVotosPaginados(supabase, asmId)
              : Promise.resolve({ data: [], error: null }),
            supabase
              .from('assembleia_historico')
              .select(
                'id, assembleia_id, titulo, tipo_snapshot, sha256_hash, created_at, escopo_assembleia, convocacao_ativa, total_presentes, total_pautas, total_votos, dados_snapshot'
              )
              .order('created_at', { ascending: false })
              .limit(40),
            asmId
              ? supabase
                  .from('assembleia_operacoes')
                  .select(
                    'id, assembleia_id, pauta_id, operacao, actor_email, actor_role, actor_sub, justificativa, detalhes, recorded_at'
                  )
                  .eq('assembleia_id', asmId)
                  .order('recorded_at', { ascending: false })
                  .limit(150)
              : Promise.resolve({ data: [], error: null }),
            asmId
              ? supabase
                  .from('assembleia_votos_auditoria')
                  .select(
                    'id, assembleia_id, pauta_id, rodada, bloco, apartamento, acao, voto_anterior, voto_novo, is_construtora, idempotency_key, actor_role, actor_sub, ip_address, device_id, device_name, recorded_at'
                  )
                  .eq('assembleia_id', asmId)
                  .order('recorded_at', { ascending: false })
                  .limit(200)
              : Promise.resolve({ data: [], error: null }),
          ]);

          if (pautasRes.error) throw pautasRes.error;
          if (votosRes.error) throw votosRes.error;

          setPautas((pautasRes.data ?? []) as PautaAssembleia[]);
          setVotos((votosRes.data ?? []) as VotoUnidade[]);
          if (!historicoRes.error && historicoRes.data) {
            setHistoricoAssembleias(historicoRes.data as HistoricoAssembleia[]);
          }
          if (!opsRes.error && opsRes.data) {
            setOperacoesAuditoria(opsRes.data as OperacaoAssembleiaItem[]);
          }
          if (!audVotosRes.error && audVotosRes.data) {
            setVotosAuditoria(audVotosRes.data as AuditoriaVotoItem[]);
          }
        }

        setErroConexao(null);
        setStatusConexao('AO_VIVO');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha ao sincronizar painel autenticado.';
        setErroConexao(msg);
        setStatusConexao('RECONECTANDO');
      } finally {
        isFetchingRef.current = false;
        setCarregandoInicial(false);
      }
    },
    [assembleiaSelecionadaId, autenticado, isAdmin]
  );

  // Assinatura ao canal Broadcast placar para atualizar /admin rapidamente sob novos votos/presenças
  useEffect(() => {
    if (!autenticado || !assembleiaSelecionadaId) return;

    const supabasePublic = getSupabasePublicClient();
    const canal = supabasePublic
      .channel(`assembleia:${assembleiaSelecionadaId}:placar`, {
        config: { broadcast: { self: false }, private: true },
      })
      .on('broadcast', { event: 'placar_update' }, () => {
        if (pendingBroadcastTimerRef.current !== null) return;
        const debounceMs = 650 + Math.floor(Math.random() * 450);
        pendingBroadcastTimerRef.current = window.setTimeout(() => {
          pendingBroadcastTimerRef.current = null;
          if (document.visibilityState === 'visible') {
            void recarregarTudo({ forcar: false, recarregarUnidades: false });
          }
        }, debounceMs);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeAtivo(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeAtivo(false);
        }
      });

    return () => {
      setRealtimeAtivo(false);
      if (pendingBroadcastTimerRef.current !== null) {
        window.clearTimeout(pendingBroadcastTimerRef.current);
        pendingBroadcastTimerRef.current = null;
      }
      void supabasePublic.removeChannel(canal);
    };
  }, [assembleiaSelecionadaId, autenticado, recarregarTudo]);

  useEffect(() => {
    if (!autenticado) return;
    void recarregarTudo({ forcar: true, recarregarUnidades: !baseUnidadesCarregadaRef.current });

    let timeoutId: number | null = null;
    let ativo = true;

    const agendarProximo = () => {
      if (!ativo) return;
      const baseMs = realtimeAtivo ? 14000 : 5000;
      const jitterMs = Math.floor(Math.random() * (realtimeAtivo ? 4000 : 2000));
      timeoutId = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void recarregarTudo({ forcar: false, recarregarUnidades: false }).finally(agendarProximo);
        } else {
          agendarProximo();
        }
      }, baseMs + jitterMs);
    };

    agendarProximo();

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        const jitter = 200 + Math.floor(Math.random() * 900);
        window.setTimeout(() => {
          void recarregarTudo({ forcar: false, recarregarUnidades: false });
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
  }, [autenticado, realtimeAtivo, recarregarTudo]);

  const assembleiaAtual = useMemo(
    () => assembleias.find((a) => a.id === assembleiaSelecionadaId) ?? assembleias[0] ?? null,
    [assembleiaSelecionadaId, assembleias]
  );

  const pautaAberta = useMemo(
    () => pautas.find((p) => p.status === 'aberta') ?? null,
    [pautas]
  );

  // ---------------------------------------------------------------------------
  // 1. GESTÃO DE ASSEMBLEIAS, CONVOCAÇÕES, QUÓRUM E TIMER
  // ---------------------------------------------------------------------------
  const criarNovaAssembleia = useCallback(
    async (params: {
      titulo: string;
      escopo?: EscopoVotacao;
      horario1?: string;
      horario2?: string;
      ativar?: boolean;
    }): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_criar_nova', {
        p_titulo: params.titulo,
        p_escopo: params.escopo || 'TODOS',
        p_horario_1: params.horario1 || '19:00',
        p_horario_2: params.horario2 || '19:30',
        p_ativar: params.ativar ?? true,
      });

      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as {
        ok?: boolean;
        message?: string;
        assembleia?: AssembleiaRegistro;
      };
      if (!res.ok) return { ok: false, mensagem: res.message || 'Erro ao criar assembleia.' };

      if (res.assembleia?.id) {
        setAssembleiaSelecionadaId(res.assembleia.id);
      }
      await recarregarTudo();
      return { ok: true, mensagem: res.message || 'Nova assembleia criada e ativada!' };
    },
    [recarregarTudo]
  );

  const salvarConfiguracao = useCallback(
    async (
      parcial: Partial<
        Pick<
          AssembleiaConfig,
          | 'assembleia_ativa'
          | 'exigir_confirmacao_portaria'
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
      const supabase = getSupabaseAuthClient();

      // Se a assembleia em foco estiver encerrada (ex: 19/11/2026) e o admin clicar em ativar/liberar,
      // cria uma nova assembleia limpa preservando 100% do histórico de 19/11!
      if (assembleiaAtual && assembleiaAtual.status === 'encerrada' && parcial.assembleia_ativa) {
        return criarNovaAssembleia({
          titulo: `Assembleia Geral — ${new Date().toLocaleDateString('pt-BR')}`,
          escopo: parcial.escopo_assembleia || config.escopo_assembleia,
          horario1: parcial.horario_primeira_convocacao || config.horario_primeira_convocacao,
          horario2: parcial.horario_segunda_convocacao || config.horario_segunda_convocacao,
          ativar: true,
        });
      }

      if (!assembleiaAtual) {
        return { ok: false, mensagem: 'Nenhuma assembleia selecionada.' };
      }

      const updatePayload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (typeof parcial.assembleia_ativa === 'boolean') {
        updatePayload.status = parcial.assembleia_ativa ? 'ativa' : 'encerrada';
        if (!parcial.assembleia_ativa) {
          updatePayload.closed_at = new Date().toISOString();
        }
      }
      if (parcial.convocacao_ativa !== undefined) {
        updatePayload.convocacao_ativa = parcial.convocacao_ativa;
        if (parcial.convocacao_ativa === 'ENCERRADA') {
          updatePayload.status = 'encerrada';
          updatePayload.closed_at = new Date().toISOString();
        }
      }
      if (parcial.horario_primeira_convocacao !== undefined) {
        updatePayload.horario_primeira_convocacao = parcial.horario_primeira_convocacao;
      }
      if (parcial.horario_segunda_convocacao !== undefined) {
        updatePayload.horario_segunda_convocacao = parcial.horario_segunda_convocacao;
      }
      if (parcial.escopo_assembleia !== undefined) {
        updatePayload.escopo_assembleia = parcial.escopo_assembleia;
      }
      if (typeof parcial.descontar_inadimplentes_quorum === 'boolean') {
        updatePayload.descontar_inadimplentes_quorum = parcial.descontar_inadimplentes_quorum;
      }
      if (typeof parcial.exigir_confirmacao_portaria === 'boolean') {
        updatePayload.exigir_confirmacao_portaria = parcial.exigir_confirmacao_portaria;
      }
      if (parcial.timer_duration_seconds !== undefined) {
        updatePayload.timer_duration_seconds = parcial.timer_duration_seconds;
      }
      if (parcial.timer_started_at !== undefined) {
        updatePayload.timer_started_at = parcial.timer_started_at;
      }
      if (typeof parcial.timer_running === 'boolean') {
        updatePayload.timer_running = parcial.timer_running;
      }

      const { data, error } = await supabase
        .from('assembleias')
        .update(updatePayload)
        .eq('id', assembleiaAtual.id)
        .eq('version', assembleiaAtual.version)
        .select('*')
        .maybeSingle();

      if (error) {
        return { ok: false, mensagem: error.message };
      }

      if (!data) {
        await recarregarTudo();
        return {
          ok: false,
          mensagem:
            'Outro administrador atualizou a assembleia neste instante (conflito de versão). A tela foi sincronizada — tente novamente.',
        };
      }

      const atualizada = data as AssembleiaRegistro;
      setConfig(assembleiaParaConfig(atualizada));
      setAssembleias((prev) => prev.map((a) => (a.id === atualizada.id ? atualizada : a)));

      return {
        ok: true,
        mensagem: 'Configuração salva e sincronizada com sucesso!',
      };
    },
    [
      assembleiaAtual,
      config.escopo_assembleia,
      config.horario_primeira_convocacao,
      config.horario_segunda_convocacao,
      criarNovaAssembleia,
      recarregarTudo,
    ]
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
        const res = await salvarConfiguracao({ timer_running: false });
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
  // 2. CADASTRO BASE COMPLETO DE UNIDADES (GLOBAL)
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
      const supabase = getSupabaseAuthClient();

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

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo({ forcar: true, recarregarUnidades: true });
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

      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_unidades')
        .upsert(payload, { onConflict: 'bloco,apartamento' });

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo({ forcar: true, recarregarUnidades: true });
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
      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_unidades')
        .update({
          is_inadimplente: novoStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', unidade.id);

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo({ forcar: true, recarregarUnidades: true });
      return {
        ok: true,
        mensagem: novoStatus
          ? `Bloco ${String(unidade.bloco).padStart(2, '0')} • Apto ${unidade.apartamento} marcado como INADIMPLENTE.`
          : `Bloco ${String(unidade.bloco).padStart(2, '0')} • Apto ${unidade.apartamento} REGULARIZADO!`,
      };
    },
    [recarregarTudo]
  );

  const removerUnidadeBase = useCallback(
    async (id: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { error } = await supabase.from('assembleia_unidades').delete().eq('id', id);
      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo({ forcar: true, recarregarUnidades: true });
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
      tipo_votacao?: TipoVotacaoPauta;
      opcoes?: string[];
      max_escolhas?: number;
    }): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual || assembleiaAtual.status === 'encerrada') {
        return {
          ok: false,
          mensagem: 'Crie ou ative uma assembleia antes de cadastrar novas pautas.',
        };
      }
      const tituloLimpo = params.titulo.trim();
      if (tituloLimpo.length < 3) {
        return { ok: false, mensagem: 'Informe um título claro (mínimo 3 caracteres).' };
      }

      const tipoVotacao: TipoVotacaoPauta = params.tipo_votacao ?? 'SIM_NAO';
      let opcoesJson: OpcaoPauta[] = [];
      let maxEscolhas = 1;

      if (tipoVotacao !== 'SIM_NAO') {
        const limpas = (params.opcoes ?? [])
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (limpas.length < 2) {
          return {
            ok: false,
            mensagem: 'Informe pelo menos 2 opções para pautas de múltipla escolha.',
          };
        }
        if (limpas.length > 10) {
          return {
            ok: false,
            mensagem: 'O limite máximo é de 10 opções por pauta.',
          };
        }
        opcoesJson = limpas.map((label, idx) => ({
          id: `OPT_${idx + 1}`,
          sigla: String.fromCharCode(65 + idx),
          label,
        }));
        maxEscolhas =
          tipoVotacao === 'MULTIPLA_UNICA'
            ? 1
            : Math.min(Math.max(Number(params.max_escolhas ?? limpas.length), 2), limpas.length);
      }

      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase
        .from('assembleia_pautas')
        .insert({
          assembleia_id: assembleiaAtual.id,
          titulo: tituloLimpo,
          descricao: params.descricao.trim() || null,
          escopo: params.escopo,
          tipo_votacao: tipoVotacao,
          opcoes_json: opcoesJson,
          max_escolhas: maxEscolhas,
          status: 'aguardando',
        })
        .select(
          'id, assembleia_id, ordem, titulo, descricao, escopo, tipo_votacao, opcoes_json, max_escolhas, status, rodada, version, motivo_ultima_rodada, created_at, opened_at, closed_at'
        )
        .single();

      if (error) return { ok: false, mensagem: error.message };

      if (data) {
        const nova = data as PautaAssembleia;
        setPautas((atual) =>
          [...atual.filter((p) => p.id !== nova.id), nova].sort((a, b) => a.ordem - b.ordem)
        );
      }
      return { ok: true, mensagem: 'Nova pauta cadastrada com sucesso!' };
    },
    [assembleiaAtual]
  );

  const abrirPauta = useCallback(
    async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
      const pautaAlvo = pautas.find((p) => p.id === pautaId);
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_abrir_pauta', {
        p_pauta_id: pautaId,
        p_expected_version: pautaAlvo?.version ?? null,
      });
      if (error) return { ok: false, mensagem: error.message };
      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();
      if (!resposta.ok) {
        return { ok: false, mensagem: resposta.message || 'Não foi possível abrir a pauta.' };
      }
      return { ok: true, mensagem: resposta.message || 'Votação aberta ao vivo!' };
    },
    [pautas, recarregarTudo]
  );

  const encerrarPauta = useCallback(
    async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
      const pautaAlvo = pautas.find((p) => p.id === pautaId);
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_encerrar_pauta', {
        p_pauta_id: pautaId,
        p_expected_version: pautaAlvo?.version ?? null,
      });
      if (error) return { ok: false, mensagem: error.message };
      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();
      if (!resposta.ok) {
        return { ok: false, mensagem: resposta.message || 'Não foi possível encerrar a pauta.' };
      }
      return {
        ok: true,
        mensagem: resposta.message || 'Votação encerrada! Votos congelados e snapshot gravado.',
      };
    },
    [pautas, recarregarTudo]
  );

  const resetarPauta = useCallback(
    async (
      pautaId: string,
      reabrir: boolean,
      justificativa: string
    ): Promise<ResultadoOperacaoAdmin> => {
      const justLimpa = justificativa.trim();
      if (justLimpa.length < 10) {
        return {
          ok: false,
          mensagem:
            'Informe uma justificativa formal com pelo menos 10 caracteres para iniciar uma nova rodada.',
        };
      }
      const pautaAlvo = pautas.find((p) => p.id === pautaId);
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_resetar_pauta', {
        p_pauta_id: pautaId,
        p_reabrir: reabrir,
        p_justificativa: justLimpa,
        p_expected_version: pautaAlvo?.version ?? null,
      });
      if (error) return { ok: false, mensagem: error.message };
      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();
      if (!resposta.ok) {
        return {
          ok: false,
          mensagem: resposta.message || 'Não foi possível iniciar nova rodada da pauta.',
        };
      }
      return {
        ok: true,
        mensagem:
          resposta.message ||
          (reabrir
            ? 'Nova rodada aberta ao vivo (votos anteriores preservados)!'
            : 'Nova rodada preparada (votos anteriores preservados).'),
      };
    },
    [pautas, recarregarTudo]
  );

  const excluirPauta = useCallback(async (pautaId: string): Promise<ResultadoOperacaoAdmin> => {
    const supabase = getSupabaseAuthClient();
    const { error } = await supabase.from('assembleia_pautas').delete().eq('id', pautaId);
    if (error) return { ok: false, mensagem: error.message };
    setPautas((atual) => atual.filter((p) => p.id !== pautaId));
    setVotos((atual) => atual.filter((v) => v.pauta_id !== pautaId));
    return { ok: true, mensagem: 'Pauta excluída com sucesso.' };
  }, []);

  // ---------------------------------------------------------------------------
  // 4. CONSTRUTORA & INADIMPLENTES
  // ---------------------------------------------------------------------------
  const adicionarUnidadesConstrutora = useCallback(
    async (
      unidades: readonly { bloco: number; apartamento: number }[]
    ): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual || assembleiaAtual.status === 'encerrada') {
        return { ok: false, mensagem: 'Ative uma assembleia antes de registrar a Construtora.' };
      }
      if (unidades.length === 0) {
        return { ok: false, mensagem: 'Selecione ao menos uma unidade disponível.' };
      }

      const registros = unidades.map((u) => {
        const info = obterInfoBloco(u.bloco);
        return {
          assembleia_id: assembleiaAtual.id,
          bloco: u.bloco,
          apartamento: u.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          nome_completo: 'CONSTRUTORA MILANO (UNIDADE NÃO ENTREGUE / NÃO VENDIDA)',
          cpf: 'CONSTRUTORA',
          is_construtora: true,
          confirmado_portaria: true,
          online_conectado: true,
        };
      });

      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_presencas')
        .upsert(registros, {
          onConflict: 'assembleia_id,bloco,apartamento',
          ignoreDuplicates: true,
        });

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${unidades.length} unidade(s) atribuída(s) à Construtora!`,
      };
    },
    [assembleiaAtual, recarregarTudo]
  );

  const removerUnidadesConstrutora = useCallback(
    async (ids: readonly string[]): Promise<ResultadoOperacaoAdmin> => {
      if (ids.length === 0) {
        return { ok: false, mensagem: 'Nenhuma unidade selecionada.' };
      }

      const supabase = getSupabaseAuthClient();
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

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return { ok: true, mensagem: `${ids.length} unidade(s) da Construtora liberada(s).` };
    },
    [pautaAberta, presencas, recarregarTudo]
  );

  const votarEmLoteConstrutora = useCallback(
    async (
      pautaId: string,
      escopoPauta: EscopoVotacao,
      voto: OpcaoVoto,
      escolhas?: string[]
    ): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual) {
        return { ok: false, mensagem: 'Nenhuma assembleia selecionada.' };
      }
      const unidadesAptasConstrutora = presencas.filter(
        (p) => p.is_construtora && unidadePertenceAoEscopo(p, escopoPauta)
      );
      if (unidadesAptasConstrutora.length === 0) {
        return { ok: false, mensagem: 'Nenhuma unidade da Construtora apta neste escopo.' };
      }

      const pautaAlvo = pautas.find((p) => p.id === pautaId);
      const rodadaAlvo = pautaAlvo?.rodada ?? 1;
      const isMultipla = voto === 'MULTIPLA' || (Array.isArray(escolhas) && escolhas.length > 0);
      if (isMultipla && (!escolhas || escolhas.length === 0)) {
        return { ok: false, mensagem: 'Selecione ao menos uma opção para votar em lote.' };
      }

      const payload = unidadesAptasConstrutora.map((u) => ({
        assembleia_id: assembleiaAtual.id,
        pauta_id: pautaId,
        rodada: rodadaAlvo,
        bloco: u.bloco,
        apartamento: u.apartamento,
        voto: isMultipla ? ('MULTIPLA' as OpcaoVoto) : voto,
        escolhas_json: isMultipla ? escolhas : [voto],
        is_construtora: true,
      }));

      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_votos')
        .upsert(payload, { onConflict: 'pauta_id,rodada,bloco,apartamento' });

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return {
        ok: true,
        mensagem: `Voto em lote registrado na Rodada ${rodadaAlvo} para ${payload.length} unidade(s) da Construtora!`,
      };
    },
    [assembleiaAtual, pautas, presencas, recarregarTudo]
  );

  const adicionarUnidadesInadimplentes = useCallback(
    async (
      unidades: readonly { bloco: number; apartamento: number }[],
      observacao?: string
    ): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual) {
        return { ok: false, mensagem: 'Nenhuma assembleia selecionada.' };
      }
      if (unidades.length === 0) {
        return { ok: false, mensagem: 'Selecione ao menos uma unidade.' };
      }

      const registros = unidades.map((u) => {
        const info = obterInfoBloco(u.bloco);
        return {
          assembleia_id: assembleiaAtual.id,
          bloco: u.bloco,
          apartamento: u.apartamento,
          fase: info.fase,
          modulo: info.modulo,
          observacao: observacao?.trim() || null,
        };
      });

      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_inadimplentes')
        .upsert(registros, { onConflict: 'assembleia_id,bloco,apartamento' });

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return {
        ok: true,
        mensagem: `${unidades.length} unidade(s) bloqueada(s) por inadimplência.`,
      };
    },
    [assembleiaAtual, recarregarTudo]
  );

  const removerUnidadesInadimplentes = useCallback(
    async (ids: readonly string[]): Promise<ResultadoOperacaoAdmin> => {
      if (ids.length === 0) {
        return { ok: false, mensagem: 'Selecione ao menos uma unidade.' };
      }

      const supabase = getSupabaseAuthClient();
      const { error } = await supabase
        .from('assembleia_inadimplentes')
        .delete()
        .in('id', [...ids]);

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return { ok: true, mensagem: `${ids.length} unidade(s) regularizada(s) e liberada(s)!` };
    },
    [recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 5. PORTARIA & SUPORTE DE MESA
  // ---------------------------------------------------------------------------
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
        p_assembleia_id: assembleiaAtual?.id ?? null,
      });

      if (error) return { ok: false, mensagem: error.message };
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
          `Bloco ${String(dados.bloco).padStart(2, '0')} • Apto ${dados.apartamento} confirmado na Portaria!`,
      };
    },
    [assembleiaAtual?.id, recarregarTudo]
  );

  const credenciarManualMesa = useCallback(
    async (dados: {
      bloco: number;
      apartamento: number;
      nome_completo: string;
      cpf: string;
    }): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_checkin_morador', {
        p_bloco: dados.bloco,
        p_apartamento: dados.apartamento,
        p_nome_completo: dados.nome_completo.trim(),
        p_cpf: limparCpf(dados.cpf),
      });
      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok) return { ok: false, mensagem: res.message || 'Falha ao credenciar.' };
      await recarregarTudo();
      return { ok: true, mensagem: res.message || 'Unidade credenciada manualmente!' };
    },
    [recarregarTudo]
  );

  const atualizarPresencaMesa = useCallback(
    async (
      id: string,
      dados: { nome_completo: string; cpf: string; bloco: number; apartamento: number }
    ): Promise<ResultadoOperacaoAdmin> => {
      const info = obterInfoBloco(dados.bloco);
      const supabase = getSupabaseAuthClient();
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

      if (error) return { ok: false, mensagem: error.message };
      await recarregarTudo();
      return { ok: true, mensagem: 'Cadastro atualizado com sucesso!' };
    },
    [recarregarTudo]
  );

  const removerPresencaMesa = useCallback(
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

      await recarregarTudo();
      return {
        ok: true,
        mensagem:
          res.message ||
          `Bloco ${String(presenca.bloco).padStart(2, '0')} • Apto ${presenca.apartamento} liberado!`,
      };
    },
    [recarregarTudo]
  );

  // ---------------------------------------------------------------------------
  // 6. HISTÓRICO SHA-256, ARQUIVAMENTO ATÔMICO & RESET SEGURO DA ASSEMBLEIA ATIVA
  // ---------------------------------------------------------------------------
  const salvarAssembleiaNoHistorico = useCallback(
    async (titulo: string): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual) {
        return { ok: false, mensagem: 'Nenhuma assembleia selecionada.' };
      }
      const tituloLimpo = titulo.trim() || assembleiaAtual.titulo || 'Assembleia Geral Milano';
      const supabase = getSupabaseAuthClient();

      const { data, error } = await supabase.rpc('assembleia_gerar_snapshot', {
        p_assembleia_id: assembleiaAtual.id,
        p_tipo_snapshot: 'manual',
        p_titulo: tituloLimpo,
      });

      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as { ok?: boolean; message?: string; sha256_hash?: string };
      if (!res.ok) {
        return { ok: false, mensagem: res.message || 'Falha ao salvar snapshot no banco.' };
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
        mensagem: `Snapshot "${tituloLimpo}" salvo com SHA-256 (${(res.sha256_hash || '').slice(0, 12)}...) e CSV baixado!`,
      };
    },
    [assembleiaAtual, config, pautas, presencas, recarregarTudo, votos]
  );

  const encerrarEArquivarAssembleia = useCallback(
    async (justificativa: string, tituloArquivo?: string): Promise<ResultadoOperacaoAdmin> => {
      if (!assembleiaAtual) {
        return { ok: false, mensagem: 'Nenhuma assembleia selecionada.' };
      }
      const justLimpa = justificativa.trim();
      if (justLimpa.length < 10) {
        return {
          ok: false,
          mensagem:
            'Informe uma justificativa formal com pelo menos 10 caracteres para encerrar e arquivar a assembleia.',
        };
      }

      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_encerrar_e_arquivar', {
        p_assembleia_id: assembleiaAtual.id,
        p_justificativa: justLimpa,
        p_titulo_arquivo: tituloArquivo?.trim() || assembleiaAtual.titulo,
      });

      if (error) return { ok: false, mensagem: error.message };
      const res = (data ?? {}) as {
        ok?: boolean;
        message?: string;
        sha256_hash?: string;
        titulo?: string;
      };
      if (!res.ok) {
        return { ok: false, mensagem: res.message || 'Falha ao encerrar e arquivar assembleia.' };
      }

      exportarPacoteCompletoAssembleiaCsv({
        tituloAssembleia: res.titulo || tituloArquivo?.trim() || assembleiaAtual.titulo,
        config: { ...config, assembleia_ativa: false, convocacao_ativa: 'ENCERRADA' },
        presencas,
        pautas,
        votos,
      });

      await recarregarTudo();
      return {
        ok: true,
        mensagem:
          res.message ||
          `Assembleia encerrada e arquivada com SHA-256 (${(res.sha256_hash || '').slice(0, 16)}...)!`,
      };
    },
    [assembleiaAtual, config, pautas, presencas, recarregarTudo, votos]
  );

  const resetarAssembleiaParaNova = useCallback(
    async (manterCadastroBase: boolean): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.rpc('assembleia_resetar_geral', {
        p_manter_cadastro_base: manterCadastroBase,
      });

      if (error) return { ok: false, mensagem: error.message };
      const resposta = (data ?? {}) as { ok?: boolean; message?: string };
      await recarregarTudo();
      return {
        ok: Boolean(resposta.ok),
        mensagem: resposta.message || 'Assembleia ativa reiniciada.',
      };
    },
    [recarregarTudo]
  );

  const excluirAssembleiaDoHistorico = useCallback(
    async (id: string): Promise<ResultadoOperacaoAdmin> => {
      const supabase = getSupabaseAuthClient();
      const { error } = await supabase.from('assembleia_historico').delete().eq('id', id);
      if (error) return { ok: false, mensagem: error.message };
      setHistoricoAssembleias((atual) => atual.filter((item) => item.id !== id));
      return { ok: true, mensagem: 'Registro removido do histórico.' };
    },
    []
  );

  return {
    assembleias,
    assembleiaAtual,
    assembleiaSelecionadaId,
    setAssembleiaSelecionadaId,
    config,
    unidadesCadastradas,
    presencas,
    inadimplentes,
    pautas,
    votos,
    historicoAssembleias,
    operacoesAuditoria,
    votosAuditoria,
    pautaAberta,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    criarNovaAssembleia,
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
    encerrarEArquivarAssembleia,
    resetarAssembleiaParaNova,
    excluirAssembleiaDoHistorico,
  };
}
