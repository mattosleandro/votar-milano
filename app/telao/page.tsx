'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Building2,
  CheckCircle2,
  Clock,
  LayoutGrid,
  Maximize2,
  Minimize2,
  ShieldAlert,
  Timer,
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
  formatarSegundosMMSS,
  formatarUnidadeTelaoCompacta,
  obterEstadoRelogioCampoGrande,
  obterMetadadosEscopo,
  TODOS_APARTAMENTOS,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import { APP_PUBLIC_URL } from '@/lib/supabase';
import { OpcaoVoto, PresencaPublica } from '@/lib/types';

type ModoVisualizacaoGrade = 'TODOS_OS_BLOCOS' | 'PRESENTES_APTAS';

interface CelulaUnidadeTelaoProps {
  bloco: number;
  apartamento: number;
  presente: boolean;
  isConstrutora: boolean;
  voto?: OpcaoVoto;
  expandido?: boolean;
}

const CelulaUnidadeTelao = memo(function CelulaUnidadeTelao({
  bloco,
  apartamento,
  presente,
  isConstrutora,
  voto,
  expandido = false,
}: CelulaUnidadeTelaoProps) {
  // Cores semânticas de alto contraste:
  // - SIM: Verde Esmeralda
  // - NÃO: Vermelho Rubi
  // - ABSTENÇÃO: Amarelo Âmbar
  // - PRESENTE (sem voto ainda): Azul Celeste / Ardósia iluminado
  // - AUSENTE: Grafite Escuro discreto (Inadimplentes permanecem 100% indistinguíveis de ausentes para sigilo absoluto)
  let classesCor =
    'bg-slate-900/55 border-slate-800/80 text-slate-500';

  if (voto === 'SIM') {
    classesCor =
      'bg-emerald-600 border-emerald-300 text-white shadow-sm shadow-emerald-950/70';
  } else if (voto === 'NAO') {
    classesCor =
      'bg-rose-600 border-rose-300 text-white shadow-sm shadow-rose-950/70';
  } else if (voto === 'ABSTENCAO') {
    classesCor =
      'bg-amber-400 border-amber-200 text-slate-950 shadow-sm shadow-amber-950/60';
  } else if (presente) {
    classesCor =
      'bg-sky-900/75 border-sky-400/80 text-sky-100 shadow-sm shadow-sky-950/50';
  }

  const destaqueConstrutora = isConstrutora
    ? 'ring-1 ring-milano-gold'
    : '';

  return (
    <div
      title={
        isConstrutora
          ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} (Construtora)`
          : formatarUnidadeTelaoCompacta(bloco, apartamento)
      }
      className={`rounded border transition-colors duration-150 flex items-center justify-center text-center select-none overflow-hidden ${classesCor} ${destaqueConstrutora} ${
        expandido ? 'px-2 py-2 min-h-[42px]' : 'px-0.5 py-0.5 min-h-[18px]'
      }`}
    >
      <span
        className={`font-mono font-extrabold tracking-tighter tabular-nums leading-none whitespace-nowrap ${
          expandido
            ? 'text-xs xl:text-sm 2xl:text-base'
            : 'text-[9px] xl:text-[10px] 2xl:text-xs'
        }`}
      >
        {formatarUnidadeTelaoCompacta(bloco, apartamento)}
      </span>
    </div>
  );
});

export default function PaginaTelao() {
  const {
    config,
    presencas,
    pautaAberta,
    ultimaPautaEncerrada,
    votos,
    statusConexao,
  } = useAssembleiaPublicRealtime('telao');

  const [modoGrade, setModoGrade] = useState<ModoVisualizacaoGrade>('TODOS_OS_BLOCOS');
  const [emTelaCheia, setEmTelaCheia] = useState(false);
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setAgoraMs(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const alternarTelaCheia = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => setEmTelaCheia(true))
        .catch(() => {});
    } else {
      document
        .exitFullscreen()
        .then(() => setEmTelaCheia(false))
        .catch(() => {});
    }
  }, []);

  // Estado do Relógio Oficial de Campo Grande (MS) e Cronômetro para 1ª / 2ª Convocação
  const estadoRelogio = useMemo(
    () => obterEstadoRelogioCampoGrande(config, agoraMs),
    [agoraMs, config]
  );

  // Contador regressivo de deliberação controlado pelo Admin (padrão 2 min = 120s)
  const estadoTimerVotacao = useMemo(() => {
    const duracaoBase = Math.max(0, Number(config.timer_duration_seconds ?? 120));
    if (config.timer_running && config.timer_started_at) {
      const inicioMs = Date.parse(config.timer_started_at);
      if (!Number.isNaN(inicioMs)) {
        const decorridos = Math.max(0, Math.floor((agoraMs - inicioMs) / 1000));
        const restantes = Math.max(0, duracaoBase - decorridos);
        return {
          rodando: true,
          esgotado: restantes === 0,
          alertaFinal: restantes > 0 && restantes <= 30,
          segundosRestantes: restantes,
          formatado: formatarSegundosMMSS(restantes),
        };
      }
    }
    return {
      rodando: false,
      esgotado: false,
      alertaFinal: false,
      segundosRestantes: duracaoBase,
      formatado: formatarSegundosMMSS(duracaoBase),
    };
  }, [agoraMs, config.timer_duration_seconds, config.timer_running, config.timer_started_at]);

  // Pauta exibida no projetor: prioriza a pauta aberta; se não houver, mostra a última encerrada
  const pautaExibida = pautaAberta ?? ultimaPautaEncerrada;
  const escopoAtivo = pautaExibida ? pautaExibida.escopo : config.escopo_assembleia;
  const metaEscopo = useMemo(() => obterMetadadosEscopo(escopoAtivo), [escopoAtivo]);

  // Contadores de presença por Fase e Total
  const contadoresPresenca = useMemo(() => {
    let fase1 = 0;
    let fase2 = 0;
    let construtora = 0;
    for (const p of presencas) {
      if (p.fase === 1) fase1 += 1;
      else if (p.fase === 2) fase2 += 1;
      if (p.is_construtora) construtora += 1;
    }
    return {
      total: presencas.length,
      fase1,
      fase2,
      construtora,
    };
  }, [presencas]);

  const resumoQuorum = useMemo(
    () => calcularQuorumEscopo(escopoAtivo, presencas, config),
    [config, escopoAtivo, presencas]
  );

  const placar = useMemo(() => {
    if (!pautaExibida) return null;
    return calcularPlacarPauta(pautaExibida, presencas, votos);
  }, [pautaExibida, presencas, votos]);

  // Mapa O(1) de presenças (Zero PII)
  const mapaPresencas = useMemo(() => {
    const mapa = new Map<string, PresencaPublica>();
    for (const p of presencas) {
      mapa.set(chaveUnidade(p.bloco, p.apartamento), p);
    }
    return mapa;
  }, [presencas]);

  // Mapa O(1) de votos da pauta exibida
  const mapaVotosPauta = useMemo(() => {
    const mapa = new Map<string, OpcaoVoto>();
    if (!pautaExibida) return mapa;
    for (const v of votos) {
      if (v.pauta_id === pautaExibida.id) {
        mapa.set(chaveUnidade(v.bloco, v.apartamento), v.voto);
      }
    }
    return mapa;
  }, [pautaExibida, votos]);

  // Unidades presentes aptas dentro do escopo ativo
  const unidadesPresentesAptas = useMemo(
    () => presencas.filter((p) => unidadePertenceAoEscopo(p, escopoAtivo)),
    [escopoAtivo, presencas]
  );

  const dominioLegivel = useMemo(() => {
    try {
      return new URL(APP_PUBLIC_URL).host;
    } catch {
      return 'votar.portalmilano.com';
    }
  }, []);

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-slate-950 text-white flex flex-col lg:flex-row">
      {/* =====================================================================
          BARRA LATERAL ESQUERDA FIXA: MARCA, RELÓGIO CAMPO GRANDE, QR CODE E QUÓRUM
         ===================================================================== */}
      <aside className="w-full lg:w-[295px] 2xl:w-[345px] shrink-0 bg-[#0C0C0D] border-b lg:border-b-0 lg:border-r border-milano-gold/25 p-3.5 2xl:p-5 flex flex-col justify-between gap-3">
        <div className="space-y-3">
          {/* Topo: Logo Oficial Branca + Dourada e Status WebSocket */}
          <div className="flex items-center justify-between gap-2">
            <MilanoLogo variant="dark" className="h-8 2xl:h-10 w-auto" />
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                  statusConexao === 'AO_VIVO'
                    ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/40'
                    : 'bg-amber-950/90 text-amber-300 border-amber-500/40'
                }`}
              >
                {statusConexao === 'AO_VIVO' ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <Wifi className="w-3 h-3" />
                    <span>AO VIVO</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3 h-3 animate-pulse" />
                    <span>SYNC</span>
                  </>
                )}
              </span>

              <button
                type="button"
                onClick={alternarTelaCheia}
                title="Alternar Tela Cheia (Projetor 16:9)"
                className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700/80 transition"
              >
                {emTelaCheia ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Cronômetro de Convocação OU Relógio Local */}
          <div className="rounded-xl bg-slate-900/95 border border-milano-gold/40 px-3.5 py-2.5 shadow-md">
            {estadoRelogio.emContagemRegressiva ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-milano-gold-light">
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-milano-gold animate-pulse" />
                    Início da {estadoRelogio.alvoConvocacao === 'PRIMEIRA' ? '1ª' : '2ª'} Convocação
                  </span>
                  <span className="font-mono text-slate-400">
                    {estadoRelogio.alvoConvocacao === 'PRIMEIRA'
                      ? config.horario_primeira_convocacao
                      : config.horario_segunda_convocacao}
                  </span>
                </div>
                <div className="flex items-baseline justify-between tabular-nums">
                  <span className="text-2xl 2xl:text-3xl font-black font-mono text-white tracking-tight">
                    -{estadoRelogio.textoContagem}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    {estadoRelogio.horaCampoGrande}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 tabular-nums">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-milano-gold-light flex items-center gap-1">
                    <Clock className="w-3 h-3 text-milano-gold" />
                    Hora Local
                  </p>
                  <p className="text-2xl 2xl:text-3xl font-black font-mono text-white tracking-tight mt-0.5">
                    {estadoRelogio.horaCampoGrande}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* QR Code de Alta Nitidez para Projeção */}
          <div className="rounded-2xl bg-slate-900/90 border border-milano-gold/35 p-3 2xl:p-4 text-center space-y-2 shadow-lg">
            <p className="text-[11px] 2xl:text-xs font-bold uppercase tracking-widest text-milano-gold-light">
              Aponte a Câmera para Check-in / Voto
            </p>
            <div className="bg-white p-2.5 rounded-xl inline-flex items-center justify-center shadow-inner mx-auto">
              <QRCodeSVG
                value={APP_PUBLIC_URL}
                size={140}
                level="H"
                marginSize={1}
                bgColor="#FFFFFF"
                fgColor="#0C0C0D"
                imageSettings={{
                  src: '/brand/logo-mark.png',
                  height: 30,
                  width: 30,
                  excavate: true,
                }}
              />
            </div>
            <div>
              <p className="text-sm 2xl:text-base font-extrabold font-mono text-milano-gold tracking-tight">
                {dominioLegivel}
              </p>
            </div>
          </div>

          {/* Status das Convocações & Quórum */}
          <div className="rounded-xl bg-slate-900/75 border border-slate-800 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Convocação
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-extrabold uppercase ${
                  config.convocacao_ativa === 'PRIMEIRA'
                    ? 'bg-milano-gold text-[#0C0C0D]'
                    : config.convocacao_ativa === 'SEGUNDA'
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-slate-800 text-slate-300'
                }`}
              >
                {config.convocacao_ativa === 'PRIMEIRA'
                  ? `1ª Conv. (${config.horario_primeira_convocacao})`
                  : config.convocacao_ativa === 'SEGUNDA'
                    ? `2ª Conv. (${config.horario_segunda_convocacao})`
                    : config.convocacao_ativa === 'ENCERRADA'
                      ? 'Encerrada'
                      : 'Aguardando'}
              </span>
            </div>

            <div className="text-[11px] text-slate-300 flex items-center justify-between tabular-nums">
              <span>
                {config.convocacao_ativa === 'PRIMEIRA'
                  ? `Maioria Absoluta (mín. ${resumoQuorum.minimoPrimeiraConvocacao})`
                  : config.convocacao_ativa === 'SEGUNDA'
                    ? 'Maioria Simples (presentes)'
                    : `1ª ${config.horario_primeira_convocacao} | 2ª ${config.horario_segunda_convocacao}`}
              </span>
              <span className="font-mono font-bold text-white">
                {resumoQuorum.percentualPresencaBase.toFixed(1)}%
              </span>
            </div>

            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  resumoQuorum.podeAbrirVotacao ? 'bg-emerald-400' : 'bg-milano-gold'
                }`}
                style={{
                  width: `${Math.min(100, resumoQuorum.percentualPresencaBase)}%`,
                }}
              />
            </div>
          </div>
        </div>

        {/* Contadores ao Vivo de Unidades Presentes + Total Agregado de Inadimplentes */}
        <div className="space-y-2">
          <div className="rounded-xl bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-milano-gold" />
                Presentes
              </span>
              {contadoresPresenca.construtora > 0 ? (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-milano-gold/15 text-milano-gold-light border border-milano-gold/30 tabular-nums">
                  +{contadoresPresenca.construtora} Construtora
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-baseline gap-2 tabular-nums">
              <span className="text-2xl 2xl:text-3xl font-extrabold font-mono text-white">
                {contadoresPresenca.total}
              </span>
              <span className="text-xs font-mono text-slate-400">
                / {metaEscopo.totalUnidades} no escopo (544 total)
              </span>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1.5 tabular-nums">
              <div className="rounded-lg bg-slate-950/80 border border-slate-800 px-2.5 py-1.5">
                <p className="text-[10px] font-semibold text-slate-400">Fase 1</p>
                <p className="text-sm 2xl:text-base font-extrabold font-mono text-white">
                  {contadoresPresenca.fase1}
                  <span className="text-[10px] font-normal text-slate-500">/256</span>
                </p>
              </div>
              <div className="rounded-lg bg-slate-950/80 border border-slate-800 px-2.5 py-1.5">
                <p className="text-[10px] font-semibold text-slate-400">Fase 2</p>
                <p className="text-sm 2xl:text-base font-extrabold font-mono text-white">
                  {contadoresPresenca.fase2}
                  <span className="text-[10px] font-normal text-slate-500">/288</span>
                </p>
              </div>
            </div>
          </div>

          {/* Indicador Público Obrigatório: APENAS Quantidade Total de Inadimplentes */}
          <div className="rounded-xl bg-amber-950/35 border border-amber-500/30 px-3 py-2 flex items-center justify-between gap-2 tabular-nums">
            <span className="text-[11px] font-semibold text-amber-200/90 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              Inadimplentes (sem voto)
            </span>
            <span className="text-base font-extrabold font-mono text-amber-300">
              {config.total_inadimplentes}
            </span>
          </div>
        </div>
      </aside>

      {/* =====================================================================
          ÁREA PRINCIPAL: TOPO COM CRONÔMETRO DE VOTAÇÃO + PLACAR + MATRIZ Bxx | Axxx
         ===================================================================== */}
      <main className="flex-1 flex flex-col min-w-0 p-3 2xl:p-4 gap-2.5 2xl:gap-3 lg:overflow-hidden">
        {/* Topo Compacto: Pauta Ativa + Cronômetro Regressivo (2 min) + Placar em Linha */}
        <section className="rounded-2xl bg-[#0C0C0D] border border-slate-800 px-4 py-3 2xl:px-5 2xl:py-3.5 shadow-lg shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Esquerda: Badges e Título da Pauta */}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {pautaAberta ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-xs font-extrabold uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    VOTAÇÃO ABERTA • PAUTA #{pautaAberta.ordem}
                  </span>
                ) : pautaExibida ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-xs font-extrabold uppercase tracking-wider">
                    <CheckCircle2 className="w-3.5 h-3.5 text-milano-gold" />
                    ENCERRADA • PAUTA #{pautaExibida.ordem}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-milano-gold/15 border border-milano-gold/40 text-milano-gold-light text-xs font-extrabold uppercase tracking-wider">
                    {config.assembleia_ativa
                      ? 'CREDENCIAMENTO LIBERADO'
                      : 'AGUARDANDO ABERTURA PELA MESA'}
                  </span>
                )}

                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-milano-gold text-[#0C0C0D] text-xs font-black uppercase tracking-wide shadow">
                  <Building2 className="w-3.5 h-3.5 shrink-0" />
                  {metaEscopo.badgeTelao}
                </span>

                {placar &&
                (pautaExibida?.status === 'encerrada' || estadoTimerVotacao.esgotado) &&
                placar.totalVotosRegistrados > 0 ? (
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-black uppercase tracking-wider shadow-md border ${
                      placar.vencedor === 'SIM'
                        ? 'bg-emerald-500 text-slate-950 border-emerald-200 animate-pulse'
                        : placar.vencedor === 'NAO'
                          ? 'bg-rose-500 text-white border-rose-200 animate-pulse'
                          : 'bg-amber-400 text-slate-950 border-amber-200'
                    }`}
                  >
                    {placar.vencedor === 'SIM'
                      ? `★ VENCEDOR: MAIORIA SIM (${placar.sim} × ${placar.nao})`
                      : placar.vencedor === 'NAO'
                        ? `★ VENCEDOR: MAIORIA NÃO (${placar.nao} × ${placar.sim})`
                        : `EMPATE (${placar.sim} × ${placar.nao})`}
                  </span>
                ) : null}
              </div>

              <h1 className="text-lg sm:text-xl 2xl:text-2xl font-extrabold text-white tracking-tight truncate">
                {pautaExibida
                  ? pautaExibida.titulo
                  : 'Digite seu CPF em votar.portalmilano.com para confirmar presença'}
              </h1>
            </div>

            {/* Centro: Contador Regressivo de Deliberação (Padrão 02:00) */}
            <div
              className={`px-4 py-2 rounded-xl border flex items-center gap-3 tabular-nums transition-colors ${
                estadoTimerVotacao.esgotado
                  ? 'bg-rose-950/90 border-rose-500 text-rose-200 animate-pulse'
                  : estadoTimerVotacao.alertaFinal
                    ? 'bg-amber-950/90 border-amber-400 text-amber-200 animate-pulse'
                    : estadoTimerVotacao.rodando
                      ? 'bg-emerald-950/75 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900 border-slate-700 text-slate-300'
              }`}
            >
              <Timer className="w-6 h-6 text-milano-gold shrink-0" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-85">
                  {estadoTimerVotacao.esgotado
                    ? 'Tempo Esgotado'
                    : estadoTimerVotacao.rodando
                      ? 'Tempo de Votação'
                      : 'Timer Votação'}
                </p>
                <p className="text-2xl 2xl:text-3xl font-black font-mono leading-none text-white">
                  {estadoTimerVotacao.formatado}
                </p>
              </div>
            </div>

            {/* Direita: Placar Compacto de Alto Contraste (SIM, NÃO e NÃO VOTOU/ABSTENÇÃO com Destaque do Vencedor) */}
            {placar ? (
              (() => {
                const mostrarVencedor =
                  pautaExibida?.status === 'encerrada' || estadoTimerVotacao.esgotado;
                const simVenceu = mostrarVencedor && placar.vencedor === 'SIM';
                const naoVenceu = mostrarVencedor && placar.vencedor === 'NAO';

                return (
                  <div className="grid grid-cols-3 gap-2.5 tabular-nums shrink-0">
                    <div
                      className={`rounded-xl px-3.5 py-1.5 min-w-[115px] 2xl:min-w-[138px] transition-all ${
                        simVenceu
                          ? 'bg-emerald-900/90 border-2 border-milano-gold ring-2 ring-emerald-400/50 shadow-lg shadow-emerald-950'
                          : 'bg-emerald-950/70 border border-emerald-500/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px] font-black text-emerald-300">
                        <span className="flex items-center gap-1">
                          SIM
                          {simVenceu ? (
                            <span className="px-1.5 py-0.5 rounded bg-milano-gold text-[#0C0C0D] text-[9px] font-black uppercase">
                              ★ MAIORIA
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono">{placar.pctSimValidos.toFixed(0)}%</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-xl 2xl:text-2xl font-black font-mono text-white leading-tight">
                          {placar.sim}
                        </p>
                        <span className="text-[10px] font-semibold text-emerald-300/80 font-mono">
                          {placar.pctSim.toFixed(0)}% pres.
                        </span>
                      </div>
                    </div>

                    <div
                      className={`rounded-xl px-3.5 py-1.5 min-w-[115px] 2xl:min-w-[138px] transition-all ${
                        naoVenceu
                          ? 'bg-rose-900/90 border-2 border-milano-gold ring-2 ring-rose-400/50 shadow-lg shadow-rose-950'
                          : 'bg-rose-950/70 border border-rose-500/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px] font-black text-rose-300">
                        <span className="flex items-center gap-1">
                          NÃO
                          {naoVenceu ? (
                            <span className="px-1.5 py-0.5 rounded bg-milano-gold text-[#0C0C0D] text-[9px] font-black uppercase">
                              ★ MAIORIA
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono">{placar.pctNaoValidos.toFixed(0)}%</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-xl 2xl:text-2xl font-black font-mono text-white leading-tight">
                          {placar.nao}
                        </p>
                        <span className="text-[10px] font-semibold text-rose-300/80 font-mono">
                          {placar.pctNao.toFixed(0)}% pres.
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl bg-amber-950/60 border border-amber-400/45 px-3.5 py-1.5 min-w-[120px] 2xl:min-w-[144px]">
                      <div className="flex items-center justify-between gap-1 text-[11px] font-black text-amber-300">
                        <span>NÃO VOTOU (ABST.)</span>
                        <span className="font-mono">{placar.pctNaoVotaram.toFixed(0)}%</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-xl 2xl:text-2xl font-black font-mono text-amber-100 leading-tight">
                          {placar.naoVotaram}
                        </p>
                        <span className="text-[10px] font-semibold text-amber-300/80">
                          Imparciais
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : null}
          </div>
        </section>

        {/* MATRIZ ULTRA-COMPACTA DE TRANSPARÊNCIA: TODOS OS BLOCOS CABENDO NA TELA (Bxx | Axxx) */}
        <section className="flex-1 min-h-0 rounded-2xl bg-[#0C0C0D] border border-slate-800 px-3.5 py-2.5 2xl:px-4 2xl:py-3 flex flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2 border-b border-slate-800/90 shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs 2xl:text-sm font-bold text-white">
                {modoGrade === 'TODOS_OS_BLOCOS'
                  ? `Painel Integral em Tempo Real (${metaEscopo.totalBlocos} Blocos • ${metaEscopo.totalUnidades} Unidades)`
                  : `Unidades Presentes Aptas no Escopo (${unidadesPresentesAptas.length})`}
              </h2>
              <span className="text-[11px] text-slate-400 hidden sm:inline">
                • Formato compacto Bxx | Axxx (Zero Nome / Zero CPF)
              </span>
            </div>

            {/* Legenda de Cores Semânticas + Alternador de Modo */}
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 border border-emerald-300" />
                SIM
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-rose-600 border border-rose-300" />
                NÃO
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-sky-900 border border-sky-400" />
                PRESENTE / NÃO VOTOU (ABST.)
              </span>
              <span className="inline-flex items-center gap-1 text-slate-500">
                <span className="w-2.5 h-2.5 rounded-sm bg-slate-900 border border-slate-800" />
                AUSENTE
              </span>

              <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-900 border border-slate-800 gap-1 ml-1">
                <button
                  type="button"
                  onClick={() => setModoGrade('TODOS_OS_BLOCOS')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition flex items-center gap-1 ${
                    modoGrade === 'TODOS_OS_BLOCOS'
                      ? 'bg-milano-gold text-[#0C0C0D]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <LayoutGrid className="w-3 h-3" />
                  Todos os Blocos ({metaEscopo.totalUnidades})
                </button>
                <button
                  type="button"
                  onClick={() => setModoGrade('PRESENTES_APTAS')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
                    modoGrade === 'PRESENTES_APTAS'
                      ? 'bg-milano-gold text-[#0C0C0D]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Apenas Presentes ({unidadesPresentesAptas.length})
                </button>
              </div>
            </div>
          </div>

          {modoGrade === 'TODOS_OS_BLOCOS' ? (
            /* MATRIZ INTEGRAL 16 COLUNAS (APTOS 101..404) × N LINHAS (BLOCOS DO ESCOPO) — CABE 100% NA TELA SEM SCROLL */
            <div
              className="flex-1 min-h-0 grid gap-[3px] overflow-y-auto lg:overflow-hidden"
              style={{
                gridTemplateColumns: 'repeat(16, minmax(0, 1fr))',
                gridTemplateRows: `repeat(${metaEscopo.blocos.length}, minmax(0, 1fr))`,
              }}
            >
              {metaEscopo.blocos.map((bloco) =>
                TODOS_APARTAMENTOS.map((apto) => {
                  const ch = chaveUnidade(bloco, apto);
                  const presenca = mapaPresencas.get(ch);
                  return (
                    <CelulaUnidadeTelao
                      key={ch}
                      bloco={bloco}
                      apartamento={apto}
                      presente={Boolean(presenca)}
                      isConstrutora={Boolean(presenca?.is_construtora)}
                      voto={mapaVotosPauta.get(ch)}
                      expandido={false}
                    />
                  );
                })
              )}
            </div>
          ) : (
            /* MODO FOCADO: APENAS UNIDADES PRESENTES APTAS */
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
              {unidadesPresentesAptas.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center text-slate-500 space-y-2">
                  <Users className="w-10 h-10 text-milano-gold/50" />
                  <p className="text-base font-semibold text-slate-300">
                    Aguardando credenciamento de unidades para este escopo
                  </p>
                  <p className="text-xs text-slate-500">
                    Assim que os moradores confirmarem presença pelo CPF em {dominioLegivel}, as
                    unidades aparecerão instantaneamente aqui.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 2xl:grid-cols-14 gap-2">
                  {unidadesPresentesAptas.map((u) => (
                    <CelulaUnidadeTelao
                      key={u.id}
                      bloco={u.bloco}
                      apartamento={u.apartamento}
                      presente={true}
                      isConstrutora={u.is_construtora}
                      voto={mapaVotosPauta.get(chaveUnidade(u.bloco, u.apartamento))}
                      expandido={true}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
