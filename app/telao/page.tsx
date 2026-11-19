'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Building2,
  CheckCircle2,
  Clock,
  FileCheck2,
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
  formatarBloco,
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
  onlineConectado: boolean;
  isConstrutora: boolean;
  comProcuracao: boolean;
  voto?: OpcaoVoto;
  mostrarBlocoPrefix?: boolean;
  expandido?: boolean;
}

const CelulaUnidadeTelao = memo(function CelulaUnidadeTelao({
  bloco,
  apartamento,
  presente,
  onlineConectado,
  isConstrutora,
  comProcuracao,
  voto,
  mostrarBlocoPrefix = false,
  expandido = false,
}: CelulaUnidadeTelaoProps) {
  // Cores semânticas de alto contraste:
  // - SIM: Verde Esmeralda
  // - NÃO: Vermelho Rubi
  // - CONECTADO (Validou CPF no site / Construtora): Azul Celeste
  // - CONFIRMADO (Liberado na Portaria, aguardando abrir o site): Violeta / Roxo
  // - AUSENTE: Grafite Escuro discreto
  let classesCor = 'bg-slate-900/65 border-slate-800/90 text-slate-500';

  if (voto === 'SIM') {
    classesCor =
      'bg-emerald-600 border-emerald-300 text-white shadow-sm shadow-emerald-950/80';
  } else if (voto === 'NAO') {
    classesCor =
      'bg-rose-600 border-rose-300 text-white shadow-sm shadow-rose-950/80';
  } else if (presente && (onlineConectado || isConstrutora)) {
    classesCor =
      'bg-sky-600 border-sky-300 text-white shadow-sm shadow-sky-950/70';
  } else if (presente) {
    classesCor =
      'bg-violet-600 border-violet-300 text-white shadow-sm shadow-violet-950/70';
  }

  const destaqueEspecial = isConstrutora
    ? 'ring-1 ring-milano-gold'
    : comProcuracao
      ? 'ring-1 ring-amber-300'
      : '';

  const tituloTooltip = isConstrutora
    ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} (Construtora)`
    : comProcuracao
      ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} (Com Procuração)`
      : formatarUnidadeTelaoCompacta(bloco, apartamento);

  return (
    <div
      title={tituloTooltip}
      className={`relative rounded border transition-colors duration-150 flex items-center justify-center gap-0.5 text-center select-none overflow-hidden ${classesCor} ${destaqueEspecial} ${
        expandido
          ? 'px-2 py-2 min-h-[42px]'
          : 'px-0.5 py-0.5 min-h-[20px] sm:min-h-[22px] xl:min-h-[19px] 2xl:min-h-[22px]'
      }`}
    >
      <span
        className={`font-mono font-extrabold tracking-tight tabular-nums leading-none whitespace-nowrap ${
          expandido
            ? 'text-xs xl:text-sm 2xl:text-base'
            : 'text-[10px] sm:text-[11px] xl:text-[10px] 2xl:text-xs'
        }`}
      >
        {mostrarBlocoPrefix
          ? formatarUnidadeTelaoCompacta(bloco, apartamento)
          : String(apartamento)}
      </span>

      {/* Marca visual identificando unidade representada por Procuração */}
      {comProcuracao && (
        <span
          title="Unidade representada por Procuração"
          className={`inline-flex items-center justify-center rounded bg-amber-300 text-[#0C0C0D] font-black leading-none shrink-0 shadow-xs ${
            expandido
              ? 'px-1.5 py-0.5 text-[10px] ml-1'
              : 'px-1 py-[1px] text-[8px] 2xl:text-[9px]'
          }`}
        >
          {expandido ? 'PROC' : 'P'}
        </span>
      )}

      {/* Marca visual identificando Construtora no modo expandido */}
      {isConstrutora && expandido && (
        <span className="inline-flex items-center justify-center rounded bg-milano-gold text-[#0C0C0D] font-black leading-none px-1.5 py-0.5 text-[10px] ml-1 shrink-0">
          CONST
        </span>
      )}
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
  const [painelMaximizado, setPainelMaximizado] = useState(false);
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setAgoraMs(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const alternarMaximizarPainel = useCallback(() => {
    setPainelMaximizado((atual) => {
      const proximo = !atual;
      if (proximo && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (!proximo && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      return proximo;
    });
  }, []);

  // Estado do Relógio e Cronômetro para 1ª / 2ª Convocação
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

  // Contadores de presença por Fase, Confirmados Portaria, Conectados Online e Procurações
  const contadoresPresenca = useMemo(() => {
    let fase1 = 0;
    let fase2 = 0;
    let construtora = 0;
    let confirmadosPortaria = 0;
    let conectadosOnline = 0;
    let comProcuracao = 0;
    for (const p of presencas) {
      if (p.fase === 1) fase1 += 1;
      else if (p.fase === 2) fase2 += 1;
      if (p.is_construtora) {
        construtora += 1;
      } else {
        if (p.confirmado_portaria !== false) confirmadosPortaria += 1;
        if (p.online_conectado) conectadosOnline += 1;
        if (p.com_procuracao) comProcuracao += 1;
      }
    }
    return {
      total: presencas.length,
      fase1,
      fase2,
      construtora,
      confirmadosPortaria,
      conectadosOnline,
      comProcuracao,
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

  // Classes de Grid 100% Responsivas para Datashow (4:3, 16:10, 16:9), Tablets e Monitores
  const classesGridResponsivoBlocos = useMemo(() => {
    const qtd = metaEscopo.blocos.length;
    if (qtd > 20) {
      // 34 blocos: adapta suavemente de 1/2/3/4 colunas (celular/tablet) até 6/7 colunas (monitores/datashow)
      return painelMaximizado
        ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7'
        : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';
    }
    if (qtd > 12) {
      // 16 ou 18 blocos (Fase 1 ou Fase 2)
      return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6';
    }
    // 7 a 11 blocos (Módulos 1 a 4)
    return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
  }, [metaEscopo.blocos.length, painelMaximizado]);

  return (
    <div className="min-h-screen xl:h-screen xl:overflow-hidden bg-slate-950 text-white flex flex-col xl:flex-row">
      {/* =====================================================================
          BARRA LATERAL ESQUERDA (Responsiva em Tablets / Fixa em Datashow Widescreen)
          Oculta quando o painel está maximizado em Tela Inteira
         ===================================================================== */}
      {!painelMaximizado && (
        <aside className="w-full xl:w-[285px] 2xl:w-[330px] shrink-0 bg-[#0C0C0D] border-b xl:border-b-0 xl:border-r border-milano-gold/25 p-3 2xl:p-4 flex flex-col justify-between gap-3">
          {/* Topo: Logo Oficial Branca + Dourada e Status WebSocket */}
          <div className="flex items-center justify-between gap-2">
            <MilanoLogo variant="dark" className="h-8 2xl:h-9 w-auto" />
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
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
          </div>

          {/* Em tablets/telas médias (< xl), organiza os widgets em grade horizontal; em xl+ empilha verticalmente */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-1 gap-2.5 flex-1">
            {/* Cronômetro de Convocação OU Relógio Local */}
            <div className="rounded-xl bg-slate-900/95 border border-milano-gold/40 px-3 py-2.5 shadow-md flex flex-col justify-center">
              {estadoRelogio.emContagemRegressiva ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-milano-gold-light">
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-milano-gold animate-pulse" />
                      Início da {estadoRelogio.alvoConvocacao === 'PRIMEIRA' ? '1ª' : '2ª'}{' '}
                      Convocação
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
            <div className="rounded-2xl bg-slate-900/90 border border-milano-gold/35 p-2.5 2xl:p-3.5 text-center space-y-1.5 shadow-lg flex flex-col items-center justify-center">
              <p className="text-[10px] 2xl:text-xs font-bold uppercase tracking-widest text-milano-gold-light">
                Aponte a Câmera para Validar e Votar
              </p>
              <div className="bg-white p-2 rounded-xl inline-flex items-center justify-center shadow-inner">
                <QRCodeSVG
                  value={APP_PUBLIC_URL}
                  size={124}
                  level="H"
                  marginSize={1}
                  bgColor="#FFFFFF"
                  fgColor="#0C0C0D"
                  imageSettings={{
                    src: '/brand/logo-mark.png',
                    height: 26,
                    width: 26,
                    excavate: true,
                  }}
                />
              </div>
              <p className="text-xs 2xl:text-sm font-extrabold font-mono text-milano-gold tracking-tight">
                {dominioLegivel}
              </p>
            </div>

            {/* Status das Convocações & Quórum */}
            <div className="rounded-xl bg-slate-900/75 border border-slate-800 p-3 space-y-2 flex flex-col justify-center">
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

            {/* Contadores ao Vivo de Unidades Presentes + Procurações + Inadimplentes */}
            <div className="space-y-2 flex flex-col justify-between">
              <div className="rounded-xl bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-milano-gold" />
                    Presentes Confirmados
                  </span>
                  {contadoresPresenca.construtora > 0 ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-milano-gold/15 text-milano-gold-light border border-milano-gold/30 tabular-nums">
                      +{contadoresPresenca.construtora} Const.
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 tabular-nums">
                  <span className="text-2xl font-extrabold font-mono text-white">
                    {contadoresPresenca.total}
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    / {metaEscopo.totalUnidades} no escopo
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-3 gap-1 tabular-nums">
                  <div className="rounded-lg bg-violet-950/50 border border-violet-500/40 px-2 py-1">
                    <p className="text-[9px] font-semibold text-violet-300">Portaria</p>
                    <p className="text-xs 2xl:text-sm font-extrabold font-mono text-white">
                      {contadoresPresenca.confirmadosPortaria}
                    </p>
                  </div>
                  <div className="rounded-lg bg-sky-950/50 border border-sky-500/40 px-2 py-1">
                    <p className="text-[9px] font-semibold text-sky-300">Conectados</p>
                    <p className="text-xs 2xl:text-sm font-extrabold font-mono text-white">
                      {contadoresPresenca.conectadosOnline}
                    </p>
                  </div>
                  <div className="rounded-lg bg-amber-950/50 border border-amber-400/40 px-2 py-1">
                    <p className="text-[9px] font-semibold text-amber-300">Procuração</p>
                    <p className="text-xs 2xl:text-sm font-extrabold font-mono text-amber-200">
                      {contadoresPresenca.comProcuracao}
                    </p>
                  </div>
                </div>
              </div>

              {/* Indicador Público Obrigatório: APENAS Quantidade Total de Inadimplentes */}
              <div className="rounded-xl bg-amber-950/35 border border-amber-500/30 px-3 py-1.5 flex items-center justify-between gap-2 tabular-nums">
                <span className="text-[11px] font-semibold text-amber-200/90 flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  Inadimplentes (sem voto)
                </span>
                <span className="text-sm font-extrabold font-mono text-amber-300">
                  {config.total_inadimplentes}
                </span>
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* =====================================================================
          ÁREA PRINCIPAL: TOPO COM CRONÔMETRO DE VOTAÇÃO + PLACAR + PAINEL AGRUPADO POR BLOCO
         ===================================================================== */}
      <main className="flex-1 flex flex-col min-w-0 p-2 sm:p-2.5 2xl:p-3.5 gap-2 sm:gap-2.5 xl:overflow-hidden">
        {/* Topo Compacto: Pauta Ativa + Cronômetro Regressivo (2 min) + Placar em Linha */}
        <section className="rounded-2xl bg-[#0C0C0D] border border-slate-800 px-3.5 py-2.5 2xl:px-5 2xl:py-3 shadow-lg shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Esquerda: Badges e Título da Pauta */}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {pautaAberta ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-xs font-extrabold uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    VOTAÇÃO ABERTA • PAUTA #{pautaAberta.ordem}
                  </span>
                ) : pautaExibida ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-xs font-extrabold uppercase tracking-wider">
                    <CheckCircle2 className="w-3.5 h-3.5 text-milano-gold" />
                    ENCERRADA • PAUTA #{pautaExibida.ordem}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-milano-gold/15 border border-milano-gold/40 text-milano-gold-light text-xs font-extrabold uppercase tracking-wider">
                    {config.assembleia_ativa
                      ? 'CREDENCIAMENTO LIBERADO'
                      : 'AGUARDANDO ABERTURA PELA MESA'}
                  </span>
                )}

                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-milano-gold text-[#0C0C0D] text-xs font-black uppercase tracking-wide shadow">
                  <Building2 className="w-3.5 h-3.5 shrink-0" />
                  {metaEscopo.badgeTelao}
                </span>

                {placar &&
                (pautaExibida?.status === 'encerrada' || estadoTimerVotacao.esgotado) &&
                placar.totalVotosRegistrados > 0 ? (
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-0.5 rounded-md text-xs font-black uppercase tracking-wider shadow-md border ${
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

              <h1 className="text-sm sm:text-base 2xl:text-xl font-extrabold text-white tracking-tight truncate">
                {pautaExibida
                  ? pautaExibida.titulo
                  : 'Confirme presença na recepção e acesse votar.portalmilano.com'}
              </h1>
            </div>

            {/* Centro: Contador Regressivo de Deliberação (Padrão 02:00) */}
            <div
              className={`px-3 py-1.5 rounded-xl border flex items-center gap-2.5 tabular-nums transition-colors ${
                estadoTimerVotacao.esgotado
                  ? 'bg-rose-950/90 border-rose-500 text-rose-200 animate-pulse'
                  : estadoTimerVotacao.alertaFinal
                    ? 'bg-amber-950/90 border-amber-400 text-amber-200 animate-pulse'
                    : estadoTimerVotacao.rodando
                      ? 'bg-emerald-950/75 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900 border-slate-700 text-slate-300'
              }`}
            >
              <Timer className="w-5 h-5 text-milano-gold shrink-0" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-85">
                  {estadoTimerVotacao.esgotado
                    ? 'Tempo Esgotado'
                    : estadoTimerVotacao.rodando
                      ? 'Tempo de Votação'
                      : 'Timer Votação'}
                </p>
                <p className="text-xl 2xl:text-2xl font-black font-mono leading-none text-white">
                  {estadoTimerVotacao.formatado}
                </p>
              </div>
            </div>

            {/* Direita: Placar Compacto de Alto Contraste */}
            {placar ? (
              (() => {
                const mostrarVencedor =
                  pautaExibida?.status === 'encerrada' || estadoTimerVotacao.esgotado;
                const simVenceu = mostrarVencedor && placar.vencedor === 'SIM';
                const naoVenceu = mostrarVencedor && placar.vencedor === 'NAO';

                return (
                  <div className="grid grid-cols-3 gap-2 tabular-nums w-full sm:w-auto shrink-0">
                    <div
                      className={`rounded-xl px-3 py-1 min-w-[98px] 2xl:min-w-[130px] transition-all ${
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
                        <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-white leading-tight">
                          {placar.sim}
                        </p>
                        <span className="text-[10px] font-semibold text-emerald-300/80 font-mono">
                          {placar.pctSim.toFixed(0)}% pres.
                        </span>
                      </div>
                    </div>

                    <div
                      className={`rounded-xl px-3 py-1 min-w-[98px] 2xl:min-w-[130px] transition-all ${
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
                        <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-white leading-tight">
                          {placar.nao}
                        </p>
                        <span className="text-[10px] font-semibold text-rose-300/80 font-mono">
                          {placar.pctNao.toFixed(0)}% pres.
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl bg-amber-950/60 border border-amber-400/45 px-3 py-1 min-w-[104px] 2xl:min-w-[136px]">
                      <div className="flex items-center justify-between gap-1 text-[11px] font-black text-amber-300">
                        <span>NÃO VOTOU</span>
                        <span className="font-mono">{placar.pctNaoVotaram.toFixed(0)}%</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-amber-100 leading-tight">
                          {placar.naoVotaram}
                        </p>
                        <span className="text-[10px] font-semibold text-amber-300/80">
                          Abst.
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : null}
          </div>
        </section>

        {/* PAINEL INTEGRAL RESPONSIVO AGRUPADO POR BLOCO COM MARCA DE PROCURAÇÃO [P] E TELA INTEIRA */}
        <section className="flex-1 min-h-0 rounded-2xl bg-[#0C0C0D] border border-slate-800 px-3 py-2.5 2xl:px-4 2xl:py-3 flex flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2 border-b border-slate-800/90 shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs sm:text-sm 2xl:text-base font-extrabold text-white">
                {modoGrade === 'TODOS_OS_BLOCOS'
                  ? `Painel Integral em Tempo Real (${metaEscopo.totalBlocos} Blocos • ${metaEscopo.totalUnidades} Unidades)`
                  : `Unidades Presentes Aptas no Escopo (${unidadesPresentesAptas.length})`}
              </h2>
            </div>

            {/* Legenda de Cores Semânticas + Marca de Procuração [P] + Alternador + Botão Tela Inteira */}
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 text-[11px] font-bold text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-emerald-600 border border-emerald-300" />
                SIM
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-rose-600 border border-rose-300" />
                NÃO
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-sky-600 border border-sky-300" />
                CONECTADO
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-sm bg-violet-600 border border-violet-300" />
                CONFIRMADO (PORTARIA)
              </span>
              <span className="inline-flex items-center gap-1 text-amber-300">
                <span className="inline-flex items-center justify-center px-1 py-[1px] rounded bg-amber-300 text-[#0C0C0D] font-black text-[9px] leading-none">
                  P
                </span>
                PROCURAÇÃO ({contadoresPresenca.comProcuracao})
              </span>
              <span className="inline-flex items-center gap-1 text-slate-500">
                <span className="w-3 h-3 rounded-sm bg-slate-900 border border-slate-800" />
                AUSENTE
              </span>

              <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-900 border border-slate-800 gap-1">
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
                  Por Bloco ({metaEscopo.totalBlocos})
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

              {/* Botão no Canto Superior Direito para Maximizar em Tela Inteira */}
              <button
                type="button"
                onClick={alternarMaximizarPainel}
                title="Maximizar Painel Integral em Tela Inteira"
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-extrabold uppercase tracking-wide border transition shadow-sm ${
                  painelMaximizado
                    ? 'bg-milano-gold text-[#0C0C0D] border-milano-gold-light'
                    : 'bg-slate-900 text-milano-gold border-milano-gold/50 hover:bg-slate-800'
                }`}
              >
                {painelMaximizado ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>Restaurar Painel</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>Tela Inteira</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {modoGrade === 'TODOS_OS_BLOCOS' ? (
            /* PAINEL RESPONSIVO AGRUPADO POR BLOCO (ADAPTA A TABLETS, MONITORES E DATASHOWS 4:3 / 16:9) */
            <div
              className={`flex-1 min-h-0 grid ${classesGridResponsivoBlocos} auto-rows-fr gap-2 overflow-y-auto pr-0.5 custom-scrollbar`}
            >
              {metaEscopo.blocos.map((bloco) => {
                let presentesNoBloco = 0;
                let procuracoesNoBloco = 0;
                for (const apto of TODOS_APARTAMENTOS) {
                  const pr = mapaPresencas.get(chaveUnidade(bloco, apto));
                  if (pr) {
                    presentesNoBloco += 1;
                    if (pr.com_procuracao) procuracoesNoBloco += 1;
                  }
                }

                return (
                  <div
                    key={bloco}
                    className={`rounded-xl border p-1.5 2xl:p-2 flex flex-col justify-between transition-colors ${
                      presentesNoBloco > 0
                        ? 'bg-slate-900/65 border-milano-gold/50 shadow-sm'
                        : 'bg-slate-950/90 border-slate-800/90'
                    }`}
                  >
                    {/* Cabeçalho Destacado do Bloco */}
                    <div className="flex items-center justify-between px-1 pb-1 mb-1 border-b border-slate-800/90 shrink-0">
                      <span className="font-mono text-xs 2xl:text-sm font-black tracking-wide text-milano-gold">
                        BLOCO {formatarBloco(bloco)}
                      </span>
                      <div className="flex items-center gap-1">
                        {procuracoesNoBloco > 0 && (
                          <span
                            title={`${procuracoesNoBloco} procuração(ões) neste bloco`}
                            className="inline-flex items-center gap-0.5 rounded bg-amber-300/20 border border-amber-300/50 px-1 py-0.2 font-mono text-[9px] font-black text-amber-300"
                          >
                            <FileCheck2 className="w-2.5 h-2.5" />
                            {procuracoesNoBloco}P
                          </span>
                        )}
                        <span
                          className={`font-mono text-[10px] 2xl:text-xs font-extrabold px-1.5 py-0.2 rounded ${
                            presentesNoBloco > 0
                              ? 'bg-milano-gold/20 text-milano-gold-light'
                              : 'text-slate-600'
                          }`}
                        >
                          {presentesNoBloco}/16
                        </span>
                      </div>
                    </div>

                    {/* Grade 4x4 dos 16 Apartamentos do Bloco (101..104, 201..204, 301..304, 401..404) */}
                    <div className="flex-1 grid grid-cols-4 grid-rows-4 gap-1">
                      {TODOS_APARTAMENTOS.map((apto) => {
                        const ch = chaveUnidade(bloco, apto);
                        const presenca = mapaPresencas.get(ch);
                        return (
                          <CelulaUnidadeTelao
                            key={ch}
                            bloco={bloco}
                            apartamento={apto}
                            presente={Boolean(presenca)}
                            onlineConectado={Boolean(presenca?.online_conectado)}
                            isConstrutora={Boolean(presenca?.is_construtora)}
                            comProcuracao={Boolean(presenca?.com_procuracao)}
                            voto={mapaVotosPauta.get(ch)}
                            mostrarBlocoPrefix={false}
                            expandido={false}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* MODO FOCADO: APENAS UNIDADES PRESENTES APTAS */
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
              {unidadesPresentesAptas.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center text-slate-500 space-y-2">
                  <Users className="w-10 h-10 text-milano-gold/50" />
                  <p className="text-base font-semibold text-slate-300">
                    Aguardando confirmação de unidades para este escopo
                  </p>
                  <p className="text-xs text-slate-500">
                    Assim que a portaria confirmar a entrada ou o morador validar em{' '}
                    {dominioLegivel}, as unidades aparecerão instantaneamente aqui.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-2">
                  {unidadesPresentesAptas.map((u) => (
                    <CelulaUnidadeTelao
                      key={u.id}
                      bloco={u.bloco}
                      apartamento={u.apartamento}
                      presente={true}
                      onlineConectado={Boolean(u.online_conectado)}
                      isConstrutora={u.is_construtora}
                      comProcuracao={Boolean(u.com_procuracao)}
                      voto={mapaVotosPauta.get(chaveUnidade(u.bloco, u.apartamento))}
                      mostrarBlocoPrefix={true}
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
