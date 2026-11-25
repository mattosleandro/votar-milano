'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Filter,
  LayoutGrid,
  Maximize2,
  Minimize2,
  QrCode,
  Search,
  ShieldAlert,
  Users,
  Wifi,
  WifiOff,
  X,
  ZoomIn,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import {
  CLASSES_GRID_BLOCOS_PADRAO,
  DadosBlocoTelao,
  ItemUnidadeBlocoTelao,
  TelaoBlocoCard,
  TelaoCelulaUnidade,
} from '@/components/telao/TelaoBlocoCard';
import {
  TelaoRelogioConvocacao,
  TelaoTimerVotacao,
} from '@/components/telao/TelaoClockWidgets';
import { TelaoQrCodeOverlay } from '@/components/telao/TelaoQrCodeOverlay';
import { useAssembleiaPublicRealtime } from '@/hooks/useAssembleiaPublicRealtime';
import {
  calcularPlacarPauta,
  calcularQuorumEscopo,
  chaveUnidade,
  obterInfoBloco,
  obterMetadadosEscopo,
  obterOpcoesPauta,
  obterPaletaOpcaoMultipla,
  obterTipoVotacaoPauta,
  TODOS_APARTAMENTOS,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import { APP_PUBLIC_URL } from '@/lib/supabase';
import {
  FaseCondominio,
  ModuloCondominio,
  PresencaPublica,
  VotoUnidade,
} from '@/lib/types';

type AbaTelao = 'PRESENTES_POR_BLOCO' | 'TODOS_OS_BLOCOS' | 'PLACAR_CONSOLIDADO';
type FiltroFaseTelao = 'TODAS' | FaseCondominio;
type FiltroModuloTelao = 'TODOS' | ModuloCondominio;

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
  const [qrTelaCheia, setQrTelaCheia] = useState(false);
  const [imagemAmpliadaTelao, setImagemAmpliadaTelao] = useState<{
    url: string;
    titulo: string;
  } | null>(null);
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

  const tipoVotacaoFoco = obterTipoVotacaoPauta(pautaExibida);
  const opcoesPautaFoco = useMemo(() => obterOpcoesPauta(pautaExibida), [pautaExibida]);

  const mapaVotosPauta = useMemo(() => {
    const mapa = new Map<string, VotoUnidade>();
    if (!pautaExibida) return mapa;
    const rodadaAtiva = pautaExibida.rodada ?? 1;
    for (const v of votos) {
      if (v.pauta_id === pautaExibida.id && (v.rodada ?? 1) === rodadaAtiva) {
        mapa.set(chaveUnidade(v.bloco, v.apartamento), v);
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

  // Estrutura unificada de blocos e apartamentos (fonte única para Aba 1 e Aba 2)
  const { blocosTodosDados, blocosPresentesDados } = useMemo(() => {
    const todos: DadosBlocoTelao[] = [];
    const apenasPresentes: DadosBlocoTelao[] = [];

    for (const bloco of blocosFiltrados) {
      const info = obterInfoBloco(bloco);
      const itensTodos: ItemUnidadeBlocoTelao[] = [];
      const itensPresentes: ItemUnidadeBlocoTelao[] = [];

      let votosSim = 0;
      let votosNao = 0;
      let votosMultipla = 0;
      let procuracoes = 0;

      for (const apto of apartamentosFiltrados) {
        const ch = chaveUnidade(bloco, apto);
        const pr = mapaPresencas.get(ch);
        const regVoto = mapaVotosPauta.get(ch);
        const presente = Boolean(pr);

        const item: ItemUnidadeBlocoTelao = {
          bloco,
          apartamento: apto,
          presente,
          onlineConectado: Boolean(pr?.online_conectado),
          isConstrutora: Boolean(pr?.is_construtora),
          comProcuracao: Boolean(pr?.com_procuracao),
          voto: regVoto?.voto,
          escolhas: regVoto?.escolhas_json,
        };

        itensTodos.push(item);

        if (presente) {
          itensPresentes.push(item);
          if (item.comProcuracao) procuracoes += 1;
          if (regVoto?.voto === 'SIM') votosSim += 1;
          else if (regVoto?.voto === 'NAO') votosNao += 1;
          else if (regVoto?.voto === 'MULTIPLA') votosMultipla += 1;
        }
      }

      const presentesCount = itensPresentes.length;
      const totalVotaramBloco =
        tipoVotacaoFoco === 'SIM_NAO' ? votosSim + votosNao : votosMultipla;
      const aguardandoVoto = Math.max(0, presentesCount - totalVotaramBloco);
      const baseComum = {
        bloco,
        fase: info.fase,
        modulo: info.modulo,
        totalApartamentosBase: apartamentosFiltrados.length,
        presentesCount,
        votosSim,
        votosNao,
        votosMultipla,
        aguardandoVoto,
        procuracoes,
      };

      todos.push({ ...baseComum, unidades: itensTodos });
      if (presentesCount > 0) {
        apenasPresentes.push({ ...baseComum, unidades: itensPresentes });
      }
    }

    return {
      blocosTodosDados: todos,
      blocosPresentesDados: apenasPresentes,
    };
  }, [apartamentosFiltrados, blocosFiltrados, mapaPresencas, mapaVotosPauta, tipoVotacaoFoco]);

  const dominioLegivel = useMemo(() => {
    try {
      return new URL(APP_PUBLIC_URL).host;
    } catch {
      return 'votar.portalmilano.com';
    }
  }, []);

  const mostrarVencedor = pautaExibida?.status === 'encerrada' || timerEsgotado;

  return (
    <div className="min-h-screen xl:h-screen xl:overflow-hidden bg-slate-950 text-white flex flex-col xl:flex-row">
      {/* =====================================================================
          BARRA LATERAL ESQUERDA (Oculta em Tela Inteira)
         ===================================================================== */}
      {!painelMaximizado && (
        <aside className="w-full xl:w-[285px] 2xl:w-[330px] shrink-0 bg-[#0C0C0D] border-b xl:border-b-0 xl:border-r border-milano-gold/25 p-3 2xl:p-4 flex flex-col justify-between gap-3 xl:overflow-y-auto custom-scrollbar">
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

            {/* QR Code Clicável -> Expande em Tela Cheia com Dados de Entrada */}
            <button
              type="button"
              onClick={() => setQrTelaCheia(true)}
              title="Clique para abrir o QR Code em tela cheia com o status de entrada"
              className="group rounded-2xl bg-slate-900/90 border border-milano-gold/35 hover:border-milano-gold hover:bg-slate-900 p-2.5 2xl:p-3.5 text-center space-y-1.5 shadow-lg flex flex-col items-center justify-center transition cursor-pointer w-full"
            >
              <p className="text-[10px] 2xl:text-xs font-bold uppercase tracking-widest text-milano-gold-light">
                Aponte a Câmera para Validar e Votar
              </p>
              <div className="bg-white p-2 rounded-xl inline-flex items-center justify-center shadow-inner transition group-hover:scale-[1.03]">
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
              <span className="inline-flex items-center gap-1 rounded-full bg-milano-gold/15 border border-milano-gold/40 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-milano-gold-light group-hover:bg-milano-gold group-hover:text-[#0C0C0D] transition">
                <Maximize2 className="w-2.5 h-2.5" />
                Clique para ampliar QR Code
              </span>
            </button>

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
                      placar.tipoVotacao !== 'SIM_NAO'
                        ? placar.vencedor === 'EMPATE'
                          ? 'bg-amber-400 text-slate-950 border-amber-200'
                          : 'bg-milano-gold text-[#0C0C0D] border-milano-gold-light animate-pulse'
                        : placar.vencedor === 'SIM'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-200 animate-pulse'
                          : placar.vencedor === 'NAO'
                            ? 'bg-rose-500 text-white border-rose-200 animate-pulse'
                            : 'bg-amber-400 text-slate-950 border-amber-200'
                    }`}
                  >
                    {placar.tipoVotacao !== 'SIM_NAO'
                      ? placar.vencedor === 'EMPATE'
                        ? `EMPATE: ${placar.opcoes
                            .filter((o) => o.ehVencedora)
                            .map((o) => `${o.sigla} (${o.votos})`)
                            .join(' × ')}`
                        : `★ MAIS VOTADA: ${placar.opcoes
                            .filter((o) => o.ehVencedora)
                            .map((o) => `${o.sigla} — ${o.label} (${o.votos})`)
                            .join(', ')}`
                      : placar.vencedor === 'SIM'
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

            {/* Direita: Placar Compacto Padronizado (mesma altura em todos os cards) */}
            {placar ? (
              placar.tipoVotacao !== 'SIM_NAO' ? (
                <div className="flex flex-wrap items-stretch gap-1.5 tabular-nums w-full sm:w-auto shrink-0">
                  {placar.opcoes.slice(0, 4).map((opt, idx) => {
                    const paleta = obterPaletaOpcaoMultipla(idx);
                    const venceu = mostrarVencedor && opt.ehVencedora;
                    return (
                      <div
                        key={opt.id}
                        title={`${opt.sigla}: ${opt.label}`}
                        className={`rounded-xl px-2.5 py-1.5 min-w-[82px] min-h-[58px] flex flex-col justify-between transition-all ${
                          venceu
                            ? 'bg-slate-800 border-2 border-milano-gold ring-2 ring-milano-gold/40'
                            : `border ${paleta.pillDark}`
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 text-[10px] font-black">
                          <span>OPÇÃO {opt.sigla}</span>
                          <span className="font-mono">{opt.pctVotantes.toFixed(0)}%</span>
                        </div>
                        <p className="text-lg 2xl:text-xl font-black font-mono text-white leading-none">
                          {opt.votos}
                        </p>
                      </div>
                    );
                  })}
                  <div className="rounded-xl bg-amber-950/60 border border-amber-400/45 px-2.5 py-1.5 min-w-[88px] min-h-[58px] flex flex-col justify-between">
                    <div className="flex items-center justify-between gap-1 text-[10px] font-black text-amber-300">
                      <span>ABST.</span>
                      <span className="font-mono">{placar.pctNaoVotaram.toFixed(0)}%</span>
                    </div>
                    <p className="text-lg 2xl:text-xl font-black font-mono text-amber-100 leading-none">
                      {placar.naoVotaram}
                    </p>
                  </div>
                </div>
              ) : (
                (() => {
                  const simVenceu = mostrarVencedor && placar.vencedor === 'SIM';
                  const naoVenceu = mostrarVencedor && placar.vencedor === 'NAO';

                  return (
                    <div className="grid grid-cols-3 gap-2 tabular-nums items-stretch w-full sm:w-auto shrink-0">
                      <div
                        className={`rounded-xl px-3 py-1.5 min-w-[104px] 2xl:min-w-[132px] min-h-[58px] flex flex-col justify-between transition-all ${
                          simVenceu
                            ? 'bg-emerald-900/90 border-2 border-milano-gold ring-2 ring-emerald-400/40 shadow-lg'
                            : 'bg-emerald-950/70 border border-emerald-500/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 text-[11px] font-black text-emerald-300">
                          <span>{simVenceu ? '★ SIM' : 'SIM'}</span>
                          <span className="font-mono">{placar.pctSimValidos.toFixed(0)}%</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-white leading-none">
                            {placar.sim}
                          </p>
                          <span className="text-[10px] font-semibold text-emerald-300/80 font-mono">
                            {placar.pctSim.toFixed(0)}% pres.
                          </span>
                        </div>
                      </div>

                      <div
                        className={`rounded-xl px-3 py-1.5 min-w-[104px] 2xl:min-w-[132px] min-h-[58px] flex flex-col justify-between transition-all ${
                          naoVenceu
                            ? 'bg-rose-900/90 border-2 border-milano-gold ring-2 ring-rose-400/40 shadow-lg'
                            : 'bg-rose-950/70 border border-rose-500/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 text-[11px] font-black text-rose-300">
                          <span>{naoVenceu ? '★ NÃO' : 'NÃO'}</span>
                          <span className="font-mono">{placar.pctNaoValidos.toFixed(0)}%</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-white leading-none">
                            {placar.nao}
                          </p>
                          <span className="text-[10px] font-semibold text-rose-300/80 font-mono">
                            {placar.pctNao.toFixed(0)}% pres.
                          </span>
                        </div>
                      </div>

                      <div className="rounded-xl bg-amber-950/60 border border-amber-400/45 px-3 py-1.5 min-w-[104px] 2xl:min-w-[132px] min-h-[58px] flex flex-col justify-between">
                        <div className="flex items-center justify-between gap-1 text-[11px] font-black text-amber-300">
                          <span>NÃO VOTOU</span>
                          <span className="font-mono">{placar.pctNaoVotaram.toFixed(0)}%</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-lg sm:text-xl 2xl:text-2xl font-black font-mono text-amber-100 leading-none">
                            {placar.naoVotaram}
                          </p>
                          <span className="text-[10px] font-semibold text-amber-300/80">Abst.</span>
                        </div>
                      </div>
                    </div>
                  );
                })()
              )
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
              {tipoVotacaoFoco === 'SIM_NAO' ? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 border border-emerald-300" />
                    SIM
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-rose-600 border border-rose-300" />
                    NÃO
                  </span>
                </>
              ) : (
                opcoesPautaFoco.slice(0, 6).map((opt, idx) => {
                  const paleta = obterPaletaOpcaoMultipla(idx);
                  return (
                    <span
                      key={opt.id}
                      title={`${opt.sigla}: ${opt.label}`}
                      className="inline-flex items-center gap-1 max-w-[140px]"
                    >
                      <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${paleta.barClass}`} />
                      <span className="truncate">
                        {opt.sigla}: {opt.label}
                      </span>
                    </span>
                  );
                })
              )}
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
              {contadoresPresenca.construtora > 0 && (
                <span className="inline-flex items-center gap-1 text-milano-gold-light">
                  <span className="inline-flex items-center justify-center px-1 py-[1px] rounded bg-milano-gold text-[#0C0C0D] font-black text-[9px] leading-none">
                    C
                  </span>
                  CONST. ({contadoresPresenca.construtora})
                </span>
              )}
              {abaAtiva === 'TODOS_OS_BLOCOS' && (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  <span className="w-2.5 h-2.5 rounded-sm bg-slate-900 border border-slate-800" />
                  AUSENTE
                </span>
              )}

              {painelMaximizado && (
                <button
                  type="button"
                  onClick={() => setQrTelaCheia(true)}
                  title="Exibir QR Code em tela cheia"
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-extrabold uppercase tracking-wide border border-milano-gold/50 bg-slate-900 text-milano-gold hover:bg-slate-800 transition shadow-sm"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>QR Code</span>
                </button>
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
              ABA 1: APENAS PRESENTES AGRUPADOS POR BLOCO (Padrão Único Responsivo)
             =================================================================== */}
          {abaAtiva === 'PRESENTES_POR_BLOCO' && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 custom-scrollbar">
              {blocosPresentesDados.length === 0 ? (
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
                <div className={`grid ${CLASSES_GRID_BLOCOS_PADRAO} items-stretch content-start`}>
                  {blocosPresentesDados.map((dados) => (
                    <TelaoBlocoCard
                      key={dados.bloco}
                      dados={dados}
                      exibirResumoVotos={Boolean(pautaExibida)}
                      tipoVotacao={tipoVotacaoFoco}
                      opcoesPauta={opcoesPautaFoco}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              ABA 2: GRADE INTEGRAL COMPLETA POR BLOCO (Mesmo Card & Tamanho da Aba 1)
             =================================================================== */}
          {abaAtiva === 'TODOS_OS_BLOCOS' && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 custom-scrollbar">
              {blocosTodosDados.length === 0 ? (
                <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center text-slate-400 space-y-2">
                  <LayoutGrid className="w-10 h-10 text-milano-gold/50" />
                  <p className="text-base font-bold text-slate-200">
                    Nenhum bloco corresponde aos filtros selecionados
                  </p>
                  <button
                    type="button"
                    onClick={limparFiltros}
                    className="rounded-lg bg-milano-gold px-3 py-1.5 text-xs font-black text-[#0C0C0D]"
                  >
                    Limpar Filtros
                  </button>
                </div>
              ) : (
                <div className={`grid ${CLASSES_GRID_BLOCOS_PADRAO} items-stretch content-start`}>
                  {blocosTodosDados.map((dados) => (
                    <TelaoBlocoCard
                      key={dados.bloco}
                      dados={dados}
                      exibirResumoVotos={Boolean(pautaExibida)}
                      tipoVotacao={tipoVotacaoFoco}
                      opcoesPauta={opcoesPautaFoco}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              ABA 3: PLACAR CONSOLIDADO GIGANTE + LISTA COMPACTA DE PRESENTES
             =================================================================== */}
          {abaAtiva === 'PLACAR_CONSOLIDADO' && (
            <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto pr-1 custom-scrollbar">
              {placar ? (
                placar.tipoVotacao !== 'SIM_NAO' ? (
                  <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-4 space-y-3 shrink-0 tabular-nums">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {placar.opcoes.map((opt, idx) => {
                        const paleta = obterPaletaOpcaoMultipla(idx);
                        const venceu = mostrarVencedor && opt.ehVencedora;
                        return (
                          <div
                            key={opt.id}
                            className={`rounded-2xl p-4 border-2 flex flex-col justify-between gap-3 overflow-hidden ${
                              venceu
                                ? 'bg-slate-800 border-milano-gold ring-2 ring-milano-gold/40'
                                : 'bg-slate-950/70 border-slate-800'
                            }`}
                          >
                            {opt.image_url ? (
                              <div className="relative -mx-4 -mt-4 mb-1 bg-slate-900 border-b border-slate-800">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={opt.image_url}
                                  alt={`Opção ${opt.sigla}: ${opt.label}`}
                                  className="h-36 2xl:h-44 w-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setImagemAmpliadaTelao({
                                      url: opt.image_url!,
                                      titulo: `Opção ${opt.sigla} — ${opt.label}`,
                                    })
                                  }
                                  className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-[#0C0C0D]/80 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-[#0C0C0D]"
                                >
                                  <ZoomIn className="w-3.5 h-3.5 text-milano-gold" />
                                  Ampliar
                                </button>
                              </div>
                            ) : null}

                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span
                                  className={`px-2.5 py-1 rounded-lg font-mono text-sm font-black shrink-0 ${
                                    venceu
                                      ? 'bg-milano-gold text-[#0C0C0D]'
                                      : `${paleta.barClass} text-white`
                                  }`}
                                >
                                  {opt.sigla}
                                </span>
                                <p className="text-sm font-extrabold text-white leading-snug">
                                  {opt.label}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-3xl font-black font-mono text-white leading-none">
                                  {opt.votos}
                                </p>
                                <p className="text-[11px] font-mono font-bold text-slate-300 mt-0.5">
                                  {opt.pctVotantes.toFixed(1)}%
                                </p>
                              </div>
                            </div>
                            <div className="h-2.5 w-full rounded-full bg-slate-900 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${paleta.barClass}`}
                                style={{ width: `${Math.min(100, opt.pctVotantes)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="rounded-xl bg-amber-950/50 border border-amber-400/45 px-4 py-2.5 flex items-center justify-between text-xs font-bold text-amber-200">
                      <span>Não Votaram (Abstenção / Imparcialidade)</span>
                      <span className="font-mono text-sm font-black text-amber-100">
                        {placar.naoVotaram} ({placar.pctNaoVotaram.toFixed(1)}%) •{' '}
                        {placar.totalVotosRegistrados}/{placar.presentesAptos} votaram
                      </span>
                    </div>
                  </div>
                ) : (
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

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-stretch">
                      <div
                        className={`rounded-2xl p-4 border-2 flex flex-col justify-between ${
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
                        className={`rounded-2xl p-4 border-2 flex flex-col justify-between ${
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

                      <div className="rounded-2xl p-4 border-2 bg-amber-950/50 border-amber-400/45 flex flex-col justify-between">
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
                )
              ) : null}

              <div className="space-y-2">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
                  Unidades Presentes ({unidadesPresentesFiltradas.length})
                </h3>
                {unidadesPresentesFiltradas.length === 0 ? (
                  <p className="text-xs text-slate-500">Nenhuma unidade presente neste filtro.</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,134px),1fr))] gap-2">
                    {unidadesPresentesFiltradas.map((u) => {
                      const regVoto = mapaVotosPauta.get(chaveUnidade(u.bloco, u.apartamento));
                      return (
                        <TelaoCelulaUnidade
                          key={u.id}
                          bloco={u.bloco}
                          apartamento={u.apartamento}
                          presente={true}
                          onlineConectado={Boolean(u.online_conectado)}
                          isConstrutora={u.is_construtora}
                          comProcuracao={Boolean(u.com_procuracao)}
                          voto={regVoto?.voto}
                          escolhas={regVoto?.escolhas_json}
                          opcoesPauta={opcoesPautaFoco}
                          modoLista={true}
                          mostrarBlocoPrefix={true}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Modo QR Code Tela Cheia (clicando no QR Code na lateral) */}
      {qrTelaCheia ? (
        <TelaoQrCodeOverlay
          appUrl={APP_PUBLIC_URL}
          dominioLegivel={dominioLegivel}
          convocacaoAtiva={config.convocacao_ativa}
          horarioPrimeira={config.horario_primeira_convocacao}
          horarioSegunda={config.horario_segunda_convocacao}
          serverOffsetMs={serverOffsetMs}
          statusConexao={statusConexao}
          realtimeAtivo={realtimeAtivo}
          confirmadosPortaria={contadoresPresenca.confirmadosPortaria}
          conectadosOnline={contadoresPresenca.conectadosOnline}
          totalPresentes={contadoresPresenca.total}
          totalEscopo={metaEscopo.totalUnidades}
          comProcuracao={contadoresPresenca.comProcuracao}
          totalInadimplentes={config.total_inadimplentes}
          onFechar={() => setQrTelaCheia(false)}
        />
      ) : null}

      {/* Modal Lightbox de Imagem de Opção no Telão */}
      {imagemAmpliadaTelao ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm p-6 flex flex-col items-center justify-center gap-4"
          onClick={() => setImagemAmpliadaTelao(null)}
        >
          <div
            className="w-full max-w-5xl flex items-center justify-between gap-4 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-lg font-extrabold truncate">{imagemAmpliadaTelao.titulo}</p>
            <button
              type="button"
              onClick={() => setImagemAmpliadaTelao(null)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-milano-gold px-4 py-2 text-xs font-black uppercase text-[#0C0C0D]"
            >
              <X className="w-4 h-4" />
              Fechar
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imagemAmpliadaTelao.url}
            alt={imagemAmpliadaTelao.titulo}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[82vh] max-w-full rounded-2xl object-contain shadow-2xl border border-milano-gold/40"
          />
        </div>
      ) : null}
    </div>
  );
}
