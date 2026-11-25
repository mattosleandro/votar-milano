'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Download,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Timer,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import {
  calcularQuorumEscopo,
  ESCOPOS_VOTACAO,
  formatarSegundosMMSS,
  obterEstadoRelogioCampoGrande,
  obterMetadadosEscopo,
} from '@/lib/condominio';
import {
  exportarPacoteCompletoAssembleiaCsv,
  obterSugestaoTituloAssembleia,
} from '@/lib/csv';
import {
  AssembleiaConfig,
  ConvocacaoStatus,
  EscopoVotacao,
  HistoricoAssembleia,
  PautaAssembleia,
  PresencaAdmin,
  VotoUnidade,
} from '@/lib/types';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminConvocacoesSectionProps {
  config: AssembleiaConfig;
  presencas: readonly PresencaAdmin[];
  pautas: readonly PautaAssembleia[];
  votos: readonly VotoUnidade[];
  historicoAssembleias: readonly HistoricoAssembleia[];
  onSalvarConfig: (
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
  ) => Promise<ResultadoOperacaoAdmin>;
  onControlarTimer: (
    acao: 'INICIAR' | 'PAUSAR' | 'RESETAR',
    duracaoSegundos?: number
  ) => Promise<ResultadoOperacaoAdmin>;
  onSalvarAssembleia: (titulo: string) => Promise<ResultadoOperacaoAdmin>;
  onEncerrarEArquivar: (
    justificativa: string,
    tituloArquivo?: string
  ) => Promise<ResultadoOperacaoAdmin>;
  onResetarAssembleia: (manterCadastroBase: boolean) => Promise<ResultadoOperacaoAdmin>;
  onExcluirHistorico: (id: string) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

const OPCOES_CONVOCACAO: {
  valor: ConvocacaoStatus;
  titulo: string;
  subtitulo: string;
}[] = [
  {
    valor: 'AGUARDANDO',
    titulo: 'Aguardando Horário (Cronômetro)',
    subtitulo: 'Exibe contagem regressiva p/ 1ª e 2ª convocação no telão',
  },
  {
    valor: 'PRIMEIRA',
    titulo: '1ª Convocação Iniciada',
    subtitulo: 'Maioria Absoluta (50% + 1) • Relógio local no telão',
  },
  {
    valor: 'SEGUNDA',
    titulo: '2ª Convocação Iniciada',
    subtitulo: 'Maioria Simples (presentes) • Relógio local no telão',
  },
  {
    valor: 'ENCERRADA',
    titulo: 'Assembleia Encerrada',
    subtitulo: 'Bloqueia check-in e encerra votações',
  },
];

export function AdminConvocacoesSection({
  config,
  presencas,
  pautas,
  votos,
  historicoAssembleias,
  onSalvarConfig,
  onControlarTimer,
  onSalvarAssembleia,
  onEncerrarEArquivar,
  onResetarAssembleia,
  onExcluirHistorico,
  onNotificar,
}: AdminConvocacoesSectionProps) {
  const [horario1, setHorario1] = useState(config.horario_primeira_convocacao);
  const [horario2, setHorario2] = useState(config.horario_segunda_convocacao);
  const [escopoAssembleia, setEscopoAssembleia] = useState<EscopoVotacao>(
    config.escopo_assembleia
  );
  const [descontarInadimplentes, setDescontarInadimplentes] = useState(
    config.descontar_inadimplentes_quorum
  );
  const [minutosTimerCustom, setMinutosTimerCustom] = useState<number>(
    Math.max(1, Math.round((config.timer_duration_seconds || 120) / 60))
  );
  const [salvando, setSalvando] = useState(false);
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now());

  // Estados para Salvar Assembleia, Encerrar & Arquivar SHA-256 e Resetar Geral
  const [tituloAssembleiaSalvar, setTituloAssembleiaSalvar] = useState<string>(() =>
    obterSugestaoTituloAssembleia()
  );
  const [salvandoAssembleia, setSalvandoAssembleia] = useState(false);
  const [justificativaEncerramento, setJustificativaEncerramento] = useState('');
  const [confirmarEncerrarArquivar, setConfirmarEncerrarArquivar] = useState(false);
  const [arquivandoOficial, setArquivandoOficial] = useState(false);
  const [confirmarResetGeral, setConfirmarResetGeral] = useState(false);
  const [manterBaseNoReset, setManterBaseNoReset] = useState(true);
  const [resetandoGeral, setResetandoGeral] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setAgoraMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setHorario1(config.horario_primeira_convocacao);
    setHorario2(config.horario_segunda_convocacao);
    setEscopoAssembleia(config.escopo_assembleia);
    setDescontarInadimplentes(config.descontar_inadimplentes_quorum);
    setMinutosTimerCustom(
      Math.max(1, Math.round((config.timer_duration_seconds || 120) / 60))
    );
  }, [
    config.horario_primeira_convocacao,
    config.horario_segunda_convocacao,
    config.escopo_assembleia,
    config.descontar_inadimplentes_quorum,
    config.timer_duration_seconds,
  ]);

  const configSimulada = useMemo<AssembleiaConfig>(
    () => ({
      ...config,
      assembleia_ativa: true,
      escopo_assembleia: escopoAssembleia,
      descontar_inadimplentes_quorum: descontarInadimplentes,
    }),
    [config, escopoAssembleia, descontarInadimplentes]
  );

  const resumoQuorum = useMemo(
    () => calcularQuorumEscopo(escopoAssembleia, presencas, configSimulada),
    [escopoAssembleia, presencas, configSimulada]
  );

  const estadoRelogio = useMemo(
    () =>
      obterEstadoRelogioCampoGrande(
        {
          convocacao_ativa: config.convocacao_ativa,
          horario_primeira_convocacao: horario1,
          horario_segunda_convocacao: horario2,
        },
        agoraMs
      ),
    [config.convocacao_ativa, horario1, horario2, agoraMs]
  );

  const segundosRestantesTimer = useMemo(() => {
    const duracao = config.timer_duration_seconds || 120;
    if (!config.timer_running || !config.timer_started_at) {
      return duracao;
    }
    const inicio = Date.parse(config.timer_started_at);
    if (Number.isNaN(inicio)) return duracao;
    const decorrido = Math.floor((agoraMs - inicio) / 1000);
    return Math.max(0, duracao - decorrido);
  }, [
    config.timer_duration_seconds,
    config.timer_running,
    config.timer_started_at,
    agoraMs,
  ]);

  const handleTrocarConvocacaoRapida = async (novoStatus: ConvocacaoStatus) => {
    if (salvando || novoStatus === config.convocacao_ativa) return;
    setSalvando(true);
    const res = await onSalvarConfig({
      convocacao_ativa: novoStatus,
      assembleia_ativa: novoStatus !== 'ENCERRADA' ? true : config.assembleia_ativa,
    });
    setSalvando(false);
    onNotificar(res);
  };

  const handleSalvarELiberarCheckin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    const res = await onSalvarConfig({
      assembleia_ativa: true,
      convocacao_ativa:
        config.convocacao_ativa === 'ENCERRADA'
          ? 'AGUARDANDO'
          : config.convocacao_ativa,
      horario_primeira_convocacao: horario1.trim() || '19:00',
      horario_segunda_convocacao: horario2.trim() || '19:30',
      escopo_assembleia: escopoAssembleia,
      descontar_inadimplentes_quorum: descontarInadimplentes,
    });
    setSalvando(false);
    onNotificar(res);
  };

  const handleAlternarBloqueioCheckin = async (ativar: boolean) => {
    setSalvando(true);
    const res = await onSalvarConfig({ assembleia_ativa: ativar });
    setSalvando(false);
    onNotificar({
      ok: res.ok,
      mensagem: ativar
        ? 'Check-in por CPF LIBERADO na tela do morador para o Quórum selecionado!'
        : 'Assembleia desativada: a tela do morador (/) agora informa que não há votação ativa e bloqueia o CPF.',
    });
  };

  const handleSalvarAssembleiaAtual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (salvandoAssembleia) return;
    setSalvandoAssembleia(true);
    const res = await onSalvarAssembleia(tituloAssembleiaSalvar);
    setSalvandoAssembleia(false);
    onNotificar(res);
  };

  const handleExecutarEncerrarEArquivar = async () => {
    if (arquivandoOficial) return;
    setArquivandoOficial(true);
    const res = await onEncerrarEArquivar(justificativaEncerramento, tituloAssembleiaSalvar);
    setArquivandoOficial(false);
    if (res.ok) {
      setConfirmarEncerrarArquivar(false);
      setJustificativaEncerramento('');
    }
    onNotificar(res);
  };

  const handleExecutarResetGeral = async () => {
    if (resetandoGeral) return;
    setResetandoGeral(true);
    const res = await onResetarAssembleia(manterBaseNoReset);
    setResetandoGeral(false);
    setConfirmarResetGeral(false);
    onNotificar(res);
  };

  const metaEscopo = obterMetadadosEscopo(escopoAssembleia);

  return (
    <div className="space-y-6">
      {/* Banner Obrigatório: Passo 1 — Ativação do Quórum e Horários */}
      <section
        className={`rounded-2xl border-2 p-5 shadow-sm ${
          config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA'
            ? 'border-emerald-500 bg-emerald-50/70'
            : 'border-amber-400 bg-amber-50'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`rounded-xl p-2.5 ${
                config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-amber-500 text-slate-950'
              }`}
            >
              {config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA' ? (
                <Unlock className="h-5 w-5" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                {config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA'
                  ? `1º Passo Concluído: Check-in Liberado (${metaEscopo.rotuloCurto})`
                  : '1º Passo Obrigatório: Selecione e Salve o Quórum e Horários para Liberar o Check-in'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-700">
                {config.assembleia_ativa && config.convocacao_ativa !== 'ENCERRADA'
                  ? `A tela do morador (/) está aceitando CPF das unidades pertencentes a: ${metaEscopo.rotuloSelect}.`
                  : 'Neste momento, a Tela Mobile do Morador (/) informa que "Não existe nenhuma votação ativa no momento" e bloqueia a digitação do CPF.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-right">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Hora Local
              </div>
              <div className="font-mono text-lg font-black text-slate-900 tabular-nums">
                {estadoRelogio.horaCampoGrande}
              </div>
            </div>

            {config.assembleia_ativa && (
              <button
                type="button"
                disabled={salvando}
                onClick={() => void handleAlternarBloqueioCheckin(false)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-rose-300 bg-white px-3.5 py-2.5 text-xs font-extrabold text-rose-700 shadow-sm hover:bg-rose-50"
              >
                <Lock className="h-3.5 w-3.5" />
                Bloquear Check-in (/)
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Formulário Principal de Quórum e Horários + Monitor */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <form
          onSubmit={(e) => void handleSalvarELiberarCheckin(e)}
          className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7"
        >
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Definir Quórum Permitido no Check-in &amp; Horários de Convocação
            </h3>
            <p className="text-xs text-slate-500">
              Somente os apartamentos pertencentes ao Quórum selecionado abaixo terão permissão para
              fazer check-in pelo CPF.
            </p>
          </div>

          <div>
            <label
              htmlFor="escopo-geral"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              1. Quórum / Escopo Permitido para Check-in e Votação *
            </label>
            <select
              id="escopo-geral"
              value={escopoAssembleia}
              onChange={(e) => setEscopoAssembleia(e.target.value as EscopoVotacao)}
              className="w-full rounded-xl border-2 border-[#0C0C0D] bg-white px-3.5 py-2.5 text-sm font-extrabold text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
            >
              {ESCOPOS_VOTACAO.map((esc) => (
                <option key={esc} value={esc}>
                  {obterMetadadosEscopo(esc).rotuloSelect}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="horario-1"
                className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-700"
              >
                <Clock className="h-3.5 w-3.5 text-[#A88E61]" />
                2. Início da 1ª Convocação *
              </label>
              <input
                id="horario-1"
                type="time"
                value={horario1}
                onChange={(e) => setHorario1(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm font-bold text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="horario-2"
                className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-700"
              >
                <Clock className="h-3.5 w-3.5 text-[#A88E61]" />
                3. Início da 2ª Convocação *
              </label>
              <input
                id="horario-2"
                type="time"
                value={horario2}
                onChange={(e) => setHorario2(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm font-bold text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <input
              type="checkbox"
              checked={descontarInadimplentes}
              onChange={(e) => setDescontarInadimplentes(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#0C0C0D] focus:ring-[#CCB285]"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900">
                Descontar unidades inadimplentes da base de cálculo da 1ª Convocação
              </span>
              <p className="mt-0.5 text-slate-600">
                Calcula a Maioria Absoluta (50% + 1) sobre o total de unidades adimplentes/aptas no escopo.
              </p>
            </div>
          </label>

          <button
            type="submit"
            disabled={salvando}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0C0C0D] px-5 py-3.5 text-sm font-black uppercase tracking-wider text-[#CCB285] shadow-md transition hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {salvando ? 'Salvando...' : 'Salvar Quórum, Horários e Liberar Check-in'}
          </button>
        </form>

        {/* Monitor de Quórum */}
        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-800">
                <Users className="h-3.5 w-3.5 text-[#A88E61]" />
                Quórum ({metaEscopo.rotuloCurto})
              </span>
              <span className="font-mono text-xs font-bold text-slate-500 tabular-nums">
                {resumoQuorum.percentualPresencaBase.toFixed(1)}% presente
              </span>
            </div>

            <div className="my-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-50 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-slate-500">
                  Presentes no Escopo
                </div>
                <div className="mt-1 font-mono text-2xl font-extrabold text-slate-900 tabular-nums">
                  {resumoQuorum.presentesNoEscopo}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {resumoQuorum.presentesMoradoresNoEscopo} moradores •{' '}
                  {resumoQuorum.presentesConstrutoraNoEscopo} construtora
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-slate-500">
                  Mínimo 1ª Convocação
                </div>
                <div className="mt-1 font-mono text-2xl font-extrabold text-[#A88E61] tabular-nums">
                  {resumoQuorum.minimoPrimeiraConvocacao}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  Base apta: {resumoQuorum.baseConvocadosAptos} de {resumoQuorum.totalFisicoEscopo}
                </div>
              </div>
            </div>

            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  resumoQuorum.atingiuMaioriaAbsoluta ? 'bg-emerald-600' : 'bg-[#CCB285]'
                }`}
                style={{
                  width: `${Math.min(100, resumoQuorum.percentualPresencaBase)}%`,
                }}
              />
            </div>
          </div>

          <div className="mt-5">
            {resumoQuorum.podeAbrirVotacao && config.assembleia_ativa ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-900">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <div>
                  <span className="font-bold">Quórum Válido para Abertura de Pautas!</span>
                  <p className="mt-0.5 text-emerald-800">
                    {config.convocacao_ativa === 'PRIMEIRA'
                      ? `Maioria absoluta atingida (${resumoQuorum.presentesNoEscopo} ≥ ${resumoQuorum.minimoPrimeiraConvocacao}).`
                      : `2ª Convocação instalada — maioria simples dos presentes (${resumoQuorum.presentesNoEscopo} aptos).`}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <span className="font-bold">Status de Abertura de Pauta</span>
                  <p className="mt-0.5 text-amber-800">{resumoQuorum.motivoBloqueio}</p>
                </div>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#A88E61]" />
              <span>
                Inadimplentes no escopo:{' '}
                <strong className="text-slate-700">{resumoQuorum.inadimplentesNoEscopo}</strong>{' '}
                (Total geral público: <strong className="text-slate-700">{config.total_inadimplentes}</strong>)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Seletor de Convocação Ativa + Controle do Contador Regressivo do Telão (Padrão 2 min) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
          <h3 className="text-base font-bold text-slate-900">
            Estágio da Convocação (Controla Cronômetro vs Relógio no Telão)
          </h3>
          <p className="mb-4 text-xs text-slate-500">
            Em <strong>Aguardando Horário</strong>, o <code className="font-mono">/telao</code> exibe
            quanto tempo falta para a 1ª ou 2ª Convocação. Ao mudar para{' '}
            <strong>1ª ou 2ª Convocação Iniciada</strong>, o telão passa a exibir apenas o relógio com
            a hora local.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {OPCOES_CONVOCACAO.map((op) => {
              const ativo = config.convocacao_ativa === op.valor;
              return (
                <button
                  key={op.valor}
                  type="button"
                  disabled={salvando}
                  onClick={() => void handleTrocarConvocacaoRapida(op.valor)}
                  className={`flex flex-col items-start rounded-xl border-2 p-3.5 text-left transition-all ${
                    ativo
                      ? 'border-[#0C0C0D] bg-[#0C0C0D] text-white shadow-md'
                      : 'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-[#CCB285] hover:bg-white'
                  }`}
                >
                  <div className="mb-1 flex w-full items-center justify-between">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        ativo ? 'bg-[#CCB285]' : 'bg-slate-300'
                      }`}
                    />
                    {ativo && (
                      <span className="rounded-full bg-[#CCB285]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#CCB285]">
                        Ativo
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold">{op.titulo}</span>
                  <span
                    className={`mt-0.5 text-[11px] ${
                      ativo ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {op.subtitulo}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Contador Regressivo do Telão (1, 2, 3, 5 min) */}
        <section className="flex flex-col justify-between rounded-2xl border-2 border-[#0C0C0D] bg-[#0C0C0D] p-6 text-white shadow-md lg:col-span-5">
          <div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#CCB285]/20 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-[#CCB285]">
                <Timer className="h-3.5 w-3.5" />
                Contador Regressivo no Telão
              </span>
              <span
                className={`text-xs font-bold uppercase ${
                  config.timer_running ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                {config.timer_running ? '● Decrementando ao vivo' : 'Parado / Pronto'}
              </span>
            </div>

            <div className="my-4 flex items-baseline justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-xs font-semibold text-slate-300">Tempo no Telão:</span>
              <span
                className={`font-mono text-3xl font-black tabular-nums ${
                  segundosRestantesTimer <= 30 && config.timer_running
                    ? 'animate-pulse text-rose-400'
                    : 'text-[#CCB285]'
                }`}
              >
                {formatarSegundosMMSS(segundosRestantesTimer)}
              </span>
            </div>

            <div className="mb-3">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Selecionar Tempo Rápido (Padrão: 2 min)
              </span>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 5].map((min) => {
                  const seg = min * 60;
                  const selecionado = config.timer_duration_seconds === seg;
                  return (
                    <button
                      key={min}
                      type="button"
                      onClick={async () => {
                        setMinutosTimerCustom(min);
                        const res = await onControlarTimer('RESETAR', seg);
                        onNotificar(res);
                      }}
                      className={`rounded-xl border py-2 font-mono text-xs font-extrabold transition ${
                        selecionado
                          ? 'border-[#CCB285] bg-[#CCB285] text-[#0C0C0D]'
                          : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500'
                      }`}
                    >
                      {min} min
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="custom-min" className="text-xs text-slate-300">
                Outro tempo (min):
              </label>
              <input
                id="custom-min"
                type="number"
                min={1}
                max={60}
                value={minutosTimerCustom}
                onChange={(e) =>
                  setMinutosTimerCustom(Math.max(1, Number(e.target.value) || 2))
                }
                className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-center font-mono text-xs font-bold text-white"
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={async () => {
                const res = await onControlarTimer(
                  'INICIAR',
                  minutosTimerCustom * 60
                );
                onNotificar(res);
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-extrabold uppercase text-white transition hover:bg-emerald-500"
            >
              <Play className="h-3.5 w-3.5" />
              Iniciar
            </button>

            <button
              type="button"
              disabled={!config.timer_running}
              onClick={async () => {
                const res = await onControlarTimer('PAUSAR');
                onNotificar(res);
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2.5 text-xs font-extrabold uppercase text-slate-950 transition hover:bg-amber-400 disabled:opacity-40"
            >
              <Pause className="h-3.5 w-3.5" />
              Pausar
            </button>

            <button
              type="button"
              onClick={async () => {
                const res = await onControlarTimer(
                  'RESETAR',
                  minutosTimerCustom * 60
                );
                onNotificar(res);
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs font-extrabold uppercase text-slate-200 transition hover:bg-slate-800"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Zerar
            </button>
          </div>
        </section>
      </div>

      {/* =====================================================================
          SALVAR TUDO QUE FOI VOTADO & RESETAR PARA INICIAR NOVA ASSEMBLEIA
         ===================================================================== */}
      <section className="rounded-2xl border-2 border-slate-300 bg-white p-6 shadow-sm space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-[#0C0C0D] p-2.5 text-[#CCB285]">
              <Archive className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-900">
                Salvar Tudo que Foi Votado &amp; Resetar para Nova Assembleia
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                Salve a assembleia realizada (ex.: <strong>Assembleia 25/04/2026</strong>) com todos os
                check-ins, pautas e votos no histórico e em planilha CSV, e em seguida resete o
                sistema para iniciar uma nova assembleia limpa.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Coluna 1: Salvar Assembleia */}
          <form
            onSubmit={(e) => void handleSalvarAssembleiaAtual(e)}
            className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-slate-50 p-4 lg:col-span-7 space-y-3"
          >
            <div>
              <label
                htmlFor="titulo-assembleia-salvar"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
              >
                1. Nome / Data da Assembleia para Salvar *
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="titulo-assembleia-salvar"
                  type="text"
                  required
                  value={tituloAssembleiaSalvar}
                  onChange={(e) => setTituloAssembleiaSalvar(e.target.value)}
                  placeholder="Ex.: Assembleia 25/04/2026"
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-bold text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={salvandoAssembleia}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition hover:bg-emerald-800 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {salvandoAssembleia
                    ? 'Salvando...'
                    : 'Salvar Tudo que Foi Votado (Banco + CSV)'}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Salva os {presencas.length} check-ins, {pautas.length} pauta(s) e {votos.length}{' '}
                voto(s) no histórico com hash <strong>SHA-256</strong> e baixa o CSV completo.
              </p>
            </div>

            {config.status === 'ativa' && (
              <div className="rounded-xl border border-slate-300 bg-white p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-900">
                    Encerramento Oficial Atômico (Congela + Arquiva SHA-256)
                  </span>
                </div>
                {!confirmarEncerrarArquivar ? (
                  <button
                    type="button"
                    onClick={() => setConfirmarEncerrarArquivar(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#0C0C0D] px-3.5 py-2 text-xs font-extrabold uppercase tracking-wider text-[#CCB285] hover:bg-slate-800"
                  >
                    <Lock className="h-3.5 w-3.5" />
                    Encerrar e Arquivar Assembleia Oficialmente
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={justificativaEncerramento}
                      onChange={(e) => setJustificativaEncerramento(e.target.value)}
                      placeholder="Justificativa formal para a ata (mín. 10 caracteres). Ex.: Ordem do dia concluída..."
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={
                          arquivandoOficial || justificativaEncerramento.trim().length < 10
                        }
                        onClick={() => void handleExecutarEncerrarEArquivar()}
                        className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-rose-800 disabled:opacity-45"
                      >
                        {arquivandoOficial
                          ? 'Arquivando com SHA-256...'
                          : 'Confirmar Encerramento & Arquivamento Oficial'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmarEncerrarArquivar(false);
                          setJustificativaEncerramento('');
                        }}
                        className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-700"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </form>

          {/* Coluna 2: Resetar para Iniciar Nova Assembleia */}
          <div className="flex flex-col justify-between rounded-2xl border border-rose-200 bg-rose-50/50 p-4 lg:col-span-5 space-y-3">
            <div>
              <span className="block text-xs font-bold uppercase tracking-wider text-rose-900">
                2. Resetar Sistema para Iniciar Nova Assembleia
              </span>
              <p className="mt-1 text-xs text-rose-800">
                Limpa todas as pautas, votos e check-ins da assembleia atual e bloqueia novamente a
                tela do morador até o novo Quórum ser salvo.
              </p>

              <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={manterBaseNoReset}
                  onChange={(e) => setManterBaseNoReset(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-[#0C0C0D]"
                />
                <span>Manter cadastro base de condôminos e inadimplentes</span>
              </label>
            </div>

            {!confirmarResetGeral ? (
              <button
                type="button"
                onClick={() => setConfirmarResetGeral(true)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-rose-600 bg-white px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-rose-700 transition hover:bg-rose-600 hover:text-white"
              >
                <RotateCcw className="h-4 w-4" />
                Resetar para Nova Assembleia
              </button>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-400 bg-rose-100 p-2.5">
                <span className="text-xs font-extrabold text-rose-950">
                  Confirmar reset da assembleia?
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={resetandoGeral}
                    onClick={() => void handleExecutarResetGeral()}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-rose-700"
                  >
                    {resetandoGeral ? 'Resetando...' : 'Sim, Resetar Agora'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmarResetGeral(false)}
                    className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Lista de Assembleias Salvas no Histórico */}
        {historicoAssembleias.length > 0 && (
          <div className="border-t border-slate-200 pt-4">
            <h4 className="mb-2.5 text-xs font-extrabold uppercase tracking-wider text-slate-700">
              Histórico de Assembleias Salvas ({historicoAssembleias.length})
            </h4>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {historicoAssembleias.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-extrabold text-slate-900">
                        {item.titulo}
                      </span>
                      {item.tipo_snapshot && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${
                            item.tipo_snapshot === 'final'
                              ? 'bg-[#0C0C0D] text-[#CCB285]'
                              : item.tipo_snapshot === 'pauta_encerrada'
                                ? 'bg-emerald-100 text-emerald-900'
                                : item.tipo_snapshot === 'periodico'
                                  ? 'bg-sky-100 text-sky-900'
                                  : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {item.tipo_snapshot}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {item.total_presentes} presentes • {item.total_pautas} pauta(s) •{' '}
                      {item.total_votos} voto(s)
                    </div>
                    {item.sha256_hash && (
                      <div
                        title={`SHA-256 completo: ${item.sha256_hash}`}
                        className="mt-0.5 font-mono text-[10px] font-semibold text-emerald-800"
                      >
                        SHA-256: {item.sha256_hash.slice(0, 16)}…
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        exportarPacoteCompletoAssembleiaCsv({
                          tituloAssembleia: item.titulo,
                          config: item.dados_snapshot?.config ?? config,
                          presencas: item.dados_snapshot?.presencas ?? [],
                          pautas: item.dados_snapshot?.pautas ?? [],
                          votos: item.dados_snapshot?.votos ?? [],
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-[#0C0C0D] px-2.5 py-1.5 text-[11px] font-bold text-[#CCB285] hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Baixar CSV
                    </button>

                    {item.tipo_snapshot !== 'final' && (
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await onExcluirHistorico(item.id);
                          onNotificar(res);
                        }}
                        title="Excluir snapshot não-oficial"
                        className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
