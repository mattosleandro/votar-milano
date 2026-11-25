'use client';

import React, { memo } from 'react';
import { FileCheck2 } from 'lucide-react';
import {
  formatarBloco,
  formatarUnidadeTelaoCompacta,
  obterPaletaOpcaoMultipla,
} from '@/lib/condominio';
import {
  FaseCondominio,
  ModuloCondominio,
  OpcaoPauta,
  OpcaoVoto,
  TipoVotacaoPauta,
} from '@/lib/types';

export interface ItemUnidadeBlocoTelao {
  bloco: number;
  apartamento: number;
  presente: boolean;
  onlineConectado: boolean;
  isConstrutora: boolean;
  comProcuracao: boolean;
  voto?: OpcaoVoto;
  escolhas?: string[];
}

export interface DadosBlocoTelao {
  bloco: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  unidades: ItemUnidadeBlocoTelao[];
  totalApartamentosBase: number;
  presentesCount: number;
  votosSim: number;
  votosNao: number;
  votosMultipla: number;
  aguardandoVoto: number;
  procuracoes: number;
}

/**
 * Grid fluido ÚNICO e padronizado para todas as abas de blocos do /telao.
 * Mantém exatamente a mesma largura de caixa tanto na aba "Presentes por Bloco"
 * quanto em "Todos os Blocos" (sem esticar caixas quando há poucos blocos),
 * adaptando o número de colunas automaticamente à largura real do datashow,
 * monitor, tablet ou smartphone.
 */
export const CLASSES_GRID_BLOCOS_PADRAO =
  'grid-cols-[repeat(auto-fill,minmax(min(100%,212px),1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(min(100%,218px),1fr))] gap-2';

interface TelaoCelulaUnidadeProps {
  bloco: number;
  apartamento: number;
  presente: boolean;
  onlineConectado: boolean;
  isConstrutora: boolean;
  comProcuracao: boolean;
  voto?: OpcaoVoto;
  escolhas?: string[];
  opcoesPauta?: readonly OpcaoPauta[];
  mostrarBlocoPrefix?: boolean;
  modoLista?: boolean;
}

export const TelaoCelulaUnidade = memo(function TelaoCelulaUnidade({
  bloco,
  apartamento,
  presente,
  onlineConectado,
  isConstrutora,
  comProcuracao,
  voto,
  escolhas,
  opcoesPauta,
  mostrarBlocoPrefix = false,
  modoLista = false,
}: TelaoCelulaUnidadeProps) {
  let classesCor = 'bg-slate-900/60 border-slate-800/80 text-slate-600';
  let seloOpcao: string | null = null;
  let detalheTooltipVoto = '';

  if (voto === 'SIM') {
    classesCor =
      'bg-emerald-600 border-emerald-300/90 text-white shadow-sm shadow-emerald-950/80';
    detalheTooltipVoto = ' — Voto: SIM';
  } else if (voto === 'NAO') {
    classesCor =
      'bg-rose-600 border-rose-300/90 text-white shadow-sm shadow-rose-950/80';
    detalheTooltipVoto = ' — Voto: NÃO';
  } else if (voto === 'MULTIPLA') {
    const listaEscolhas = Array.isArray(escolhas) ? escolhas : [];
    const opcoes = opcoesPauta ?? [];
    if (listaEscolhas.length === 1) {
      const idx = opcoes.findIndex((o) => o.id === listaEscolhas[0]);
      const opt = idx >= 0 ? opcoes[idx] : null;
      const paleta = obterPaletaOpcaoMultipla(idx >= 0 ? idx : 0);
      classesCor = paleta.bgTelaoCell;
      seloOpcao = opt?.sigla ?? '✓';
      detalheTooltipVoto = opt ? ` — Opção ${opt.sigla}: ${opt.label}` : ' — Votou';
    } else if (listaEscolhas.length > 1) {
      classesCor =
        'bg-indigo-600 border-indigo-300/90 text-white shadow-sm shadow-indigo-950/80';
      const siglas = listaEscolhas
        .map((id) => opcoes.find((o) => o.id === id)?.sigla ?? '')
        .filter(Boolean);
      seloOpcao = siglas.length <= 2 ? siglas.join('') : `${listaEscolhas.length}✓`;
      detalheTooltipVoto = ` — ${listaEscolhas.length} opções (${siglas.join(', ')})`;
    } else {
      classesCor =
        'bg-indigo-600 border-indigo-300/90 text-white shadow-sm shadow-indigo-950/80';
      seloOpcao = '✓';
      detalheTooltipVoto = ' — Votou';
    }
  } else if (presente && (onlineConectado || isConstrutora)) {
    classesCor =
      'bg-sky-600 border-sky-300/90 text-white shadow-sm shadow-sky-950/70';
  } else if (presente) {
    classesCor =
      'bg-violet-600 border-violet-300/90 text-white shadow-sm shadow-violet-950/70';
  }

  const destaqueEspecial = isConstrutora
    ? 'ring-1 ring-milano-gold'
    : comProcuracao
      ? 'ring-1 ring-amber-300'
      : '';

  const baseTooltip = isConstrutora
    ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} (Construtora)`
    : comProcuracao
      ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} (Com Procuração)`
      : formatarUnidadeTelaoCompacta(bloco, apartamento);

  return (
    <div
      title={`${baseTooltip}${detalheTooltipVoto}`}
      className={`relative min-w-0 rounded-md border transition-colors duration-150 flex items-center justify-center text-center select-none overflow-hidden ${classesCor} ${destaqueEspecial} ${
        modoLista ? 'h-[34px] px-2 gap-1' : 'h-[26px] px-0.5 gap-0.5'
      }`}
    >
      <span
        className={`font-mono font-extrabold tracking-tight tabular-nums leading-none whitespace-nowrap ${
          modoLista ? 'text-xs' : 'text-[10px] sm:text-[11px]'
        }`}
      >
        {mostrarBlocoPrefix
          ? formatarUnidadeTelaoCompacta(bloco, apartamento)
          : String(apartamento)}
      </span>

      {seloOpcao && (
        <span className="inline-flex items-center justify-center rounded bg-black/30 px-1 py-[1px] font-mono text-[8px] font-black leading-none text-white shrink-0">
          {seloOpcao}
        </span>
      )}

      {comProcuracao && (
        <span
          title="Unidade representada por Procuração"
          className="inline-flex items-center justify-center rounded bg-amber-300 text-[#0C0C0D] font-black leading-none shrink-0 px-[3px] py-[1px] text-[8px]"
        >
          P
        </span>
      )}

      {isConstrutora && (
        <span
          title="Unidade representada pela Construtora"
          className="inline-flex items-center justify-center rounded bg-milano-gold text-[#0C0C0D] font-black leading-none shrink-0 px-[3px] py-[1px] text-[8px]"
        >
          C
        </span>
      )}
    </div>
  );
});

interface TelaoBlocoCardProps {
  dados: DadosBlocoTelao;
  exibirResumoVotos: boolean;
  tipoVotacao: TipoVotacaoPauta;
  opcoesPauta?: readonly OpcaoPauta[];
}

/**
 * Card rigorosamente padronizado de Bloco + Apartamentos do /telao.
 * Possui EXATAMENTE a mesma geometria, altura mínima (equivalente a 4 pavimentos),
 * largura, cabeçalho, grade interna de 4 colunas e rodapé em TODAS as abas,
 * eliminando totalmente caixas pequenas ao lado de caixas grandes.
 */
export const TelaoBlocoCard = memo(function TelaoBlocoCard({
  dados,
  exibirResumoVotos,
  tipoVotacao,
  opcoesPauta,
}: TelaoBlocoCardProps) {
  const temPresentes = dados.presentesCount > 0;
  const isMultipla = tipoVotacao !== 'SIM_NAO';

  const pctSim = temPresentes ? (dados.votosSim / dados.presentesCount) * 100 : 0;
  const pctNao = temPresentes ? (dados.votosNao / dados.presentesCount) * 100 : 0;
  const pctMultipla = temPresentes ? (dados.votosMultipla / dados.presentesCount) * 100 : 0;
  const pctAguardando = temPresentes
    ? Math.max(0, 100 - (isMultipla ? pctMultipla : pctSim + pctNao))
    : 0;

  return (
    <article
      className={`rounded-xl border p-2 flex flex-col gap-1.5 min-w-0 transition-colors ${
        temPresentes
          ? 'bg-slate-900/80 border-milano-gold/45 shadow-sm shadow-black/40'
          : 'bg-slate-950/90 border-slate-800/85 opacity-80'
      }`}
    >
      {/* Cabeçalho Unificado (altura fixa idêntica em todos os cards) */}
      <header className="h-6 flex items-center justify-between gap-1.5 pb-1 border-b border-slate-800/90 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-xs font-black tracking-wide text-milano-gold leading-none whitespace-nowrap">
            BL {formatarBloco(dados.bloco)}
          </span>
          <span className="rounded bg-slate-800/90 border border-slate-700/70 px-1.5 py-0.5 font-mono text-[9px] font-bold text-slate-300 leading-none whitespace-nowrap">
            F{dados.fase}·M{dados.modulo}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 font-mono tabular-nums">
          {dados.procuracoes > 0 && (
            <span
              title={`${dados.procuracoes} procuração(ões) neste bloco`}
              className="inline-flex items-center gap-0.5 rounded bg-amber-300/20 border border-amber-300/50 px-1 py-0.5 text-[9px] font-black text-amber-300 leading-none"
            >
              <FileCheck2 className="w-2.5 h-2.5 shrink-0" />
              {dados.procuracoes}P
            </span>
          )}

          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold leading-none ${
              temPresentes
                ? 'bg-milano-gold/20 text-milano-gold-light border border-milano-gold/35'
                : 'bg-slate-900 text-slate-500 border border-slate-800'
            }`}
          >
            {dados.presentesCount}/{dados.totalApartamentosBase}
          </span>
        </div>
      </header>

      {/* Grade Interna Fixa de 4 Colunas com altura mínima uniforme (4 pavimentos x 26px + 3 gaps = 116px) */}
      <div className="min-h-[116px] grid grid-cols-4 content-start gap-1">
        {dados.unidades.map((u) => (
          <TelaoCelulaUnidade
            key={`${u.bloco}-${u.apartamento}`}
            bloco={u.bloco}
            apartamento={u.apartamento}
            presente={u.presente}
            onlineConectado={u.onlineConectado}
            isConstrutora={u.isConstrutora}
            comProcuracao={u.comProcuracao}
            voto={u.voto}
            escolhas={u.escolhas}
            opcoesPauta={opcoesPauta}
            mostrarBlocoPrefix={false}
          />
        ))}
      </div>

      {/* Rodapé Unificado Ancorado (mesma altura em todas as abas) */}
      <footer className="mt-auto pt-1.5 border-t border-slate-800/75 space-y-1 shrink-0">
        <div className="h-1 w-full rounded-full bg-slate-800/90 overflow-hidden flex">
          {temPresentes && exibirResumoVotos ? (
            isMultipla ? (
              <>
                {pctMultipla > 0 && (
                  <div
                    className="h-full bg-indigo-500 transition-all duration-300"
                    style={{ width: `${pctMultipla}%` }}
                  />
                )}
                {pctAguardando > 0 && (
                  <div
                    className="h-full bg-sky-500/60 transition-all duration-300"
                    style={{ width: `${pctAguardando}%` }}
                  />
                )}
              </>
            ) : (
              <>
                {pctSim > 0 && (
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${pctSim}%` }}
                  />
                )}
                {pctNao > 0 && (
                  <div
                    className="h-full bg-rose-500 transition-all duration-300"
                    style={{ width: `${pctNao}%` }}
                  />
                )}
                {pctAguardando > 0 && (
                  <div
                    className="h-full bg-sky-500/60 transition-all duration-300"
                    style={{ width: `${pctAguardando}%` }}
                  />
                )}
              </>
            )
          ) : temPresentes ? (
            <div
              className="h-full bg-milano-gold/75 transition-all duration-300"
              style={{
                width: `${Math.min(
                  100,
                  (dados.presentesCount / Math.max(1, dados.totalApartamentosBase)) * 100
                )}%`,
              }}
            />
          ) : null}
        </div>

        <div className="h-3 flex items-center justify-between gap-1 font-mono text-[9px] font-bold tabular-nums leading-none">
          {exibirResumoVotos ? (
            temPresentes ? (
              isMultipla ? (
                <>
                  <span className={dados.votosMultipla > 0 ? 'text-indigo-300' : 'text-slate-600'}>
                    {dados.votosMultipla} VOT.
                  </span>
                  <span className={dados.aguardandoVoto > 0 ? 'text-sky-300' : 'text-slate-600'}>
                    {dados.aguardandoVoto} AG.
                  </span>
                </>
              ) : (
                <>
                  <span className={dados.votosSim > 0 ? 'text-emerald-300' : 'text-slate-600'}>
                    {dados.votosSim} SIM
                  </span>
                  <span className={dados.votosNao > 0 ? 'text-rose-300' : 'text-slate-600'}>
                    {dados.votosNao} NÃO
                  </span>
                  <span className={dados.aguardandoVoto > 0 ? 'text-sky-300' : 'text-slate-600'}>
                    {dados.aguardandoVoto} AG.
                  </span>
                </>
              )
            ) : (
              <span className="text-slate-600 w-full text-center">Sem presentes</span>
            )
          ) : (
            <span className="text-slate-500 w-full text-center">
              {temPresentes ? `${dados.presentesCount} presente(s)` : 'Sem presentes'}
            </span>
          )}
        </div>
      </footer>
    </article>
  );
});
