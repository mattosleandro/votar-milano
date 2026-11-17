'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  Lock,
  LogOut,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Timer,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import { useAssembleiaPublicRealtime } from '@/hooks/useAssembleiaPublicRealtime';
import {
  calcularPlacarPauta,
  calcularQuorumEscopo,
  chaveUnidade,
  formatarBloco,
  formatarSegundosMMSS,
  formatarUnidadeCompleta,
  formatarUnidadeTelaoCompacta,
  obterEstadoRelogioCampoGrande,
  obterMetadadosEscopo,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import { coletarTelemetriaDispositivo } from '@/lib/deviceTelemetry';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { OpcaoVoto, PresencaPublica, SessaoMoradorLocal } from '@/lib/types';
import { aplicarMascaraCpf, validarCpf } from '@/lib/validators';

const STORAGE_KEY_SESSAO = 'votar_milano_sessao_v2';

type FiltroEspelhoMobile = 'MEU_BLOCO' | 'VOTARAM' | 'PRESENTES_ESCOPO';

interface UnidadeLocalizadaCpf {
  id: string;
  bloco: number;
  apartamento: number;
  fase: 1 | 2;
  modulo: 1 | 2 | 3 | 4;
  nome_completo: string;
  is_inadimplente: boolean;
  is_construtora: boolean;
  pertence_escopo: boolean;
  confirmado_portaria?: boolean;
  online_conectado?: boolean;
  ja_credenciado: boolean;
}

interface RpcConsultaCpfResponse {
  ok: boolean;
  code: string;
  message?: string;
  escopo_assembleia?: string;
  unidades?: UnidadeLocalizadaCpf[];
}

interface RpcConfirmarCheckinResponse {
  ok: boolean;
  code: string;
  message: string;
  presenca?: {
    id: string;
    bloco: number;
    apartamento: number;
    fase: 1 | 2;
    modulo: 1 | 2 | 3 | 4;
    nome_completo: string;
    is_construtora: boolean;
    created_at: string;
  };
}

export default function PaginaMorador() {
  const {
    config,
    presencas,
    pautaAberta,
    ultimaPautaEncerrada,
    votos,
    carregandoInicial,
    statusConexao,
    recarregarTudo,
    registrarVotoUnidade,
  } = useAssembleiaPublicRealtime('morador');

  const [sessao, setSessao] = useState<SessaoMoradorLocal | null>(null);
  const [sessaoCarregadaStorage, setSessaoCarregadaStorage] = useState(false);
  const [avisoSessaoEncerrada, setAvisoSessaoEncerrada] = useState<string | null>(null);

  // Estado do Check-in por CPF em 2 passos
  const [cpf, setCpf] = useState('');
  const [consultandoCpf, setConsultandoCpf] = useState(false);
  const [confirmandoCheckin, setConfirmandoCheckin] = useState(false);
  const [unidadesEncontradas, setUnidadesEncontradas] = useState<
    UnidadeLocalizadaCpf[] | null
  >(null);
  const [unidadeEscolhidaKey, setUnidadeEscolhidaKey] = useState<string>('');
  const [erroFormulario, setErroFormulario] = useState<string | null>(null);
  const [bloqueioInadimplenteMsg, setBloqueioInadimplenteMsg] = useState<string | null>(
    null
  );

  // Estado de votação e espelho mobile
  const [enviandoVoto, setEnviandoVoto] = useState<OpcaoVoto | null>(null);
  const [erroVoto, setErroVoto] = useState<string | null>(null);
  const [feedbackVoto, setFeedbackVoto] = useState<string | null>(null);
  const [filtroEspelho, setFiltroEspelho] = useState<FiltroEspelhoMobile>('MEU_BLOCO');
  const [mostrarEspelhoVotos, setMostrarEspelhoVotos] = useState(true);
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setAgoraMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 1. Restaura sessão do localStorage ao iniciar
  useEffect(() => {
    try {
      const salvo = window.localStorage.getItem(STORAGE_KEY_SESSAO);
      if (salvo) {
        const parsed = JSON.parse(salvo) as SessaoMoradorLocal;
        if (parsed?.id && parsed?.bloco && parsed?.apartamento) {
          setSessao(parsed);
        }
      }
    } catch {
      // Ignora JSON corrompido
    } finally {
      setSessaoCarregadaStorage(true);
    }
  }, []);

  // 2. Verifica se a presença da sessão local continua ativa no banco e se a assembleia está ativa
  useEffect(() => {
    if (carregandoInicial || !sessao) return;

    if (!config.assembleia_ativa || config.convocacao_ativa === 'ENCERRADA') {
      window.localStorage.removeItem(STORAGE_KEY_SESSAO);
      setSessao(null);
      return;
    }

    const aindaAtiva = presencas.some(
      (p) => p.bloco === sessao.bloco && p.apartamento === sessao.apartamento
    );
    if (!aindaAtiva) {
      window.localStorage.removeItem(STORAGE_KEY_SESSAO);
      setSessao(null);
      setAvisoSessaoEncerrada(
        'O credenciamento da sua unidade foi atualizado ou encerrado pela Mesa Diretora. Digite seu CPF novamente se necessário.'
      );
    }
  }, [
    carregandoInicial,
    config.assembleia_ativa,
    config.convocacao_ativa,
    presencas,
    sessao,
  ]);

  // Limpa resultados parciais se a assembleia for desativada no /admin
  useEffect(() => {
    if (!config.assembleia_ativa || config.convocacao_ativa === 'ENCERRADA') {
      setUnidadesEncontradas(null);
      setBloqueioInadimplenteMsg(null);
      setErroFormulario(null);
    }
  }, [config.assembleia_ativa, config.convocacao_ativa]);

  const votacaoAtivaNoMomento =
    config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA';

  const estadoRelogio = useMemo(
    () => obterEstadoRelogioCampoGrande(config, agoraMs),
    [config, agoraMs]
  );

  const segundosRestantesTimer = useMemo(() => {
    const duracao = config.timer_duration_seconds || 120;
    if (!config.timer_running || !config.timer_started_at) return null;
    const inicio = Date.parse(config.timer_started_at);
    if (Number.isNaN(inicio)) return null;
    const rest = Math.max(0, duracao - Math.floor((agoraMs - inicio) / 1000));
    return rest;
  }, [
    config.timer_duration_seconds,
    config.timer_running,
    config.timer_started_at,
    agoraMs,
  ]);

  const tempoVotacaoEsgotado = segundosRestantesTimer !== null && segundosRestantesTimer <= 0;

  // Passo 1: Consultar CPF na base pré-cadastrada
  const handleConsultarCpf = async (e: React.FormEvent) => {
    e.preventDefault();
    setErroFormulario(null);
    setBloqueioInadimplenteMsg(null);
    setAvisoSessaoEncerrada(null);
    setUnidadesEncontradas(null);

    if (!votacaoAtivaNoMomento) {
      setErroFormulario('Não existe nenhuma votação ativa no momento.');
      return;
    }

    const resCpf = validarCpf(cpf);
    if (!resCpf.valido) {
      setErroFormulario(resCpf.erro ?? 'Informe um CPF válido.');
      return;
    }

    setConsultandoCpf(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.rpc('assembleia_consultar_cpf', {
        p_cpf: resCpf.cpfLimpo,
      });

      if (error) {
        setErroFormulario(
          error.message || 'Erro ao consultar CPF. Tente novamente.'
        );
        return;
      }

      const resposta = data as RpcConsultaCpfResponse;
      if (!resposta?.ok) {
        if (resposta?.code === 'UNIDADE_INADIMPLENTE') {
          setBloqueioInadimplenteMsg(
            resposta.message ||
              'Unidade bloqueada para realizar votação. Efetue o pagamento dos valores referentes ao condomínio e apresente o comprovante ao Síndico / Mesa Diretora para liberar a votação.'
          );
          if (resposta.unidades && resposta.unidades.length > 0) {
            setUnidadesEncontradas(resposta.unidades);
          }
        } else {
          setErroFormulario(
            resposta?.message || 'Não foi possível localizar unidade para este CPF.'
          );
          if (resposta?.unidades && resposta.unidades.length > 0) {
            setUnidadesEncontradas(resposta.unidades);
          }
        }
        return;
      }

      const lista = resposta.unidades ?? [];
      setUnidadesEncontradas(lista);

      // Seleciona por padrão a primeira unidade adimplente e dentro do escopo
      const primeiraApta = lista.find(
        (u) => !u.is_inadimplente && u.pertence_escopo
      );
      if (primeiraApta) {
        setUnidadeEscolhidaKey(
          chaveUnidade(primeiraApta.bloco, primeiraApta.apartamento)
        );
      } else if (lista[0]) {
        setUnidadeEscolhidaKey(chaveUnidade(lista[0].bloco, lista[0].apartamento));
      }
    } catch {
      setErroFormulario(
        'Falha de comunicação com o servidor. Verifique sua conexão.'
      );
    } finally {
      setConsultandoCpf(false);
    }
  };

  const unidadeSelecionadaConfirmacao = useMemo(() => {
    if (!unidadesEncontradas || unidadesEncontradas.length === 0) return null;
    return (
      unidadesEncontradas.find(
        (u) => chaveUnidade(u.bloco, u.apartamento) === unidadeEscolhidaKey
      ) ?? unidadesEncontradas[0]
    );
  }, [unidadesEncontradas, unidadeEscolhidaKey]);

  // Passo 2: Confirmar Bloco, Apartamento e Fase + Enviar Telemetria do Aparelho
  const handleConfirmarCheckin = async () => {
    if (!unidadeSelecionadaConfirmacao || confirmandoCheckin) return;

    const resCpf = validarCpf(cpf);
    if (!resCpf.valido) return;

    if (unidadeSelecionadaConfirmacao.is_inadimplente) {
      setBloqueioInadimplenteMsg(
        'Unidade bloqueada para realizar votação. Para liberar o voto, quite os valores pendentes referentes ao condomínio e apresente o comprovante ao Síndico / Mesa Diretora.'
      );
      return;
    }

    if (!unidadeSelecionadaConfirmacao.pertence_escopo) {
      setErroFormulario(
        `Esta unidade pertence à Fase ${unidadeSelecionadaConfirmacao.fase} • Módulo ${unidadeSelecionadaConfirmacao.modulo}, que não faz parte do quórum convocado no momento.`
      );
      return;
    }

    setConfirmandoCheckin(true);
    setErroFormulario(null);

    try {
      const telemetria = await coletarTelemetriaDispositivo();
      const supabase = getSupabaseBrowserClient();

      const { data, error } = await supabase.rpc(
        'assembleia_confirmar_checkin_cpf',
        {
          p_cpf: resCpf.cpfLimpo,
          p_bloco: unidadeSelecionadaConfirmacao.bloco,
          p_apartamento: unidadeSelecionadaConfirmacao.apartamento,
          p_ip_address: telemetria.ip_address,
          p_device_id: telemetria.device_id,
          p_device_name: telemetria.device_name,
          p_user_agent: telemetria.user_agent,
        }
      );

      if (error) {
        setErroFormulario(error.message || 'Erro ao confirmar check-in.');
        return;
      }

      const resposta = data as RpcConfirmarCheckinResponse;
      if (!resposta?.ok || !resposta.presenca) {
        if (resposta?.code === 'UNIDADE_INADIMPLENTE') {
          setBloqueioInadimplenteMsg(resposta.message);
        } else {
          setErroFormulario(
            resposta?.message || 'Não foi possível concluir o check-in.'
          );
        }
        return;
      }

      const p = resposta.presenca;
      const primeiroNome = p.nome_completo.split(' ')[0] || 'Condômino';
      const novaSessao: SessaoMoradorLocal = {
        id: p.id,
        bloco: p.bloco,
        apartamento: p.apartamento,
        fase: p.fase,
        modulo: p.modulo,
        primeiroNome,
        cpfLimpo: resCpf.cpfLimpo,
        createdAt: p.created_at,
      };

      window.localStorage.setItem(
        STORAGE_KEY_SESSAO,
        JSON.stringify(novaSessao)
      );
      setSessao(novaSessao);
      void recarregarTudo();
    } catch {
      setErroFormulario(
        'Falha ao confirmar check-in. Verifique sua conexão 4G/5G.'
      );
    } finally {
      setConfirmandoCheckin(false);
    }
  };

  const handleTrocarUnidadeLocal = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY_SESSAO);
    setSessao(null);
    setUnidadesEncontradas(null);
    setFeedbackVoto(null);
    setErroVoto(null);
  }, []);

  // Voto da unidade conectada na pauta aberta
  const meuVotoAtual = useMemo(() => {
    if (!sessao || !pautaAberta) return null;
    return (
      votos.find(
        (v) =>
          v.pauta_id === pautaAberta.id &&
          v.bloco === sessao.bloco &&
          v.apartamento === sessao.apartamento
      )?.voto ?? null
    );
  }, [sessao, pautaAberta, votos]);

  const handleVotar = async (opcao: OpcaoVoto) => {
    if (!sessao || !pautaAberta || enviandoVoto) return;
    setEnviandoVoto(opcao);
    setErroVoto(null);

    const res = await registrarVotoUnidade({
      pautaId: pautaAberta.id,
      bloco: sessao.bloco,
      apartamento: sessao.apartamento,
      voto: opcao,
      isConstrutora: false,
    });

    setEnviandoVoto(null);
    if (!res.ok) {
      setErroVoto(res.erro ?? 'Não foi possível registrar seu voto.');
      return;
    }

    const rotuloVoto =
      opcao === 'SIM' ? 'SIM' : opcao === 'NAO' ? 'NÃO' : 'ABSTENÇÃO';
    setFeedbackVoto(
      `Seu voto [${rotuloVoto}] foi registrado no telão para ${formatarUnidadeTelaoCompacta(
        sessao.bloco,
        sessao.apartamento
      )}!`
    );
  };

  // Cálculo de Quórum e Placar
  const pautaEmFoco = pautaAberta ?? ultimaPautaEncerrada;
  const escopoAtivo = pautaEmFoco?.escopo ?? config.escopo_assembleia;
  const metaEscopoAtivo = useMemo(
    () => obterMetadadosEscopo(escopoAtivo),
    [escopoAtivo]
  );

  const resumoQuorum = useMemo(
    () => calcularQuorumEscopo(escopoAtivo, presencas, config),
    [escopoAtivo, presencas, config]
  );

  const placarAoVivo = useMemo(() => {
    if (!pautaEmFoco) return null;
    return calcularPlacarPauta(pautaEmFoco, presencas, votos);
  }, [pautaEmFoco, presencas, votos]);

  const mapaVotosPautaEmFoco = useMemo(() => {
    const map = new Map<string, OpcaoVoto>();
    if (!pautaEmFoco) return map;
    for (const v of votos) {
      if (v.pauta_id === pautaEmFoco.id) {
        map.set(chaveUnidade(v.bloco, v.apartamento), v.voto);
      }
    }
    return map;
  }, [pautaEmFoco, votos]);

  const unidadesEspelhoMobile = useMemo(() => {
    const aptasNoEscopo = presencas.filter((p) =>
      unidadePertenceAoEscopo(p, escopoAtivo)
    );

    if (filtroEspelho === 'MEU_BLOCO' && sessao) {
      return aptasNoEscopo.filter((p) => p.bloco === sessao.bloco);
    }
    if (filtroEspelho === 'VOTARAM' && pautaEmFoco) {
      return aptasNoEscopo.filter((p) =>
        mapaVotosPautaEmFoco.has(chaveUnidade(p.bloco, p.apartamento))
      );
    }
    return aptasNoEscopo;
  }, [
    presencas,
    escopoAtivo,
    filtroEspelho,
    sessao,
    pautaEmFoco,
    mapaVotosPautaEmFoco,
  ]);

  if (!sessaoCarregadaStorage) {
    return (
      <div className="min-h-screen bg-[#0C0C0D] flex items-center justify-center p-6">
        <MilanoLogo variant="dark" className="h-12 w-auto animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F6F5F1] text-[#0C0C0D] flex flex-col">
      {/* Cabeçalho Institucional Milano */}
      <header className="sticky top-0 z-30 bg-[#0C0C0D] text-white border-b border-milano-gold/30 shadow-md">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <MilanoLogo variant="dark" className="h-8 sm:h-9 w-auto" />
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-slate-900 border border-slate-700 text-milano-gold-light tabular-nums">
              <Clock className="w-3 h-3 text-milano-gold" />
              {estadoRelogio.horaCampoGrande}
            </span>

            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide border ${
                statusConexao === 'AO_VIVO'
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/40'
                  : 'bg-amber-950/80 text-amber-300 border-amber-500/40'
              }`}
            >
              {statusConexao === 'AO_VIVO' ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <Wifi className="w-3 h-3" />
                  AO VIVO
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 animate-spin" />
                  SYNC
                </>
              )}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-xl w-full mx-auto px-4 py-5 space-y-5">
        {/* Banner Global de Convocação, Quórum e Total Agregado de Inadimplentes */}
        <section
          aria-label="Status da Convocação e Quórum"
          className="rounded-2xl bg-[#0C0C0D] text-white p-4 shadow-md border border-milano-gold/35 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-md bg-milano-gold/20 border border-milano-gold/50 text-milano-gold-light text-xs font-bold uppercase tracking-wider">
                {!config.assembleia_ativa
                  ? 'Sem Votação Ativa'
                  : config.convocacao_ativa === 'PRIMEIRA'
                    ? `1ª Convocação (${config.horario_primeira_convocacao})`
                    : config.convocacao_ativa === 'SEGUNDA'
                      ? `2ª Convocação (${config.horario_segunda_convocacao})`
                      : config.convocacao_ativa === 'AGUARDANDO'
                        ? `Aguardando Início (${config.horario_primeira_convocacao})`
                        : 'Assembleia Encerrada'}
              </span>
              {config.assembleia_ativa && (
                <span className="text-xs text-slate-300 font-medium">
                  {config.convocacao_ativa === 'PRIMEIRA'
                    ? 'Maioria Absoluta'
                    : config.convocacao_ativa === 'SEGUNDA'
                      ? 'Maioria Simples'
                      : `2ª às ${config.horario_segunda_convocacao}`}
                </span>
              )}
            </div>

            <span className="text-xs font-mono text-milano-gold tabular-nums">
              {metaEscopoAtivo.rotuloCurto}
            </span>
          </div>

          {/* Contador Regressivo do Telão (quando ativo) */}
          {segundosRestantesTimer !== null && config.timer_running && (
            <div className="rounded-xl bg-milano-gold/15 border border-milano-gold/40 px-3.5 py-2 flex items-center justify-between">
              <span className="text-xs font-bold text-milano-gold-light flex items-center gap-1.5">
                <Timer className="w-4 h-4 text-milano-gold animate-pulse" />
                Tempo Restante de Votação:
              </span>
              <span
                className={`font-mono text-lg font-black tabular-nums ${
                  segundosRestantesTimer <= 30
                    ? 'text-rose-400 animate-pulse'
                    : 'text-white'
                }`}
              >
                {formatarSegundosMMSS(segundosRestantesTimer)}
              </span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 pt-1 text-center tabular-nums">
            <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
              <p className="text-[11px] text-slate-400 uppercase tracking-wider">
                Presentes Aptos
              </p>
              <p className="text-lg font-bold font-mono text-white">
                {resumoQuorum.presentesNoEscopo}
                <span className="text-xs text-slate-400 font-normal">
                  /{resumoQuorum.baseConvocadosAptos}
                </span>
              </p>
            </div>

            <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
              <p className="text-[11px] text-slate-400 uppercase tracking-wider">
                {config.convocacao_ativa === 'PRIMEIRA'
                  ? 'Mín. 1ª Conv.'
                  : 'Quórum Atual'}
              </p>
              <p className="text-lg font-bold font-mono text-milano-gold">
                {config.convocacao_ativa === 'PRIMEIRA'
                  ? `${resumoQuorum.minimoPrimeiraConvocacao} un.`
                  : `${resumoQuorum.percentualPresencaBase.toFixed(1)}%`}
              </p>
            </div>

            {/* Exibição Pública Obrigatória: APENAS Quantidade Total de Inadimplentes */}
            <div className="rounded-xl bg-amber-950/40 border border-amber-500/30 p-2.5">
              <p className="text-[11px] text-amber-300/90 uppercase tracking-wider">
                Inadimplentes
              </p>
              <p
                className="text-lg font-bold font-mono text-amber-300"
                title="Quantidade total agregada de unidades sem direito a voto"
              >
                {config.total_inadimplentes}{' '}
                <span className="text-xs font-normal">un.</span>
              </p>
            </div>
          </div>
        </section>

        {/* ===================================================================
            ESTADO 1: CHECK-IN APENAS POR CPF (Se não estiver logado)
           =================================================================== */}
        {!sessao ? (
          <section className="rounded-2xl bg-white p-5 sm:p-6 shadow-sm border border-slate-200/90 space-y-5">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-milano-gold-dark">
                <ShieldCheck className="w-4 h-4" />
                Credenciamento Oficial por CPF
              </div>
              <h1 className="text-xl font-extrabold tracking-tight text-slate-900">
                Check-in da Unidade
              </h1>
              <p className="text-xs text-slate-600 leading-relaxed">
                Digite apenas o seu <strong>CPF</strong> para localizar sua unidade e confirmar o
                Bloco, Apartamento e Fase.
              </p>
            </div>

            {/* BLOQUEIO QUANDO NÃO HÁ VOTAÇÃO / QUÓRUM ATIVO SALVO NO /ADMIN */}
            {!votacaoAtivaNoMomento && (
              <div
                role="alert"
                className="rounded-2xl bg-amber-50 border-2 border-amber-300 p-4 text-amber-950 space-y-1.5"
              >
                <div className="flex items-center gap-2 font-extrabold text-sm">
                  <Lock className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>Não existe nenhuma votação ativa no momento.</span>
                </div>
                <p className="text-xs text-amber-900 leading-relaxed">
                  O check-in por CPF será liberado automaticamente assim que a Mesa Diretora
                  definir e salvar o Quórum e os Horários de Convocação da Assembleia.
                </p>
              </div>
            )}

            {avisoSessaoEncerrada ? (
              <div
                role="alert"
                className="rounded-xl bg-amber-50 border border-amber-300 p-3.5 text-xs text-amber-900 flex gap-2.5 items-start"
              >
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>{avisoSessaoEncerrada}</span>
              </div>
            ) : null}

            {/* Formulário de Digitação do CPF */}
            <form onSubmit={handleConsultarCpf} className="space-y-4" noValidate>
              <div>
                <label
                  htmlFor="cpf-morador"
                  className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5"
                >
                  CPF do Condômino Responsável
                </label>
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    id="cpf-morador"
                    name="cpf"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={!votacaoAtivaNoMomento || consultandoCpf}
                    required
                    placeholder={
                      votacaoAtivaNoMomento
                        ? '000.000.000-00'
                        : 'Aguardando abertura pela Mesa...'
                    }
                    value={cpf}
                    onChange={(e) => {
                      setCpf(aplicarMascaraCpf(e.target.value));
                      if (erroFormulario) setErroFormulario(null);
                      if (bloqueioInadimplenteMsg) setBloqueioInadimplenteMsg(null);
                      if (unidadesEncontradas) setUnidadesEncontradas(null);
                    }}
                    className="flex-1 min-h-[50px] rounded-xl border border-slate-300 px-3.5 py-2.5 text-base font-mono font-bold text-slate-900 placeholder:text-slate-400 focus:border-[#0C0C0D] focus:outline-none focus:ring-2 focus:ring-milano-gold/50 tabular-nums disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
                  />

                  <button
                    type="submit"
                    disabled={!votacaoAtivaNoMomento || consultandoCpf}
                    className="min-h-[50px] px-5 rounded-xl bg-[#0C0C0D] text-milano-gold font-extrabold text-sm tracking-wide shadow-sm hover:bg-slate-900 disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition shrink-0"
                  >
                    {consultandoCpf ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Consultando...
                      </>
                    ) : (
                      <>
                        <Search className="w-4 h-4" />
                        Buscar Unidade
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>

            {/* AVISO DE BLOQUEIO PARA UNIDADE INADIMPLENTE */}
            {bloqueioInadimplenteMsg && (
              <div
                role="alert"
                className="rounded-2xl bg-rose-50 border-2 border-rose-300 p-4 text-rose-950 space-y-2"
              >
                <div className="flex items-center gap-2 font-extrabold text-sm text-rose-800">
                  <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
                  <span>Unidade Bloqueada para Votação (Inadimplência)</span>
                </div>
                <p className="text-xs leading-relaxed text-rose-900 font-medium">
                  {bloqueioInadimplenteMsg}
                </p>
                {unidadesEncontradas && unidadesEncontradas.length > 0 && (
                  <div className="pt-1 flex flex-wrap gap-2">
                    {unidadesEncontradas.map((u) => (
                      <span
                        key={u.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-rose-200 px-3 py-1 font-mono text-xs font-bold text-rose-900"
                      >
                        Bloco {formatarBloco(u.bloco)} • Apto {u.apartamento} • Fase{' '}
                        {u.fase} (Módulo {u.modulo})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Erro de validação ou fora de escopo */}
            {erroFormulario ? (
              <div
                role="alert"
                className="rounded-xl bg-rose-50 border border-rose-200 p-3.5 text-xs font-medium text-rose-800 flex gap-2.5 items-start"
              >
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <span>{erroFormulario}</span>
                  {unidadesEncontradas && unidadesEncontradas.length > 0 && (
                    <div className="pt-1 font-mono font-bold text-rose-900">
                      Unidade localizada: Bloco{' '}
                      {formatarBloco(unidadesEncontradas[0].bloco)} • Apto{' '}
                      {unidadesEncontradas[0].apartamento} • Fase{' '}
                      {unidadesEncontradas[0].fase} (Módulo{' '}
                      {unidadesEncontradas[0].modulo})
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* PASSO 2: CARD DE CONFIRMAÇÃO DE BLOCO, APARTAMENTO E FASE */}
            {unidadesEncontradas &&
              unidadesEncontradas.length > 0 &&
              !bloqueioInadimplenteMsg &&
              unidadeSelecionadaConfirmacao && (
                <div className="rounded-2xl border-2 border-[#0C0C0D] bg-[#0C0C0D] text-white p-5 space-y-4 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-milano-gold/20 border border-milano-gold/50 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-milano-gold-light">
                      <Building2 className="w-3.5 h-3.5 text-milano-gold" />
                      Confirme os Dados da Sua Unidade
                    </span>
                    <span className="font-mono text-xs text-slate-400">
                      {aplicarMascaraCpf(cpf)}
                    </span>
                  </div>

                  {unidadesEncontradas.length > 1 && (
                    <div>
                      <label className="block text-xs font-bold text-slate-300 mb-1.5">
                        Você possui {unidadesEncontradas.length} unidades vinculadas a este CPF.
                        Selecione qual deseja confirmar:
                      </label>
                      <select
                        value={unidadeEscolhidaKey}
                        onChange={(e) => setUnidadeEscolhidaKey(e.target.value)}
                        className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm font-bold text-white"
                      >
                        {unidadesEncontradas.map((u) => {
                          const ch = chaveUnidade(u.bloco, u.apartamento);
                          return (
                            <option key={ch} value={ch}>
                              Bloco {formatarBloco(u.bloco)} • Apto {u.apartamento} — Fase{' '}
                              {u.fase} / Módulo {u.modulo}{' '}
                              {u.is_inadimplente
                                ? '(BLOQUEADO - INADIMPLENTE)'
                                : !u.pertence_escopo
                                  ? '(FORA DO QUÓRUM ATUAL)'
                                  : ''}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2.5 text-center">
                    <div className="rounded-xl bg-white/10 border border-white/15 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                        Bloco
                      </p>
                      <p className="mt-1 font-mono text-2xl font-black text-milano-gold">
                        {formatarBloco(unidadeSelecionadaConfirmacao.bloco)}
                      </p>
                    </div>

                    <div className="rounded-xl bg-white/10 border border-white/15 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                        Apartamento
                      </p>
                      <p className="mt-1 font-mono text-2xl font-black text-white">
                        {unidadeSelecionadaConfirmacao.apartamento}
                      </p>
                    </div>

                    <div className="rounded-xl bg-white/10 border border-white/15 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                        Fase / Módulo
                      </p>
                      <p className="mt-1 font-mono text-base font-black text-emerald-400">
                        F{unidadeSelecionadaConfirmacao.fase} • M
                        {unidadeSelecionadaConfirmacao.modulo}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl bg-white/5 px-3.5 py-2.5 text-xs text-slate-300 flex items-center justify-between">
                    <span>
                      Condômino:{' '}
                      <strong className="text-white">
                        {unidadeSelecionadaConfirmacao.nome_completo.split(' ')[0]}
                      </strong>
                    </span>
                    <span className="font-mono text-milano-gold-light font-bold">
                      Fase {unidadeSelecionadaConfirmacao.fase} • Módulo{' '}
                      {unidadeSelecionadaConfirmacao.modulo}
                    </span>
                  </div>

                  {(() => {
                    const confirmadoPortariaTempoReal =
                      !config.exigir_confirmacao_portaria ||
                      Boolean(unidadeSelecionadaConfirmacao.confirmado_portaria) ||
                      presencas.some(
                        (p) =>
                          p.bloco === unidadeSelecionadaConfirmacao.bloco &&
                          p.apartamento === unidadeSelecionadaConfirmacao.apartamento &&
                          p.confirmado_portaria !== false
                      );

                    if (unidadeSelecionadaConfirmacao.is_inadimplente) {
                      return (
                        <div className="rounded-xl bg-rose-950/90 border border-rose-500/50 p-3.5 text-xs text-rose-200 font-semibold">
                          Esta unidade está bloqueada para realizar votação por inadimplência.
                          Efetue o pagamento dos valores pendentes do condomínio e apresente ao
                          Síndico para liberar a votação.
                        </div>
                      );
                    }

                    if (!unidadeSelecionadaConfirmacao.pertence_escopo) {
                      return (
                        <div className="rounded-xl bg-amber-950/90 border border-amber-500/50 p-3.5 text-xs text-amber-200 font-semibold">
                          Esta unidade não pertence ao Quórum selecionado no momento (
                          {obterMetadadosEscopo(config.escopo_assembleia).rotuloCurto}).
                        </div>
                      );
                    }

                    if (!confirmadoPortariaTempoReal) {
                      return (
                        <div className="rounded-xl bg-violet-950/90 border border-violet-400/50 p-3.5 text-xs text-violet-100 font-semibold space-y-1">
                          <p className="font-extrabold text-violet-200 uppercase">
                            Aguardando Liberação na Portaria / Entrada
                          </p>
                          <p>
                            Apresente seu documento ou procuração aos atendentes na entrada da
                            assembleia. Assim que confirmarem no portão, este botão será liberado
                            automaticamente!
                          </p>
                        </div>
                      );
                    }

                    return (
                      <button
                        type="button"
                        disabled={confirmandoCheckin}
                        onClick={() => void handleConfirmarCheckin()}
                        className="w-full min-h-[54px] rounded-xl bg-emerald-600 text-white font-black text-base tracking-wide shadow-md hover:bg-emerald-500 active:scale-[0.99] transition flex items-center justify-center gap-2"
                      >
                        {confirmandoCheckin ? (
                          <>
                            <RefreshCw className="w-5 h-5 animate-spin" />
                            Conectando Unidade...
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-5 h-5" />
                            Validar e Conectar Bloco{' '}
                            {formatarBloco(unidadeSelecionadaConfirmacao.bloco)} • Apto{' '}
                            {unidadeSelecionadaConfirmacao.apartamento} (Fase{' '}
                            {unidadeSelecionadaConfirmacao.fase})
                          </>
                        )}
                      </button>
                    );
                  })()}
                </div>
              )}
          </section>
        ) : (
          /* ===================================================================
             ESTADO 2: SALA DE VOTAÇÃO EM TEMPO REAL (Após Check-in por CPF)
             =================================================================== */
          <section className="space-y-4">
            {/* Cartão da Unidade Conectada */}
            <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-[#0C0C0D] text-milano-gold font-mono font-extrabold text-xs flex flex-col items-center justify-center border border-milano-gold/40 shrink-0">
                  <span>B{formatarBloco(sessao.bloco)}</span>
                  <span className="text-white text-sm">{sessao.apartamento}</span>
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                      Check-in Confirmado
                    </span>
                  </div>
                  <h2 className="text-base font-extrabold text-slate-900">
                    {formatarUnidadeCompleta(sessao.bloco, sessao.apartamento)}
                  </h2>
                  <p className="text-xs font-semibold text-slate-600">
                    Fase {sessao.fase} • Módulo {sessao.modulo}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleTrocarUnidadeLocal}
                title="Sair desta sessão neste aparelho"
                className="p-2.5 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition text-xs font-semibold flex items-center gap-1"
              >
                <LogOut className="w-4 h-4" />
                <span className="sr-only sm:not-sr-only">Trocar</span>
              </button>
            </div>

            {/* Painel Deliberativo da Pauta */}
            {!pautaAberta ? (
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-slate-200 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-milano-gold/15 text-milano-gold-dark mx-auto flex items-center justify-center">
                  <Clock className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-extrabold text-slate-900">
                  Presença confirmada! Aguarde a mesa abrir a próxima votação no telão...
                </h3>
                <p className="text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
                  Sua tela atualizará sozinha no exato segundo em que a Mesa Diretora abrir a
                  pauta. Não é necessário recarregar a página.
                </p>
              </div>
            ) : (
              (() => {
                const aptoNaPauta = unidadePertenceAoEscopo(
                  sessao,
                  pautaAberta.escopo
                );
                const metaPauta = obterMetadadosEscopo(pautaAberta.escopo);

                return (
                  <div className="rounded-2xl bg-white p-5 shadow-md border-2 border-[#0C0C0D] space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-900 text-xs font-extrabold uppercase tracking-wider">
                        <span className="w-2 h-2 rounded-full bg-emerald-600 animate-ping" />
                        Pauta #{pautaAberta.ordem} Aberta para Votação
                      </span>
                      <span className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-800 text-xs font-bold">
                        {metaPauta.rotuloCurto}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <h3 className="text-lg sm:text-xl font-extrabold text-slate-900 leading-snug">
                        {pautaAberta.titulo}
                      </h3>
                      {pautaAberta.descricao ? (
                        <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                          {pautaAberta.descricao}
                        </p>
                      ) : null}
                    </div>

                    {!aptoNaPauta ? (
                      <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 text-xs text-amber-950 space-y-1">
                        <p className="font-bold text-sm flex items-center gap-1.5">
                          <Lock className="w-4 h-4 text-amber-700" />
                          Votação Exclusiva: {metaPauta.rotuloCurto}
                        </p>
                        <p className="leading-relaxed">
                          Sua unidade pertence à{' '}
                          <strong>
                            Fase {sessao.fase} • Módulo {sessao.modulo}
                          </strong>
                          . Esta pauta delibera exclusivamente sobre assuntos de{' '}
                          <strong>{metaPauta.descricaoBlocos}</strong>. Você pode acompanhar a
                          apuração ao vivo logo abaixo!
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3 pt-1">
                        {tempoVotacaoEsgotado ? (
                          <div className="rounded-xl bg-amber-50 border border-amber-300 p-3.5 text-xs font-bold text-amber-950 flex items-center gap-2">
                            <Timer className="w-4 h-4 text-amber-700 shrink-0" />
                            <span>
                              Tempo de deliberação esgotado (00:00). Confira o resultado final abaixo!
                            </span>
                          </div>
                        ) : (
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-600">
                            Toque na sua opção de voto (1 voto pela unidade{' '}
                            {formatarUnidadeTelaoCompacta(
                              sessao.bloco,
                              sessao.apartamento
                            )}{' '}
                            — quem não votar será contabilizado como Abstenção / Imparcial):
                          </p>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <button
                            type="button"
                            disabled={enviandoVoto !== null || tempoVotacaoEsgotado}
                            onClick={() => handleVotar('SIM')}
                            className={`w-full min-h-[64px] rounded-2xl px-5 py-4 font-extrabold text-base tracking-wide transition flex items-center justify-between border-2 disabled:opacity-60 ${
                              meuVotoAtual === 'SIM'
                                ? 'bg-emerald-600 text-white border-emerald-800 shadow-lg ring-4 ring-emerald-500/25'
                                : 'bg-emerald-50/90 text-emerald-950 border-emerald-400 hover:bg-emerald-100'
                            }`}
                          >
                            <span className="flex items-center gap-3">
                              <ThumbsUp className="w-5 h-5" />
                              SIM (APROVAR)
                            </span>
                            {meuVotoAtual === 'SIM' ? (
                              <span className="text-xs uppercase px-2.5 py-1 rounded-full bg-white/20 font-bold">
                                Voto Confirmado ✓
                              </span>
                            ) : null}
                          </button>

                          <button
                            type="button"
                            disabled={enviandoVoto !== null || tempoVotacaoEsgotado}
                            onClick={() => handleVotar('NAO')}
                            className={`w-full min-h-[64px] rounded-2xl px-5 py-4 font-extrabold text-base tracking-wide transition flex items-center justify-between border-2 disabled:opacity-60 ${
                              meuVotoAtual === 'NAO'
                                ? 'bg-rose-600 text-white border-rose-800 shadow-lg ring-4 ring-rose-500/25'
                                : 'bg-rose-50/90 text-rose-950 border-rose-400 hover:bg-rose-100'
                            }`}
                          >
                            <span className="flex items-center gap-3">
                              <ThumbsDown className="w-5 h-5" />
                              NÃO (REJEITAR)
                            </span>
                            {meuVotoAtual === 'NAO' ? (
                              <span className="text-xs uppercase px-2.5 py-1 rounded-full bg-white/20 font-bold">
                                Voto Confirmado ✓
                              </span>
                            ) : null}
                          </button>
                        </div>

                        {erroVoto ? (
                          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800 font-medium">
                            {erroVoto}
                          </div>
                        ) : null}

                        {feedbackVoto || meuVotoAtual ? (
                          <div className="rounded-xl bg-emerald-50 border border-emerald-300 p-3.5 text-xs font-bold text-emerald-950 flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                            <span>
                              {feedbackVoto ??
                                `Seu voto [${
                                  meuVotoAtual === 'NAO' ? 'NÃO' : 'SIM'
                                }] está computado no telão! Enquanto o tempo estiver aberto, você pode alterá-lo.`}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </section>
        )}

        {/* ===================================================================
            ESPELHO DO TELÃO EM TEMPO REAL NO CELULAR (Placar + Mapa Bxx | Axxx)
           =================================================================== */}
        <section
          aria-label="Espelho em Tempo Real do Telão"
          className="rounded-2xl bg-white p-5 shadow-sm border border-slate-200 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-milano-gold-dark flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                Espelho do Telão no Celular
              </span>
              <h3 className="text-base font-extrabold text-slate-900">
                {pautaAberta
                  ? `Apuração ao Vivo • Pauta #${pautaAberta.ordem}`
                  : ultimaPautaEncerrada
                    ? `Resultado Final • Pauta #${ultimaPautaEncerrada.ordem}`
                    : 'Unidades Presentes Credenciadas'}
              </h3>
            </div>

            <button
              type="button"
              onClick={() => setMostrarEspelhoVotos((v) => !v)}
              className="text-xs font-bold text-slate-600 hover:text-slate-900 px-2.5 py-1.5 rounded-lg bg-slate-100"
            >
              {mostrarEspelhoVotos ? 'Ocultar Grade' : 'Ver Grade'}
            </button>
          </div>

          {placarAoVivo && pautaEmFoco ? (
            (() => {
              const mostrarVencedor =
                pautaEmFoco.status === 'encerrada' || tempoVotacaoEsgotado;
              const simVenceu = mostrarVencedor && placarAoVivo.vencedor === 'SIM';
              const naoVenceu = mostrarVencedor && placarAoVivo.vencedor === 'NAO';
              const empatou = mostrarVencedor && placarAoVivo.vencedor === 'EMPATE';

              return (
                <div className="space-y-2.5 tabular-nums">
                  <p className="text-xs font-semibold text-slate-700 line-clamp-2">
                    {pautaEmFoco.titulo}
                  </p>

                  {mostrarVencedor && placarAoVivo.totalVotosRegistrados > 0 ? (
                    <div
                      className={`rounded-xl px-3.5 py-2.5 border-2 flex items-center justify-between gap-2 ${
                        simVenceu
                          ? 'bg-emerald-600 border-emerald-800 text-white'
                          : naoVenceu
                            ? 'bg-rose-600 border-rose-800 text-white'
                            : 'bg-amber-500 border-amber-700 text-slate-950'
                      }`}
                    >
                      <span className="text-xs font-extrabold uppercase tracking-wider">
                        {simVenceu
                          ? '★ VENCEDOR • MAIORIA SIM (APROVADO)'
                          : naoVenceu
                            ? '★ VENCEDOR • MAIORIA NÃO (REJEITADO)'
                            : 'EMPATE TÉCNICO'}
                      </span>
                      <span className="text-xs font-mono font-extrabold">
                        SIM {placarAoVivo.sim} × {placarAoVivo.nao} NÃO
                      </span>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-3 gap-2">
                    <div
                      className={`rounded-xl p-2.5 transition ${
                        simVenceu
                          ? 'bg-emerald-100 border-2 border-emerald-600 ring-2 ring-emerald-500/30 shadow-sm'
                          : 'bg-emerald-50 border border-emerald-200'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-bold text-emerald-900">
                        <span className="flex items-center gap-1">
                          SIM
                          {simVenceu ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-700 text-white text-[9px] uppercase font-extrabold">
                              Vencedor
                            </span>
                          ) : null}
                        </span>
                        <span>{placarAoVivo.pctSimValidos.toFixed(1)}%</span>
                      </div>
                      <p className="text-xl font-extrabold font-mono text-emerald-700 mt-0.5">
                        {placarAoVivo.sim}
                      </p>
                      <p className="text-[10px] font-semibold text-emerald-800/80">
                        {placarAoVivo.pctSim.toFixed(1)}% dos presentes
                      </p>
                    </div>

                    <div
                      className={`rounded-xl p-2.5 transition ${
                        naoVenceu
                          ? 'bg-rose-100 border-2 border-rose-600 ring-2 ring-rose-500/30 shadow-sm'
                          : 'bg-rose-50 border border-rose-200'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-bold text-rose-900">
                        <span className="flex items-center gap-1">
                          NÃO
                          {naoVenceu ? (
                            <span className="px-1.5 py-0.5 rounded bg-rose-700 text-white text-[9px] uppercase font-extrabold">
                              Vencedor
                            </span>
                          ) : null}
                        </span>
                        <span>{placarAoVivo.pctNaoValidos.toFixed(1)}%</span>
                      </div>
                      <p className="text-xl font-extrabold font-mono text-rose-700 mt-0.5">
                        {placarAoVivo.nao}
                      </p>
                      <p className="text-[10px] font-semibold text-rose-800/80">
                        {placarAoVivo.pctNao.toFixed(1)}% dos presentes
                      </p>
                    </div>

                    <div className="rounded-xl bg-amber-50/80 border border-amber-200 p-2.5">
                      <div className="flex items-center justify-between text-xs font-bold text-amber-950">
                        <span>NÃO VOTOU</span>
                        <span>{placarAoVivo.pctNaoVotaram.toFixed(1)}%</span>
                      </div>
                      <p className="text-xl font-extrabold font-mono text-amber-800 mt-0.5">
                        {placarAoVivo.naoVotaram}
                      </p>
                      <p className="text-[10px] font-semibold text-amber-900/80">
                        Abstenção / Imparcial
                      </p>
                    </div>
                  </div>
                  {empatou ? (
                    <p className="text-[11px] font-bold text-amber-800 text-center">
                      Empate entre SIM ({placarAoVivo.sim}) e NÃO ({placarAoVivo.nao})
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : null}

          {mostrarEspelhoVotos ? (
            <div className="space-y-3 pt-1">
              <div className="flex flex-wrap gap-1.5">
                {sessao ? (
                  <button
                    type="button"
                    onClick={() => setFiltroEspelho('MEU_BLOCO')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                      filtroEspelho === 'MEU_BLOCO'
                        ? 'bg-[#0C0C0D] text-milano-gold'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    Meu Bloco (B{formatarBloco(sessao.bloco)})
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setFiltroEspelho('VOTARAM')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                    filtroEspelho === 'VOTARAM'
                      ? 'bg-[#0C0C0D] text-milano-gold'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Já Votaram ({placarAoVivo?.totalVotosRegistrados ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() => setFiltroEspelho('PRESENTES_ESCOPO')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                    filtroEspelho === 'PRESENTES_ESCOPO' ||
                    (!sessao && filtroEspelho === 'MEU_BLOCO')
                      ? 'bg-[#0C0C0D] text-milano-gold'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Presentes no Escopo ({resumoQuorum.presentesNoEscopo})
                </button>
              </div>

              {unidadesEspelhoMobile.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center">
                  Nenhuma unidade encontrada para este filtro no momento.
                </p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                  {unidadesEspelhoMobile.map((u: PresencaPublica) => {
                    const voto = mapaVotosPautaEmFoco.get(
                      chaveUnidade(u.bloco, u.apartamento)
                    );
                    const ehMinha =
                      sessao?.bloco === u.bloco &&
                      sessao?.apartamento === u.apartamento;

                    let corCard = 'bg-amber-50 border-amber-300 text-amber-950';
                    if (voto === 'SIM') {
                      corCard = 'bg-emerald-600 border-emerald-700 text-white';
                    } else if (voto === 'NAO') {
                      corCard = 'bg-rose-600 border-rose-700 text-white';
                    }

                    return (
                      <div
                        key={u.id}
                        className={`rounded-xl border p-2 text-center transition ${corCard} ${
                          ehMinha ? 'ring-2 ring-[#0C0C0D] ring-offset-1' : ''
                        }`}
                      >
                        <div className="font-mono font-extrabold text-xs tabular-nums">
                          {formatarUnidadeTelaoCompacta(u.bloco, u.apartamento)}
                        </div>
                        <div className="mt-0.5 flex items-center justify-center gap-1 flex-wrap">
                          {u.is_construtora ? (
                            <span className="px-1 py-0.2 rounded bg-black/20 text-[9px] font-bold uppercase">
                              CONST.
                            </span>
                          ) : null}
                          <span className="text-[10px] font-bold uppercase">
                            {voto === 'NAO'
                              ? 'NÃO'
                              : voto === 'SIM'
                                ? 'SIM'
                                : 'ABST / PRES.'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </section>
      </main>

      <footer className="py-4 text-center text-[11px] text-slate-500 border-t border-slate-200/70 bg-white/60">
        <div className="max-w-xl mx-auto px-4 flex items-center justify-between">
          <span>Milano Condomínio Club</span>
          <span className="inline-flex items-center gap-1">
            <Users className="w-3.5 h-3.5" /> {presencas.length}/544 presentes
          </span>
        </div>
      </footer>
    </div>
  );
}
