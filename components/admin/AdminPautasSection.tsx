'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckSquare,
  CircleDot,
  Download,
  Lock,
  Pause,
  Play,
  Plus,
  PlusCircle,
  RotateCcw,
  Square,
  ThumbsUp,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import {
  calcularPlacarPauta,
  calcularQuorumEscopo,
  ESCOPOS_VOTACAO,
  formatarSegundosMMSS,
  obterMetadadosEscopo,
  obterOpcoesPauta,
  obterPaletaOpcaoMultipla,
  obterTipoVotacaoPauta,
} from '@/lib/condominio';
import { exportarAuditoriaVotosCsv } from '@/lib/csv';
import {
  AssembleiaConfig,
  EscopoVotacao,
  PautaAssembleia,
  PresencaAdmin,
  TipoVotacaoPauta,
  VotoUnidade,
} from '@/lib/types';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminPautasSectionProps {
  config: AssembleiaConfig;
  pautas: readonly PautaAssembleia[];
  presencas: readonly PresencaAdmin[];
  votos: readonly VotoUnidade[];
  onCriarPauta: (params: {
    titulo: string;
    descricao: string;
    escopo: EscopoVotacao;
    tipo_votacao?: TipoVotacaoPauta;
    opcoes?: string[];
    max_escolhas?: number;
  }) => Promise<ResultadoOperacaoAdmin>;
  onAbrirPauta: (pautaId: string) => Promise<ResultadoOperacaoAdmin>;
  onEncerrarPauta: (pautaId: string) => Promise<ResultadoOperacaoAdmin>;
  onResetarPauta: (
    pautaId: string,
    reabrir: boolean,
    justificativa: string
  ) => Promise<ResultadoOperacaoAdmin>;
  onExcluirPauta: (pautaId: string) => Promise<ResultadoOperacaoAdmin>;
  onControlarTimer?: (
    acao: 'INICIAR' | 'PAUSAR' | 'RESETAR',
    duracaoSegundos?: number
  ) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

export function AdminPautasSection({
  config,
  pautas,
  presencas,
  votos,
  onCriarPauta,
  onAbrirPauta,
  onEncerrarPauta,
  onResetarPauta,
  onExcluirPauta,
  onControlarTimer,
  onNotificar,
}: AdminPautasSectionProps) {
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [escopo, setEscopo] = useState<EscopoVotacao>(config.escopo_assembleia || 'TODOS');
  const [tipoVotacao, setTipoVotacao] = useState<TipoVotacaoPauta>('SIM_NAO');
  const [opcoesTexto, setOpcoesTexto] = useState<string[]>(['', '']);
  const [maxEscolhas, setMaxEscolhas] = useState<number>(2);
  const [criando, setCriando] = useState(false);

  const [pautaEmOperacaoId, setPautaEmOperacaoId] = useState<string | null>(null);
  const [confirmarResetId, setConfirmarResetId] = useState<string | null>(null);
  const [justificativaNovaRodada, setJustificativaNovaRodada] = useState('');
  const [confirmarExclusaoId, setConfirmarExclusaoId] = useState<string | null>(null);
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setAgoraMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const estadoTimer = useMemo(() => {
    const duracao = config.timer_duration_seconds || 120;
    if (!config.timer_running || !config.timer_started_at) {
      return {
        restante: duracao,
        formatado: formatarSegundosMMSS(duracao),
        rodando: false,
        esgotado: false,
      };
    }
    const inicio = Date.parse(config.timer_started_at);
    const decorrido = Number.isNaN(inicio) ? 0 : Math.floor((agoraMs - inicio) / 1000);
    const restante = Math.max(0, duracao - decorrido);
    return {
      restante,
      formatado: formatarSegundosMMSS(restante),
      rodando: restante > 0,
      esgotado: restante === 0,
    };
  }, [
    config.timer_duration_seconds,
    config.timer_running,
    config.timer_started_at,
    agoraMs,
  ]);

  const handleSubmitNovaPauta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (criando) return;
    setCriando(true);
    const opcoesLimpas = opcoesTexto.map((o) => o.trim()).filter(Boolean);
    const res = await onCriarPauta({
      titulo,
      descricao,
      escopo,
      tipo_votacao: tipoVotacao,
      opcoes: tipoVotacao === 'SIM_NAO' ? [] : opcoesLimpas,
      max_escolhas:
        tipoVotacao === 'MULTIPLA_VARIAS'
          ? Math.min(Math.max(2, maxEscolhas), Math.max(2, opcoesLimpas.length))
          : 1,
    });
    setCriando(false);
    onNotificar(res);
    if (res.ok) {
      setTitulo('');
      setDescricao('');
      setTipoVotacao('SIM_NAO');
      setOpcoesTexto(['', '']);
      setMaxEscolhas(2);
    }
  };

  const adicionarOpcaoCampo = () => {
    if (opcoesTexto.length >= 10) return;
    setOpcoesTexto((atual) => [...atual, '']);
  };

  const removerOpcaoCampo = (idx: number) => {
    if (opcoesTexto.length <= 2) return;
    setOpcoesTexto((atual) => {
      const nova = atual.filter((_, i) => i !== idx);
      setMaxEscolhas((m) => Math.min(m, nova.length));
      return nova;
    });
  };

  const executarAcaoPauta = async (
    pautaId: string,
    acao: () => Promise<ResultadoOperacaoAdmin>
  ) => {
    setPautaEmOperacaoId(pautaId);
    const res = await acao();
    setPautaEmOperacaoId(null);
    setConfirmarResetId(null);
    setJustificativaNovaRodada('');
    setConfirmarExclusaoId(null);
    onNotificar(res);
  };

  return (
    <div className="space-y-6">
      {/* Formulário de Nova Pauta */}
      <form
        onSubmit={(e) => void handleSubmitNovaPauta(e)}
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900">Cadastrar Nova Pauta de Votação</h2>
          <p className="text-sm text-slate-600">
            Cadastre previamente todas as pautas da ordem do dia ou adicione novas deliberações ao vivo.
            Apenas <strong>1 pauta</strong> pode ficar aberta por vez.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <label
              htmlFor="pauta-titulo"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              Título da Pauta *
            </label>
            <input
              id="pauta-titulo"
              type="text"
              required
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Ex.: 1. Aprovação da Previsão Orçamentária e Taxa Condominial 2026/2027"
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-[#0C0C0D] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
            />
          </div>

          <div className="lg:col-span-5">
            <label
              htmlFor="pauta-escopo"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              Escopo de Quem Pode Votar *
            </label>
            <select
              id="pauta-escopo"
              value={escopo}
              onChange={(e) => setEscopo(e.target.value as EscopoVotacao)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-[#0C0C0D] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
            >
              {ESCOPOS_VOTACAO.map((esc) => (
                <option key={esc} value={esc}>
                  {obterMetadadosEscopo(esc).rotuloSelect}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-12">
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700">
              Formato de Votação *
            </label>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => setTipoVotacao('SIM_NAO')}
                className={`flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition ${
                  tipoVotacao === 'SIM_NAO'
                    ? 'border-[#0C0C0D] bg-[#0C0C0D] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-slate-300'
                }`}
              >
                <ThumbsUp
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    tipoVotacao === 'SIM_NAO' ? 'text-[#CCB285]' : 'text-slate-500'
                  }`}
                />
                <div>
                  <div className="text-xs font-extrabold">SIM / NÃO (Padrão)</div>
                  <div
                    className={`text-[11px] ${
                      tipoVotacao === 'SIM_NAO' ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Aprovar ou Rejeitar a proposta
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTipoVotacao('MULTIPLA_UNICA')}
                className={`flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition ${
                  tipoVotacao === 'MULTIPLA_UNICA'
                    ? 'border-[#0C0C0D] bg-[#0C0C0D] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-slate-300'
                }`}
              >
                <CircleDot
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    tipoVotacao === 'MULTIPLA_UNICA' ? 'text-[#CCB285]' : 'text-slate-500'
                  }`}
                />
                <div>
                  <div className="text-xs font-extrabold">Múltipla Escolha — 1 Opção</div>
                  <div
                    className={`text-[11px] ${
                      tipoVotacao === 'MULTIPLA_UNICA' ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Cada unidade escolhe apenas 1 alternativa
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTipoVotacao('MULTIPLA_VARIAS')}
                className={`flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition ${
                  tipoVotacao === 'MULTIPLA_VARIAS'
                    ? 'border-[#0C0C0D] bg-[#0C0C0D] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-slate-300'
                }`}
              >
                <CheckSquare
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    tipoVotacao === 'MULTIPLA_VARIAS' ? 'text-[#CCB285]' : 'text-slate-500'
                  }`}
                />
                <div>
                  <div className="text-xs font-extrabold">Múltipla Escolha — Várias</div>
                  <div
                    className={`text-[11px] ${
                      tipoVotacao === 'MULTIPLA_VARIAS' ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Permite marcar até N alternativas
                  </div>
                </div>
              </button>
            </div>
          </div>

          {tipoVotacao !== 'SIM_NAO' && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 space-y-3 lg:col-span-12">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-extrabold uppercase tracking-wider text-slate-800">
                    Alternativas da Votação ({opcoesTexto.length} / 10)
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Cadastre entre 2 e 10 opções claras (ex.: Chapa 1, Empresa A, Horário 19h...).
                  </p>
                </div>

                {tipoVotacao === 'MULTIPLA_VARIAS' && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5">
                    <label
                      htmlFor="pauta-max-escolhas"
                      className="text-xs font-bold text-slate-700"
                    >
                      Máx. opções por unidade:
                    </label>
                    <select
                      id="pauta-max-escolhas"
                      value={Math.min(maxEscolhas, opcoesTexto.length)}
                      onChange={(e) => setMaxEscolhas(Number(e.target.value))}
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-0.5 font-mono text-xs font-black text-slate-900"
                    >
                      {Array.from({ length: Math.max(1, opcoesTexto.length - 1) }, (_, i) => i + 2).map(
                        (num) => (
                          <option key={num} value={num}>
                            Até {num} {num === opcoesTexto.length ? '(todas)' : 'opções'}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {opcoesTexto.map((val, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#0C0C0D] font-mono text-xs font-black text-[#CCB285]">
                      {String.fromCharCode(65 + idx)}
                    </span>
                    <input
                      type="text"
                      required
                      value={val}
                      onChange={(e) => {
                        const novoValor = e.target.value;
                        setOpcoesTexto((atual) =>
                          atual.map((item, i) => (i === idx ? novoValor : item))
                        );
                      }}
                      placeholder={`Texto da opção ${String.fromCharCode(65 + idx)}`}
                      className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-[#0C0C0D] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
                    />
                    {opcoesTexto.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removerOpcaoCampo(idx)}
                        aria-label={`Remover opção ${String.fromCharCode(65 + idx)}`}
                        className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {opcoesTexto.length < 10 && (
                <button
                  type="button"
                  onClick={adicionarOpcaoCampo}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-400 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-[#0C0C0D] hover:text-slate-950"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Adicionar Opção {String.fromCharCode(65 + opcoesTexto.length)}
                </button>
              )}
            </div>
          )}

          <div className="lg:col-span-9">
            <label
              htmlFor="pauta-descricao"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              Descrição / Resumo Explicativo (Opcional — exibido no celular do morador)
            </label>
            <input
              id="pauta-descricao"
              type="text"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder={
                tipoVotacao === 'SIM_NAO'
                  ? 'Ex.: SIM aprova a proposta apresentada pela administradora; NÃO rejeita a proposta.'
                  : 'Ex.: Escolha a empresa ou alternativa de sua preferência para o condomínio.'
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 focus:border-[#0C0C0D] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
            />
          </div>

          <div className="flex items-end lg:col-span-3">
            <button
              type="submit"
              disabled={criando}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0C0C0D] px-4 py-2.5 text-sm font-bold text-[#CCB285] shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
            >
              <PlusCircle className="h-4 w-4" />
              {criando ? 'Adicionando...' : 'Adicionar Pauta'}
            </button>
          </div>
        </div>
      </form>

      {/* Lista de Pautas */}
      <div className="space-y-4">
        {pautas.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm font-semibold text-slate-700">
              Nenhuma pauta cadastrada até o momento.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Utilize o formulário acima para preparar a ordem do dia da Assembleia.
            </p>
          </div>
        ) : (
          pautas.map((pauta) => {
            const metaEscopo = obterMetadadosEscopo(pauta.escopo);
            const placar = calcularPlacarPauta(pauta, presencas, votos);
            const quorumPauta = calcularQuorumEscopo(pauta.escopo, presencas, config);
            const emOperacao = pautaEmOperacaoId === pauta.id;
            const aberta = pauta.status === 'aberta';
            const encerrada = pauta.status === 'encerrada';

            return (
              <article
                key={pauta.id}
                className={`rounded-2xl border-2 bg-white p-5 shadow-sm transition ${
                  aberta
                    ? 'border-emerald-500 ring-4 ring-emerald-500/10'
                    : encerrada
                      ? 'border-slate-200 bg-slate-50/40'
                      : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-slate-900 px-2 py-0.5 font-mono text-xs font-bold text-[#CCB285]">
                        #{String(pauta.ordem).padStart(2, '0')}
                      </span>

                      <span className="rounded-md border border-slate-300 bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-extrabold text-slate-800">
                        Rodada {pauta.rodada ?? 1}
                      </span>

                      {aberta && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-extrabold uppercase tracking-wider text-emerald-800">
                          <span className="h-2 w-2 animate-ping rounded-full bg-emerald-600" />
                          Votação Aberta Ao Vivo
                        </span>
                      )}

                      {pauta.status === 'aguardando' && (
                        <span className="rounded-full bg-slate-100 px-3 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700">
                          Aguardando Abertura
                        </span>
                      )}

                      {encerrada && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-3 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-800">
                          <Lock className="h-3 w-3" />
                          Encerrada (Votos Congelados)
                        </span>
                      )}

                      <span className="rounded-full border border-[#CCB285]/60 bg-[#CCB285]/15 px-3 py-0.5 text-xs font-bold text-slate-900">
                        Escopo: {metaEscopo.rotuloCurto} ({metaEscopo.totalUnidades} aptos)
                      </span>

                      {obterTipoVotacaoPauta(pauta) !== 'SIM_NAO' && (
                        <span className="rounded-full border border-indigo-300 bg-indigo-50 px-3 py-0.5 text-xs font-extrabold text-indigo-900">
                          {obterTipoVotacaoPauta(pauta) === 'MULTIPLA_UNICA'
                            ? `Múltipla Escolha • 1 opção (${obterOpcoesPauta(pauta).length} alt.)`
                            : `Múltipla Escolha • até ${pauta.max_escolhas ?? obterOpcoesPauta(pauta).length} opções`}
                        </span>
                      )}
                    </div>

                    <h3 className="text-base font-extrabold text-slate-900 sm:text-lg">
                      {pauta.titulo}
                    </h3>
                    {pauta.descricao && (
                      <p className="text-xs text-slate-600 sm:text-sm">{pauta.descricao}</p>
                    )}
                    {(pauta.rodada ?? 1) > 1 && (
                      <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                        Histórico preservado: Rodada anterior mantida intacta para auditoria (
                        {
                          votos.filter(
                            (v) =>
                              v.pauta_id === pauta.id && (v.rodada ?? 1) < (pauta.rodada ?? 1)
                          ).length
                        }{' '}
                        voto(s) arquivados).
                        {pauta.motivo_ultima_rodada
                          ? ` Motivo: "${pauta.motivo_ultima_rodada}"`
                          : ''}
                      </p>
                    )}
                  </div>

                  {/* Botão CSV individual */}
                  <button
                    type="button"
                    onClick={() =>
                      exportarAuditoriaVotosCsv({
                        pautas,
                        votos,
                        presencas,
                        pautaIdFiltro: pauta.id,
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV Pauta ({placar.totalVotosRegistrados})
                  </button>
                </div>

                {/* Barra de Cronômetro Rápido para Pauta Aberta */}
                {aberta && onControlarTimer && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-900 px-4 py-2.5 text-white">
                    <div className="flex items-center gap-2.5">
                      <Timer className="h-4 w-4 text-[#CCB285]" />
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                        Cronômetro no Telão:
                      </span>
                      <span
                        className={`font-mono text-lg font-extrabold tabular-nums ${
                          estadoTimer.esgotado
                            ? 'text-rose-400 animate-pulse'
                            : estadoTimer.rodando
                              ? 'text-emerald-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {estadoTimer.formatado}
                      </span>
                      {estadoTimer.esgotado && (
                        <span className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-extrabold uppercase">
                          Tempo Esgotado
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          void onControlarTimer('INICIAR', config.timer_duration_seconds || 120).then(
                            onNotificar
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-500"
                      >
                        <Play className="h-3 w-3" />
                        Iniciar / Reiniciar
                      </button>
                      <button
                        type="button"
                        onClick={() => void onControlarTimer('PAUSAR').then(onNotificar)}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-amber-500"
                      >
                        <Pause className="h-3 w-3" />
                        Pausar
                      </button>
                      <button
                        type="button"
                        onClick={() => void onControlarTimer('INICIAR', 60).then(onNotificar)}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-bold text-[#CCB285] hover:bg-slate-700"
                      >
                        +1 min
                      </button>
                      <button
                        type="button"
                        onClick={() => void onControlarTimer('RESETAR', 120).then(onNotificar)}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-bold text-slate-300 hover:bg-slate-700"
                      >
                        Resetar 02:00
                      </button>
                    </div>
                  </div>
                )}

                {/* Mini-Placar ao Vivo (SIM/NÃO ou Múltipla Escolha + Destaque do Vencedor) */}
                {(() => {
                  const mostrarVencedor = encerrada || (aberta && estadoTimer.esgotado);
                  const isMultiplaPauta = placar.tipoVotacao !== 'SIM_NAO';
                  const simVenceu = !isMultiplaPauta && mostrarVencedor && placar.vencedor === 'SIM';
                  const naoVenceu = !isMultiplaPauta && mostrarVencedor && placar.vencedor === 'NAO';
                  const empatou = mostrarVencedor && placar.vencedor === 'EMPATE';
                  const vencedorasMultipla = placar.opcoes.filter((o) => o.ehVencedora);

                  if (isMultiplaPauta) {
                    return (
                      <div className="mt-4 space-y-2.5">
                        {mostrarVencedor && placar.totalVotosRegistrados > 0 && (
                          <div
                            className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 px-4 py-2 text-xs font-extrabold uppercase tracking-wider ${
                              empatou
                                ? 'border-amber-600 bg-amber-400 text-slate-950'
                                : 'border-[#CCB285] bg-[#0C0C0D] text-white'
                            }`}
                          >
                            <span>
                              {empatou
                                ? `EMPATE TÉCNICO: ${vencedorasMultipla
                                    .map((o) => `${o.sigla} — ${o.label}`)
                                    .join(' × ')}`
                                : `★ MAIS VOTADA: ${vencedorasMultipla
                                    .map((o) => `${o.sigla} — ${o.label}`)
                                    .join(', ')}`}
                            </span>
                            <span className="font-mono">
                              {placar.totalVotosRegistrados} votantes • Não votaram: {placar.naoVotaram}
                            </span>
                          </div>
                        )}

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {placar.opcoes.map((opt, idx) => {
                            const paleta = obterPaletaOpcaoMultipla(idx);
                            const venceu = mostrarVencedor && opt.ehVencedora;
                            return (
                              <div
                                key={opt.id}
                                className={`rounded-xl p-3 border transition ${
                                  venceu
                                    ? 'border-2 border-[#0C0C0D] bg-slate-900 text-white shadow-sm'
                                    : 'border-slate-200 bg-slate-50 text-slate-900'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2 text-xs font-bold">
                                  <span className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-black shrink-0 ${
                                        venceu
                                          ? 'bg-[#CCB285] text-[#0C0C0D]'
                                          : 'bg-[#0C0C0D] text-[#CCB285]'
                                      }`}
                                    >
                                      {opt.sigla}
                                    </span>
                                    <span className="truncate">{opt.label}</span>
                                  </span>
                                  <span className="font-mono font-extrabold shrink-0 tabular-nums">
                                    {opt.votos} ({opt.pctVotantes.toFixed(1)}%)
                                  </span>
                                </div>
                                <div
                                  className={`mt-2 h-2 w-full rounded-full overflow-hidden ${
                                    venceu ? 'bg-white/15' : 'bg-slate-200'
                                  }`}
                                >
                                  <div
                                    className={`h-full rounded-full transition-all duration-300 ${paleta.barClass}`}
                                    style={{ width: `${Math.min(100, opt.pctVotantes)}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2 flex items-center justify-between text-xs font-bold text-amber-950 tabular-nums">
                          <span>NÃO VOTOU (ABSTENÇÃO / IMPARCIAL)</span>
                          <span className="font-mono">
                            {placar.naoVotaram} ({placar.pctNaoVotaram.toFixed(1)}%) •{' '}
                            {placar.totalVotosRegistrados}/{placar.presentesAptos} presentes votaram
                          </span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className="mt-4 space-y-2.5">
                      {mostrarVencedor && placar.totalVotosRegistrados > 0 && (
                        <div
                          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 px-4 py-2 text-xs font-extrabold uppercase tracking-wider ${
                            simVenceu
                              ? 'border-emerald-700 bg-emerald-600 text-white'
                              : naoVenceu
                                ? 'border-rose-700 bg-rose-600 text-white'
                                : 'border-amber-600 bg-amber-400 text-slate-950'
                          }`}
                        >
                          <span>
                            {simVenceu
                              ? '★ VENCEDOR • MAIORIA SIM (APROVADO)'
                              : naoVenceu
                                ? '★ VENCEDOR • MAIORIA NÃO (REJEITADO)'
                                : 'EMPATE TÉCNICO'}
                          </span>
                          <span className="font-mono">
                            SIM: {placar.sim} ({placar.pctSimValidos.toFixed(1)}%) × NÃO:{' '}
                            {placar.nao} ({placar.pctNaoValidos.toFixed(1)}%) • Não votaram (Abst.):{' '}
                            {placar.naoVotaram}
                          </span>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 items-stretch">
                        <div
                          className={`rounded-xl px-3.5 py-2.5 flex flex-col justify-between min-h-[72px] transition ${
                            simVenceu
                              ? 'border-2 border-emerald-600 bg-emerald-100/90 ring-2 ring-emerald-500/30 shadow-sm'
                              : 'border border-emerald-200 bg-emerald-50/70'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] font-bold uppercase text-emerald-900">
                            <span>{simVenceu ? '★ SIM (MAIORIA)' : 'SIM'}</span>
                            <span className="font-mono">
                              {placar.pctSimValidos.toFixed(1)}% válidos
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-baseline justify-between font-mono tabular-nums">
                            <span className="text-2xl font-extrabold text-emerald-700">
                              {placar.sim}
                            </span>
                            <span className="text-xs font-bold text-emerald-800/80">
                              {placar.pctSim.toFixed(1)}% dos presentes
                            </span>
                          </div>
                        </div>

                        <div
                          className={`rounded-xl px-3.5 py-2.5 flex flex-col justify-between min-h-[72px] transition ${
                            naoVenceu
                              ? 'border-2 border-rose-600 bg-rose-100/90 ring-2 ring-rose-500/30 shadow-sm'
                              : 'border border-rose-200 bg-rose-50/70'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] font-bold uppercase text-rose-900">
                            <span>{naoVenceu ? '★ NÃO (MAIORIA)' : 'NÃO'}</span>
                            <span className="font-mono">
                              {placar.pctNaoValidos.toFixed(1)}% válidos
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-baseline justify-between font-mono tabular-nums">
                            <span className="text-2xl font-extrabold text-rose-700">
                              {placar.nao}
                            </span>
                            <span className="text-xs font-bold text-rose-800/80">
                              {placar.pctNao.toFixed(1)}% dos presentes
                            </span>
                          </div>
                        </div>

                        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 flex flex-col justify-between min-h-[72px]">
                          <div className="flex items-center justify-between text-[11px] font-bold uppercase text-amber-900">
                            <span>NÃO VOTOU (ABSTENÇÃO)</span>
                            <span className="font-mono">{placar.pctNaoVotaram.toFixed(1)}%</span>
                          </div>
                          <div className="mt-0.5 flex items-baseline justify-between font-mono tabular-nums">
                            <span className="text-2xl font-extrabold text-amber-700">
                              {placar.naoVotaram}
                            </span>
                            <span className="text-xs font-bold text-amber-800/80">
                              de {placar.presentesAptos} presentes aptos
                            </span>
                          </div>
                        </div>
                      </div>

                      {empatou && (
                        <p className="text-xs font-bold text-amber-800">
                          Empate técnico entre SIM ({placar.sim}) e NÃO ({placar.nao}).
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Alerta de bloqueio de quórum quando não está aberta */}
                {!aberta && !quorumPauta.podeAbrirVotacao && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                    <span>{quorumPauta.motivoBloqueio}</span>
                  </div>
                )}

                {/* Controles da Mesa */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {!aberta && (
                      <button
                        type="button"
                        disabled={emOperacao || !quorumPauta.podeAbrirVotacao}
                        onClick={() =>
                          void executarAcaoPauta(pauta.id, () => onAbrirPauta(pauta.id))
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-extrabold uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {encerrada ? 'Reabrir Votação (Manter Votos)' : 'Abrir Votação Agora'}
                      </button>
                    )}

                    {aberta && (
                      <button
                        type="button"
                        disabled={emOperacao}
                        onClick={() =>
                          void executarAcaoPauta(pauta.id, () => onEncerrarPauta(pauta.id))
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-extrabold uppercase tracking-wide text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-50"
                      >
                        <Square className="h-3.5 w-3.5" />
                        Encerrar Votação (Congelar Votos)
                      </button>
                    )}

                    {confirmarResetId === pauta.id ? (
                      <div className="flex w-full flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-extrabold text-amber-950">
                            Iniciar Rodada {(pauta.rodada ?? 1) + 1} (os {placar.totalVotosRegistrados}{' '}
                            voto(s) da Rodada {pauta.rodada ?? 1} serão PRESERVADOS na auditoria)
                          </span>
                        </div>
                        <input
                          type="text"
                          value={justificativaNovaRodada}
                          onChange={(e) => setJustificativaNovaRodada(e.target.value)}
                          placeholder="Justificativa obrigatória para a ata (mín. 10 caracteres). Ex.: Falha de projeção durante leitura..."
                          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={emOperacao || justificativaNovaRodada.trim().length < 10}
                            onClick={() =>
                              void executarAcaoPauta(pauta.id, () =>
                                onResetarPauta(pauta.id, false, justificativaNovaRodada)
                              )
                            }
                            className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-45"
                          >
                            Nova Rodada (Aguardando)
                          </button>
                          <button
                            type="button"
                            disabled={
                              emOperacao ||
                              !quorumPauta.podeAbrirVotacao ||
                              justificativaNovaRodada.trim().length < 10
                            }
                            onClick={() =>
                              void executarAcaoPauta(pauta.id, () =>
                                onResetarPauta(pauta.id, true, justificativaNovaRodada)
                              )
                            }
                            className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-bold text-[#CCB285] hover:bg-slate-800 disabled:opacity-40"
                          >
                            Nova Rodada e Abrir Agora
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmarResetId(null);
                              setJustificativaNovaRodada('');
                            }}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={emOperacao}
                        onClick={() => {
                          setConfirmarResetId(pauta.id);
                          setJustificativaNovaRodada('');
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Nova Rodada (Não-Destrutivo)
                      </button>
                    )}
                  </div>

                  {/* Excluir Pauta */}
                  {!aberta && (
                    <div>
                      {confirmarExclusaoId === pauta.id ? (
                        <div className="flex items-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5">
                          <span className="text-xs font-bold text-rose-900">Excluir pauta?</span>
                          <button
                            type="button"
                            disabled={emOperacao}
                            onClick={() =>
                              void executarAcaoPauta(pauta.id, () => onExcluirPauta(pauta.id))
                            }
                            className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-700"
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmarExclusaoId(null)}
                            className="px-2 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
                          >
                            Não
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={emOperacao}
                          onClick={() => setConfirmarExclusaoId(pauta.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Excluir
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

