'use client';

import React, { memo } from 'react';
import { FileCheck2 } from 'lucide-react';
import { formatarBloco, formatarUnidadeTelaoCompacta } from '@/lib/condominio';
import { FaseCondominio, ModuloCondominio, OpcaoVoto } from '@/lib/types';

export type DensidadeTelao = 'compacto' | 'confortavel' | 'amplo';

export interface ItemUnidadeBlocoTelao {
  bloco: number;
  apartamento: number;
  presente: boolean;
  onlineConectado: boolean;
  isConstrutora: boolean;
  comProcuracao: boolean;
  voto?: OpcaoVoto;
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
  aguardandoVoto: number;
  procuracoes: number;
}

export function calcularDensidadeTelao(qtdBlocos: number): DensidadeTelao {
  if (qtdBlocos > 18) return 'compacto';
  if (qtdBlocos > 6) return 'confortavel';
  return 'amplo';
}

/**
 * Grid CSS fluido único compartilhado entre todas as abas de blocos do /telao.
 * Usa auto-fill + minmax para se adaptar automaticamente a datashow 16:9, 4:3,
 * notebooks 1366x768, tablets, monitores ultrawide e smartphones.
 */
export function obterClassesGridBlocos(
  densidade: DensidadeTelao,
  painelMaximizado: boolean
): string {
  if (densidade === 'compacto') {
    return painelMaximizado
      ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(min(100%,212px),1fr))] gap-2'
      : 'grid-cols-[repeat(auto-fill,minmax(min(100%,204px),1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(min(100%,210px),1fr))] gap-2';
  }
  if (densidade === 'confortavel') {
    return 'grid-cols-[repeat(auto-fill,minmax(min(100%,232px),1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-2.5';
  }
  return 'grid-cols-[repeat(auto-fill,minmax(min(100%,268px),1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(min(100%,310px),1fr))] gap-3';
}

interface TelaoCelulaUnidadeProps {
  bloco: number;
  apartamento: number;
  presente: boolean;
  onlineConectado: boolean;
  isConstrutora: boolean;
  comProcuracao: boolean;
  voto?: OpcaoVoto;
  densidade?: DensidadeTelao | 'lista';
  mostrarBlocoPrefix?: boolean;
}

export const TelaoCelulaUnidade = memo(function TelaoCelulaUnidade({
  bloco,
  apartamento,
  presente,
  onlineConectado,
  isConstrutora,
  comProcuracao,
  voto,
  densidade = 'compacto',
  mostrarBlocoPrefix = false,
}: TelaoCelulaUnidadeProps) {
  let classesCor = 'bg-slate-900/60 border-slate-800/80 text-slate-600';

  if (voto === 'SIM') {
    classesCor =
      'bg-emerald-600 border-emerald-300/90 text-white shadow-sm shadow-emerald-950/80';
  } else if (voto === 'NAO') {
    classesCor =
      'bg-rose-600 border-rose-300/90 text-white shadow-sm shadow-rose-950/80';
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

  const tituloTooltip = isConstrutora
    ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} — Construtora`
    : comProcuracao
      ? `${formatarUnidadeTelaoCompacta(bloco, apartamento)} — Com Procuração`
      : formatarUnidadeTelaoCompacta(bloco, apartamento);

  const classesTamanho =
    densidade === 'lista'
      ? 'min-h-[34px] px-2 py-1.5 gap-1'
      : densidade === 'amplo'
        ? 'min-h-[36px] px-1.5 py-1.5 gap-1'
        : densidade === 'confortavel'
          ? 'min-h-[30px] px-1 py-1 gap-0.5'
          : 'min-h-[24px] 2xl:min-h-[26px] px-0.5 py-0.5 gap-0.5';

  const classesTexto =
    densidade === 'lista'
      ? 'text-xs 2xl:text-sm'
      : densidade === 'amplo'
        ? 'text-xs sm:text-sm 2xl:text-base'
        : densidade === 'confortavel'
          ? 'text-[11px] sm:text-xs 2xl:text-sm'
          : 'text-[10px] sm:text-[11px] 2xl:text-xs';

  const classesSelo =
    densidade === 'amplo' || densidade === 'lista'
      ? 'px-1 py-[1px] text-[9px]'
      : 'px-[3px] py-[1px] text-[8px]';

  return (
    <div
      title={tituloTooltip}
      className={`relative min-w-0 rounded-md border transition-colors duration-150 flex items-center justify-center text-center select-none overflow-hidden ${classesCor} ${destaqueEspecial} ${classesTamanho}`}
    >
      <span
        className={`font-mono font-extrabold tracking-tight tabular-nums leading-none whitespace-nowrap ${classesTexto}`}
      >
        {mostrarBlocoPrefix
          ? formatarUnidadeTelaoCompacta(bloco, apartamento)
          : String(apartamento)}
      </span>

      {comProcuracao && (
        <span
          title="Unidade representada por Procuração"
          className={`inline-flex items-center justify-center rounded bg-amber-300 text-[#0C0C0D] font-black leading-none shrink-0 ${classesSelo}`}
        >
          P
        </span>
      )}

      {isConstrutora && (
        <span
          title="Unidade representada pela Construtora"
          className={`inline-flex items-center justify-center rounded bg-milano-gold text-[#0C0C0D] font-black leading-none shrink-0 ${classesSelo}`}
        >
          C
        </span>
      )}
    </div>
  );
});

interface TelaoBlocoCardProps {
  dados: DadosBlocoTelao;
  densidade: DensidadeTelao;
  exibirResumoVotos: boolean;
}

/**
 * Card único e padronizado de Bloco + Apartamentos do /telao.
 * Utilizado de forma idêntica nas abas "Presentes por Bloco" e "Todos os Blocos",
 * garantindo mesma moldura, mesmo cabeçalho, mesma grade interna de 4 colunas
 * (alinhada aos 4 apartamentos por pavimento) e mesmo rodapé de status.
 */
export const TelaoBlocoCard = memo(function TelaoBlocoCard({
  dados,
  densidade,
  exibirResumoVotos,
}: TelaoBlocoCardProps) {
  const temPresentes = dados.presentesCount > 0;
  const unidadeUnicaFiltrada = dados.unidades.length === 1;

  const pctSim = temPresentes ? (dados.votosSim / dados.presentesCount) * 100 : 0;
  const pctNao = temPresentes ? (dados.votosNao / dados.presentesCount) * 100 : 0;
  const pctAguardando = temPresentes
    ? Math.max(0, 100 - pctSim - pctNao)
    : 0;

  const paddingCard =
    densidade === 'amplo'
      ? 'p-3 gap-2.5'
      : densidade === 'confortavel'
        ? 'p-2.5 gap-2'
        : 'p-2 gap-1.5';

  const tituloBlocoClass =
    densidade === 'amplo'
      ? 'text-sm 2xl:text-base'
      : densidade === 'confortavel'
        ? 'text-xs sm:text-sm'
        : 'text-xs 2xl:text-sm';

  return (
    <article
      className={`rounded-xl border flex flex-col min-w-0 transition-colors ${paddingCard} ${
        temPresentes
          ? 'bg-slate-900/80 border-milano-gold/45 shadow-sm shadow-black/40'
          : 'bg-slate-950/90 border-slate-800/85 opacity-80'
      }`}
    >
      {/* Cabeçalho Unificado do Bloco */}
      <header className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-slate-800/90 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`font-mono font-black tracking-wide text-milano-gold leading-none whitespace-nowrap ${tituloBlocoClass}`}
          >
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

      {/* Grade Interna Organizada de Apartamentos (4 colunas fixas = 4 aptos por pavimento) */}
      <div
        className={`flex-1 grid content-start ${
          unidadeUnicaFiltrada
            ? 'grid-cols-1'
            : 'grid-cols-4'
        } ${densidade === 'compacto' ? 'gap-1' : 'gap-1.5'}`}
      >
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
            densidade={unidadeUnicaFiltrada ? 'amplo' : densidade}
            mostrarBlocoPrefix={false}
          />
        ))}
      </div>

      {/* Rodapé Unificado: Barra de Proporção + Micro-resumo de Votos do Bloco */}
      <footer className="mt-auto pt-1.5 border-t border-slate-800/75 space-y-1 shrink-0">
        <div className="h-1 w-full rounded-full bg-slate-800/90 overflow-hidden flex">
          {temPresentes && exibirResumoVotos ? (
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
                  className="h-full bg-sky-500/65 transition-all duration-300"
                  style={{ width: `${pctAguardando}%` }}
                />
              )}
            </>
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

        {exibirResumoVotos && (
          <div className="flex items-center justify-between gap-1 font-mono text-[9px] font-bold tabular-nums leading-none">
            {temPresentes ? (
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
            ) : (
              <span className="text-slate-600 w-full text-center">Sem presentes</span>
            )}
          </div>
        )}
      </footer>
    </article>
  );
});
