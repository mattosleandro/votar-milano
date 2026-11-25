'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  FileCheck2,
  Filter,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Search,
  ShieldAlert,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import {
  TelaoRelogioConvocacao,
  TelaoTimerVotacao,
} from '@/components/telao/TelaoClockWidgets';
import { useAssembleiaPublicRealtime } from '@/hooks/useAssembleiaPublicRealtime';
import {
  calcularPlacarPauta,
  calcularQuorumEscopo,
  chaveUnidade,
  formatarBloco,
  formatarUnidadeTelaoCompacta,
  obterInfoBloco,
  obterMetadadosEscopo,
  TODOS_APARTAMENTOS,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import { APP_PUBLIC_URL } from '@/lib/supabase';
import {
  FaseCondominio,
  ModuloCondominio,
  OpcaoVoto,
  PresencaPublica,
} from '@/lib/types';

type AbaTelao = 'PRESENTES_POR_BLOCO' | 'TODOS_OS_BLOCOS' | 'PLACAR_CONSOLIDADO';
type FiltroFaseTelao = 'TODAS' | FaseCondominio;
type FiltroModuloTelao = 'TODOS' | ModuloCondominio;

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
          ? 'px-2 py-2 min-h-[38px]'
          : 'px-0.5 py-0.5 min-h-[20px] sm:min-h-[22px] xl:min-h-[19px] 2xl:min-h-[22px]'
      }`}
    >
      <span
        className={`font-mono font-extrabold tracking-tight tabular-nums leading-none whitespace-nowrap ${
          expandido
            ? 'text-xs sm:text-sm 2xl:text-base'
            : 'text-[10px] sm:text-[11px] xl:text-[10px] 2xl:text-xs'
        }`}
      >
        {mostrarBlocoPrefix
          ? formatarUnidadeTelaoCompacta(bloco, apartamento)
          : String(apartamento)}
      </span>

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

      {isConstrutora && expandido && (
        <span className="inline-flex items-center justify-center rounded bg-milano-gold text-[#0C0C0D] font-black leading-none px-1.5 py-0.5 text-[10px] ml-1 shrink-0">
          CONST
        </span>
      )}
    </div>
  );
});

/** Interpreta texto de busca livre do telão (ex.: "26", "B26", "101", "26 101", "B26 | A101") */
function parseBuscaBlocoApto(texto: string): {
  blocoFiltro: number | null;
  aptoFiltro: number | null;
  termoLivre: string;
} {
  const limpo = texto.trim().toLowerCase();
  if (!limpo) return { blocoFiltro: null, aptoFiltro: null, termoLivre: '' };

  const numeros = limpo.match(/\d+/g)?.map(Number) ?? [];
  let blocoFiltro: number | null = null;
  let aptoFiltro: number | null = null;

  for (const n of numeros) {
    if (n >= 101 && n <= 404 && aptoFiltro === null) {
      aptoFiltro = n;
    } else if (n >= 1 && n <= 34 && blocoFiltro === null) {
      blocoFiltro = n;
    }
  }

  return { blocoFiltro, aptoFiltro, termoLivre: limpo };
}

export default function PaginaTelao() {
  const {
    config,
    presencas,
    pautaAberta,
    ultimaPautaEncerrada,
    votos,
    contadores,
    serverOffsetMs,
    realtimeAtivo,
    erroConexao,
    statusConexao,
  } = useAssembleiaPublicRealtime('telao');

  const [abaAtiva, setAbaAtiva] = useState<AbaTelao>('PRESENTES_POR_BLOCO');
  const [filtroFase, setFiltroFase] = useState<FiltroFaseTelao>('TODAS');
  const [filtroModulo, setFiltroModulo] = useState<FiltroModuloTelao>('TODOS');
  const [buscaUnidade, setBuscaUnidade] = useState('');
  const [painelMaximizado, setPainelMaximizado] = useState(false);
  const [timerEsgotado, setTimerEsgotado] = useState(false);

  // Screen Wake Lock API: mantém a tela do notebook/datashow sempre acesa durante a assembleia
  useEffect(() => {
    let wakeLock: { release: () => Promise<void> } | null = null;
    let ativo = true;

    const solicitarWakeLock = async () => {
      if (!ativo || typeof navigator === 'undefined') return;
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      try {
        wakeLock = await nav.wakeLock.request('screen');
      } catch {
        // Ignora se o navegador ou política do SO não conceder wake lock
      }
    };

    void solicitarWakeLock();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void solicitarWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      ativo = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wakeLock) {
        void wakeLock.release().catch(() => {});
      }
    };
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

  const limparFiltros = useCallback(() => {
    setFiltroFase('TODAS');
    setFiltroModulo('TODOS');
    setBuscaUnidade('');
  }, []);

  const handleSelecionarFase = useCallback((fase: FiltroFaseTelao) => {
    setFiltroFase(fase);
    // Ajusta módulo se incompatível com a fase escolhida
    setFiltroModulo((modAtual) => {
      if (fase === 'TODAS' || modAtual === 'TODOS') return modAtual;
      if (fase === 1 && (modAtual === 3 || modAtual === 4)) return 'TODOS';
      if (fase === 2 && (modAtual === 1 || modAtual === 2)) return 'TODOS';
      return modAtual;
    });
  }, []);

  const handleSelecionarModulo = useCallback((mod: FiltroModuloTelao) => {
    setFiltroModulo(mod);
    if (mod === 1 || mod === 2) setFiltroFase(1);
    else if (mod === 3 || mod === 4) setFiltroFase(2);
  }, []);

  const pautaExibida = pautaAberta ?? ultimaPautaEncerrada;
  const escopoAtivo = pautaExibida ? pautaExibida.escopo : config.escopo_assembleia;
  const metaEscopo = useMemo(() => obterMetadadosEscopo(escopoAtivo), [escopoAtivo]);

  const contadoresPresenca = useMemo(() => {
    return {
      total: contadores.total,
      fase1: contadores.fase1,
      fase2: contadores.fase2,
      construtora: contadores.construtora,
      confirmadosPortaria: contadores.confirmados_portaria,
      conectadosOnline: contadores.conectados_online,
      comProcuracao: contadores.com_procuracao,
    };
  }, [contadores]);

  const resumoQuorum = useMemo(
    () => calcularQuorumEscopo(escopoAtivo, presencas, config),
    [config, escopoAtivo, presencas]
  );

  const placar = useMemo(() => {
    if (!pautaExibida) return null;
    return calcularPlacarPauta(pautaExibida, presencas, votos);
  }, [pautaExibida, presencas, votos]);

  const mapaPresencas = useMemo(() => {
    const mapa = new Map<string, PresencaPublica>();
    for (const p of presencas) {
      mapa.set(chaveUnidade(p.bloco, p.apartamento), p);
    }
    return mapa;
  }, [presencas]);

  const mapaVotosPauta = useMemo(() => {
    const mapa = new Map<string, OpcaoVoto>();
    if (!pautaExibida) return mapa;
    const rodadaAtiva = pautaExibida.rodada ?? 1;
    for (const v of votos) {
      if (v.pauta_id === pautaExibida.id && (v.rodada ?? 1) === rodadaAtiva) {
        mapa.set(chaveUnidade(v.bloco, v.apartamento), v.voto);
      }
    }
    return mapa;
  }, [pautaExibida, votos]);

  // Aplicação dos filtros interativos do /telao (Fase, Módulo e Busca Bloco/Apartamento)
  const buscaParsed = useMemo(() => parseBuscaBlocoApto(buscaUnidade), [buscaUnidade]);
  const temFiltroAtivo =
    filtroFase !== 'TODAS' || filtroModulo !== 'TODOS' || buscaUnidade.trim().length > 0;

  const blocosFiltrados = useMemo(() => {
    return metaEscopo.blocos.filter((bloco) => {
      const info = obterInfoBloco(bloco);
      if (filtroFase !== 'TODAS' && info.fase !== filtroFase) return false;
      if (filtroModulo !== 'TODOS' && info.modulo !== filtroModulo) return false;
      if (buscaParsed.blocoFiltro !== null && bloco !== buscaParsed.blocoFiltro) return false;
      return true;
    });
  }, [buscaParsed.blocoFiltro, filtroFase, filtroModulo, metaEscopo.blocos]);

  const apartamentosFiltrados = useMemo(() => {
    if (buscaParsed.aptoFiltro === null) return TODOS_APARTAMENTOS;
    return TODOS_APARTAMENTOS.filter((a) => a === buscaParsed.aptoFiltro);
  }, [buscaParsed.aptoFiltro]);

  // Unidades presentes aptas no escopo + filtros selecionados
  const unidadesPresentesFiltradas = useMemo(() => {
    return presencas.filter((p) => {
      if (!unidadePertenceAoEscopo(p, escopoAtivo)) return false;
      if (filtroFase !== 'TODAS' && p.fase !== filtroFase) return false;
      if (filtroModulo !== 'TODOS' && p.modulo !== filtroModulo) return false;
      if (buscaParsed.blocoFiltro !== null && p.bloco !== buscaParsed.blocoFiltro) return false;
      if (buscaParsed.aptoFiltro !== null && p.apartamento !== buscaParsed.aptoFiltro) return false;
      return true;
    });
  }, [
    buscaParsed.aptoFiltro,
    buscaParsed.blocoFiltro,
    escopoAtivo,
    filtroFase,
    filtroModulo,
    presencas,
  ]);

  // Agrupamento de presentes por bloco (para a aba "Presentes por Bloco" solicitada!)
  const blocosApenasPresentes = useMemo(() => {
    const grupos: {
      bloco: number;
      fase: FaseCondominio;
      modulo: ModuloCondominio;
      unidades: PresencaPublica[];
      votosSim: number;
      votosNao: number;
      procuracoes: number;
    }[] = [];

    for (const bloco of blocosFiltrados) {
      const unidadesDoBloco: PresencaPublica[] = [];
      let votosSim = 0;
      let votosNao = 0;
      let procuracoes = 0;

      for (const apto of apartamentosFiltrados) {
        const ch = chaveUnidade(bloco, apto);
        const pr = mapaPresencas.get(ch);
        if (pr) {
          unidadesDoBloco.push(pr);
          if (pr.com_procuracao) procuracoes += 1;
          const v = mapaVotosPauta.get(ch);
          if (v === 'SIM') votosSim += 1;
          else if (v === 'NAO') votosNao += 1;
        }
      }

      if (unidadesDoBloco.length > 0) {
        const info = obterInfoBloco(bloco);
        grupos.push({
          bloco,
          fase: info.fase,
          modulo: info.modulo,
          unidades: unidadesDoBloco,
          votosSim,
          votosNao,
          procuracoes,
        });
      }
    }

    return grupos;
  }, [apartamentosFiltrados, blocosFiltrados, mapaPresencas, mapaVotosPauta]);

  const dominioLegivel = useMemo(() => {
    try {
      return new URL(APP_PUBLIC_URL).host;
    } catch {
      return 'votar.portalmilano.com';
    }
  }, []);

  const classesGridResponsivoBlocos = useMemo(() => {
    const qtd = blocosFiltrados.length;
    if (qtd > 20) {
      return painelMaximizado
        ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7'
        : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7';
    }
    if (qtd > 12) {
      return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6';
    }
    if (qtd > 4) {
      return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
    }
    return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  }, [blocosFiltrados.length, painelMaximizado]);

  const classesGridPresentesPorBloco = useMemo(() => {
    const qtd = blocosApenasPresentes.length;
    if (qtd > 20) {
      return painelMaximizado
        ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
        : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';
    }
    if (qtd > 10) {
      return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';
    }
    if (qtd > 4) {
      return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
    }
    return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  }, [blocosApenasPresentes.length, painelMaximizado]);

  const mostrarVencedor = pautaExibida?.status === 'encerrada' || timerEsgotado;

  return (
    <div className="min-h-screen xl:h-screen xl:overflow-hidden bg-slate-950 text-white flex flex-col xl:flex-row">
      {/* =====================================================================
          BARRA LATERAL ESQUERDA (Oculta em Tela Inteira)
         ===================================================================== */}
      {!painelMaximizado && (
        <aside className="w-full xl:w-[285px] 2xl:w-[330px] shrink-0 bg-[#0C0C0D] border-b xl:border-b-0 xl:border-r border-milano-gold/25 p-3 2xl:p-4 flex flex-col justify-between gap-3">
          {/* Topo: Logo Oficial Branca + Dourada e Status WebSocket / Contingência */}
          <div className="flex items-center justify-between gap-2">
            <MilanoLogo variant="dark" className="h-8 2xl:h-9 w-auto" />
            <span
              title={
                realtimeAtivo
                  ? 'Recebendo atualizações instantâneas via WebSocket Broadcast'
                  : 'Modo Contingência: sincronização HTTP automática ativa'
              }
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                statusConexao === 'AO_VIVO' && realtimeAtivo
                  ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/40'
                  : 'bg-amber-950/90 text-amber-300 border-amber-500/40'
              }`}
            >
              {statusConexao === 'AO_VIVO' && realtimeAtivo ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <Wifi className="w-3 h-3" />
                  <span>AO VIVO</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 animate-pulse" />
                  <span>AUTO-SYNC</span>
                </>
              )}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-1 gap-2.5 flex-1">
            {/* Widget Isolado de Relógio / Cronômetro (não re-renderiza o grid a cada 1s!) */}
            <TelaoRelogioConvocacao
              convocacaoAtiva={config.convocacao_ativa}
              horarioPrimeira={config.horario_primeira_convocacao}
              horarioSegunda={config.horario_segunda_convocacao}
              serverOffsetMs={serverOffsetMs}
            />

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
                    / {metaEscopo.totalUnidades} • F1: {contadoresPresenca.fase1} | F2:{' '}
                    {contadoresPresenca.fase2}
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
          ÁREA PRINCIPAL: TOPO COM CRONÔMETRO + PLACAR + PAINEL FILTRÁVEL EM 3 ABAS
         ===================================================================== */}
      <main className="flex-1 flex flex-col min-w-0 p-2 sm:p-2.5 2xl:p-3.5 gap-2 sm:gap-2.5 xl:overflow-hidden">
        {erroConexao ? (
          <div
            role="alert"
            className="rounded-xl bg-amber-950/90 border border-amber-400/60 px-3.5 py-2 text-xs font-bold text-amber-200 flex items-center justify-between gap-2 shrink-0"
          >
            <span className="flex items-center gap-2">
              <WifiOff className="w-4 h-4 text-amber-300 shrink-0 animate-pulse" />
              Modo Contingência: oscilação na conexão com o servidor — sincronizando automaticamente
            </span>
          </div>
        ) : null}

        {/* Topo Compacto: Pauta Ativa + Cronômetro Isolado + Placar em Linha */}
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

                {pautaExibida && (pautaExibida.rodada ?? 1) > 1 ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-400/20 border border-amber-400/60 text-amber-200 text-xs font-black uppercase tracking-wider">
                    RODADA {pautaExibida.rodada}
                  </span>
                ) : null}

                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-milano-gold text-[#0C0C0D] text-xs font-black uppercase tracking-wide shadow">
                  <Building2 className="w-3.5 h-3.5 shrink-0" />
                  {metaEscopo.badgeTelao}
                </span>

                {placar && mostrarVencedor && placar.totalVotosRegistrados > 0 ? (
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
                {pautaExibida ? (
                  pautaExibida.titulo
                ) : (
                  <>
                    Confirme presença na recepção e acesse{' '}
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-milano-gold/20 border border-milano-gold/70 font-mono font-black text-milano-gold shadow-sm">
                      votar.portalmilano.com
                    </span>
                  </>
                )}
              </h1>
            </div>

            {/* Centro: Widget Isolado do Contador Regressivo de Deliberação */}
            <TelaoTimerVotacao
              timerDurationSeconds={config.timer_duration_seconds}
              timerStartedAt={config.timer_started_at}
              timerRunning={config.timer_running}
              serverOffsetMs={serverOffsetMs}
              onEsgotadoChange={setTimerEsgotado}
            />

            {/* Direita: Placar Compacto de Alto Contraste */}
            {placar ? (
              (() => {
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
                        <span className="text-[10px] font-semibold text-amber-300/80">Abst.</span>
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : null}
          </div>
        </section>

        {/* PAINEL PRINCIPAL COM 3 ABAS + FILTROS (FASE, MÓDULO, BLOCO/APTO) + TELA INTEIRA */}
        <section className="flex-1 min-h-0 rounded-2xl bg-[#0C0C0D] border border-slate-800 px-3 py-2.5 2xl:px-4 2xl:py-3 flex flex-col overflow-hidden gap-2">
          {/* Linha 1: Abas de Visualização + Legenda + Botão Tela Inteira */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/90 shrink-0">
            <div className="inline-flex flex-wrap items-center p-0.5 rounded-xl bg-slate-900 border border-slate-800 gap-1">
              <button
                type="button"
                onClick={() => setAbaAtiva('PRESENTES_POR_BLOCO')}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition flex items-center gap-1.5 ${
                  abaAtiva === 'PRESENTES_POR_BLOCO'
                    ? 'bg-milano-gold text-[#0C0C0D] shadow'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Presentes por Bloco ({unidadesPresentesFiltradas.length})
              </button>

              <button
                type="button"
                onClick={() => setAbaAtiva('TODOS_OS_BLOCOS')}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition flex items-center gap-1.5 ${
                  abaAtiva === 'TODOS_OS_BLOCOS'
                    ? 'bg-milano-gold text-[#0C0C0D] shadow'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Todos os Blocos ({blocosFiltrados.length})
              </button>

              <button
                type="button"
                onClick={() => setAbaAtiva('PLACAR_CONSOLIDADO')}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition flex items-center gap-1.5 ${
                  abaAtiva === 'PLACAR_CONSOLIDADO'
                    ? 'bg-milano-gold text-[#0C0C0D] shadow'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Placar &amp; Lista
              </button>
            </div>

            {/* Legenda de Cores Semânticas + Botão Tela Inteira */}
            <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-bold text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 border border-emerald-300" />
                SIM
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-rose-600 border border-rose-300" />
                NÃO
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-sky-600 border border-sky-300" />
                CONECTADO
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-violet-600 border border-violet-300" />
                PORTARIA
              </span>
              <span className="inline-flex items-center gap-1 text-amber-300">
                <span className="inline-flex items-center justify-center px-1 py-[1px] rounded bg-amber-300 text-[#0C0C0D] font-black text-[9px] leading-none">
                  P
                </span>
                PROC. ({contadoresPresenca.comProcuracao})
              </span>
              {abaAtiva === 'TODOS_OS_BLOCOS' && (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  <span className="w-2.5 h-2.5 rounded-sm bg-slate-900 border border-slate-800" />
                  AUSENTE
                </span>
              )}

              <button
                type="button"
                onClick={alternarMaximizarPainel}
                title="Maximizar Painel em Tela Inteira"
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-extrabold uppercase tracking-wide border transition shadow-sm ${
                  painelMaximizado
                    ? 'bg-milano-gold text-[#0C0C0D] border-milano-gold-light'
                    : 'bg-slate-900 text-milano-gold border-milano-gold/50 hover:bg-slate-800'
                }`}
              >
                {painelMaximizado ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>Restaurar</span>
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

          {/* Linha 2: Filtros Rápidos por Fase, Módulo e Busca por Bloco/Apartamento */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-slate-800/70 shrink-0 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wider text-slate-400">
                <Filter className="w-3 h-3 text-milano-gold" />
                Filtros:
              </span>

              {/* Filtro por Fase */}
              <div className="inline-flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 gap-0.5">
                {(['TODAS', 1, 2] as const).map((f) => (
                  <button
                    key={String(f)}
                    type="button"
                    onClick={() => handleSelecionarFase(f)}
                    className={`px-2 py-0.5 rounded-md font-bold transition ${
                      filtroFase === f
                        ? 'bg-milano-gold text-[#0C0C0D]'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {f === 'TODAS' ? 'Todas Fases' : `Fase ${f}`}
                  </button>
                ))}
              </div>

              {/* Filtro por Módulo */}
              <div className="inline-flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 gap-0.5">
                {(['TODOS', 1, 2, 3, 4] as const).map((m) => (
                  <button
                    key={String(m)}
                    type="button"
                    onClick={() => handleSelecionarModulo(m)}
                    title={
                      m === 1
                        ? 'Módulo 1: Blocos 26 ao 34 (Fase 1)'
                        : m === 2
                          ? 'Módulo 2: Blocos 19 ao 25 (Fase 1)'
                          : m === 3
                            ? 'Módulo 3: Blocos 01–04 e 09–11 (Fase 2)'
                            : m === 4
                              ? 'Módulo 4: Blocos 05–08 e 12–18 (Fase 2)'
                              : 'Todos os Módulos'
                    }
                    className={`px-2 py-0.5 rounded-md font-bold transition ${
                      filtroModulo === m
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {m === 'TODOS' ? 'Todos Mód.' : `Mód. ${m}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Busca por Bloco / Apartamento + Limpar */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1.5 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="text"
                  value={buscaUnidade}
                  onChange={(e) => setBuscaUnidade(e.target.value)}
                  placeholder="Filtrar Bloco / Apto (ex: 26 101)"
                  aria-label="Filtrar por Bloco ou Apartamento"
                  className="w-52 sm:w-60 rounded-lg bg-slate-900 border border-slate-700 pl-8 pr-2.5 py-1 text-[11px] font-mono font-bold text-white placeholder:text-slate-500 focus:border-milano-gold focus:outline-none"
                />
              </div>

              {temFiltroAtivo && (
                <button
                  type="button"
                  onClick={limparFiltros}
                  className="inline-flex items-center gap-1 rounded-lg bg-rose-950/80 border border-rose-500/40 px-2.5 py-1 font-bold text-rose-200 hover:bg-rose-900"
                >
                  <X className="w-3 h-3" />
                  Limpar
                </button>
              )}
            </div>
          </div>

          {/* ===================================================================
              ABA 1: APENAS PRESENTES AGRUPADOS POR BLOCO (Visualização Limpa)
             =================================================================== */}
          {abaAtiva === 'PRESENTES_POR_BLOCO' && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 custom-scrollbar">
              {blocosApenasPresentes.length === 0 ? (
                <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center text-slate-400 space-y-2">
                  <Users className="w-10 h-10 text-milano-gold/50" />
                  <p className="text-base font-bold text-slate-200">
                    {temFiltroAtivo
                      ? 'Nenhuma unidade presente corresponde aos filtros selecionados'
                      : 'Aguardando confirmação de unidades na recepção'}
                  </p>
                  {temFiltroAtivo ? (
                    <button
                      type="button"
                      onClick={limparFiltros}
                      className="rounded-lg bg-milano-gold px-3 py-1.5 text-xs font-black text-[#0C0C0D]"
                    >
                      Mostrar Todos os Presentes
                    </button>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Confirme presença na recepção e acesse{' '}
                      <span className="font-mono font-extrabold text-milano-gold">
                        {dominioLegivel}
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <div className={`grid ${classesGridPresentesPorBloco} gap-2.5`}>
                  {blocosApenasPresentes.map((grupo) => (
                    <div
                      key={grupo.bloco}
                      className="rounded-xl border border-milano-gold/45 bg-slate-900/75 p-2.5 flex flex-col gap-2 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-slate-800">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-sm 2xl:text-base font-black text-milano-gold">
                            BLOCO {formatarBloco(grupo.bloco)}
                          </span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-300">
                            F{grupo.fase}•M{grupo.modulo}
                          </span>
                        </div>

                        <div className="flex items-center gap-1 shrink-0 font-mono text-[10px] font-black tabular-nums">
                          {pautaExibida && grupo.votosSim > 0 && (
                            <span className="rounded bg-emerald-600/30 border border-emerald-400/50 px-1.5 py-0.5 text-emerald-200">
                              {grupo.votosSim}S
                            </span>
                          )}
                          {pautaExibida && grupo.votosNao > 0 && (
                            <span className="rounded bg-rose-600/30 border border-rose-400/50 px-1.5 py-0.5 text-rose-200">
                              {grupo.votosNao}N
                            </span>
                          )}
                          <span className="rounded bg-milano-gold/20 px-1.5 py-0.5 text-milano-gold-light">
                            {grupo.unidades.length} pres.
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {grupo.unidades.map((u) => {
                          const ch = chaveUnidade(u.bloco, u.apartamento);
                          return (
                            <CelulaUnidadeTelao
                              key={u.id}
                              bloco={u.bloco}
                              apartamento={u.apartamento}
                              presente={true}
                              onlineConectado={Boolean(u.online_conectado)}
                              isConstrutora={u.is_construtora}
                              comProcuracao={Boolean(u.com_procuracao)}
                              voto={mapaVotosPauta.get(ch)}
                              mostrarBlocoPrefix={false}
                              expandido={true}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              ABA 2: GRADE INTEGRAL COMPLETA POR BLOCO (4x4 — 34 Blocos)
             =================================================================== */}
          {abaAtiva === 'TODOS_OS_BLOCOS' && (
            <div
              className={`flex-1 min-h-0 grid ${classesGridResponsivoBlocos} auto-rows-fr gap-2 overflow-y-auto pr-0.5 custom-scrollbar`}
            >
              {blocosFiltrados.map((bloco) => {
                const info = obterInfoBloco(bloco);
                let presentesNoBloco = 0;
                let procuracoesNoBloco = 0;
                for (const apto of apartamentosFiltrados) {
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
                    <div className="flex items-center justify-between px-1 pb-1 mb-1 border-b border-slate-800/90 shrink-0">
                      <span className="font-mono text-xs 2xl:text-sm font-black tracking-wide text-milano-gold">
                        B{formatarBloco(bloco)}{' '}
                        <span className="text-[9px] font-bold text-slate-400">
                          F{info.fase}•M{info.modulo}
                        </span>
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
                          {presentesNoBloco}/{apartamentosFiltrados.length}
                        </span>
                      </div>
                    </div>

                    <div
                      className={`flex-1 grid gap-1 ${
                        apartamentosFiltrados.length === 1
                          ? 'grid-cols-1'
                          : 'grid-cols-4 grid-rows-4'
                      }`}
                    >
                      {apartamentosFiltrados.map((apto) => {
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
                            expandido={apartamentosFiltrados.length === 1}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ===================================================================
              ABA 3: PLACAR CONSOLIDADO GIGANTE + LISTA COMPACTA DE PRESENTES
             =================================================================== */}
          {abaAtiva === 'PLACAR_CONSOLIDADO' && (
            <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto pr-1 custom-scrollbar">
              {placar ? (
                <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-4 space-y-3 shrink-0 tabular-nums">
                  {/* Barra Proporcional Gigante */}
                  <div className="h-6 w-full rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex">
                    {placar.sim > 0 && (
                      <div
                        className="bg-emerald-500 h-full transition-all duration-500 flex items-center justify-center text-xs font-black text-slate-950"
                        style={{ width: `${placar.pctSim}%` }}
                      >
                        {placar.pctSim >= 10 ? `SIM ${placar.pctSim.toFixed(0)}%` : ''}
                      </div>
                    )}
                    {placar.nao > 0 && (
                      <div
                        className="bg-rose-500 h-full transition-all duration-500 flex items-center justify-center text-xs font-black text-white"
                        style={{ width: `${placar.pctNao}%` }}
                      >
                        {placar.pctNao >= 10 ? `NÃO ${placar.pctNao.toFixed(0)}%` : ''}
                      </div>
                    )}
                    {placar.naoVotaram > 0 && (
                      <div
                        className="bg-amber-500/40 h-full transition-all duration-500 flex items-center justify-center text-xs font-black text-amber-100"
                        style={{ width: `${placar.pctNaoVotaram}%` }}
                      >
                        {placar.pctNaoVotaram >= 12
                          ? `ABST. ${placar.pctNaoVotaram.toFixed(0)}%`
                          : ''}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div
                      className={`rounded-2xl p-4 border-2 ${
                        mostrarVencedor && placar.vencedor === 'SIM'
                          ? 'bg-emerald-900/70 border-milano-gold ring-2 ring-emerald-400/50'
                          : 'bg-emerald-950/60 border-emerald-500/50'
                      }`}
                    >
                      <p className="text-xs font-black uppercase tracking-wider text-emerald-300">
                        Votos SIM (Aprovar)
                      </p>
                      <p className="mt-1 text-4xl 2xl:text-5xl font-black font-mono text-white">
                        {placar.sim}
                      </p>
                      <p className="mt-1 text-xs font-mono font-bold text-emerald-200">
                        {placar.pctSimValidos.toFixed(1)}% válidos • {placar.pctSim.toFixed(1)}%
                        dos presentes
                      </p>
                    </div>

                    <div
                      className={`rounded-2xl p-4 border-2 ${
                        mostrarVencedor && placar.vencedor === 'NAO'
                          ? 'bg-rose-900/70 border-milano-gold ring-2 ring-rose-400/50'
                          : 'bg-rose-950/60 border-rose-500/50'
                      }`}
                    >
                      <p className="text-xs font-black uppercase tracking-wider text-rose-300">
                        Votos NÃO (Rejeitar)
                      </p>
                      <p className="mt-1 text-4xl 2xl:text-5xl font-black font-mono text-white">
                        {placar.nao}
                      </p>
                      <p className="mt-1 text-xs font-mono font-bold text-rose-200">
                        {placar.pctNaoValidos.toFixed(1)}% válidos • {placar.pctNao.toFixed(1)}%
                        dos presentes
                      </p>
                    </div>

                    <div className="rounded-2xl p-4 border-2 bg-amber-950/50 border-amber-400/45">
                      <p className="text-xs font-black uppercase tracking-wider text-amber-300">
                        Não Votaram (Abstenção)
                      </p>
                      <p className="mt-1 text-4xl 2xl:text-5xl font-black font-mono text-amber-100">
                        {placar.naoVotaram}
                      </p>
                      <p className="mt-1 text-xs font-mono font-bold text-amber-200">
                        {placar.pctNaoVotaram.toFixed(1)}% de {placar.presentesAptos} presentes
                        aptos
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
                  Unidades Presentes ({unidadesPresentesFiltradas.length})
                </h3>
                {unidadesPresentesFiltradas.length === 0 ? (
                  <p className="text-xs text-slate-500">Nenhuma unidade presente neste filtro.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-2">
                    {unidadesPresentesFiltradas.map((u) => (
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
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
