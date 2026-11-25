'use client';

import React, { useMemo, useState } from 'react';
import {
  Building2,
  Check,
  CheckSquare,
  Trash2,
  Vote,
  XCircle,
} from 'lucide-react';
import {
  chaveUnidade,
  formatarBloco,
  formatarUnidadeCompacta,
  obterInfoBloco,
  obterMetadadosEscopo,
  obterOpcoesPauta,
  obterTipoVotacaoPauta,
  PAVIMENTOS_APARTAMENTOS,
  TODOS_APARTAMENTOS,
  TODOS_OS_BLOCOS,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import {
  EscopoVotacao,
  InadimplenteAdmin,
  OpcaoVoto,
  PautaAssembleia,
  PresencaAdmin,
  VotoUnidade,
} from '@/lib/types';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminConstrutoraSectionProps {
  presencas: readonly PresencaAdmin[];
  inadimplentes: readonly InadimplenteAdmin[];
  pautaAberta: PautaAssembleia | null;
  votos: readonly VotoUnidade[];
  onAdicionarConstrutora: (
    unidades: readonly { bloco: number; apartamento: number }[]
  ) => Promise<ResultadoOperacaoAdmin>;
  onRemoverConstrutora: (ids: readonly string[]) => Promise<ResultadoOperacaoAdmin>;
  onVotarEmLoteConstrutora: (
    pautaId: string,
    escopoPauta: EscopoVotacao,
    voto: OpcaoVoto,
    escolhas?: string[]
  ) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

export function AdminConstrutoraSection({
  presencas,
  inadimplentes,
  pautaAberta,
  votos,
  onAdicionarConstrutora,
  onRemoverConstrutora,
  onVotarEmLoteConstrutora,
  onNotificar,
}: AdminConstrutoraSectionProps) {
  const [blocoSelecionado, setBlocoSelecionado] = useState<number>(1);
  const [aptosMarcados, setAptosMarcados] = useState<number[]>([]);
  const [escolhasLoteConstrutora, setEscolhasLoteConstrutora] = useState<string[]>([]);
  const [processando, setProcessando] = useState(false);
  const [confirmarLimparTodas, setConfirmarLimparTodas] = useState(false);

  const tipoVotacaoAberta = obterTipoVotacaoPauta(pautaAberta);
  const opcoesPautaAberta = useMemo(() => obterOpcoesPauta(pautaAberta), [pautaAberta]);

  const infoBloco = useMemo(() => obterInfoBloco(blocoSelecionado), [blocoSelecionado]);

  const mapaPresencas = useMemo(() => {
    const map = new Map<string, PresencaAdmin>();
    for (const p of presencas) {
      map.set(chaveUnidade(p.bloco, p.apartamento), p);
    }
    return map;
  }, [presencas]);

  const setInadimplentes = useMemo(() => {
    const s = new Set<string>();
    for (const i of inadimplentes) {
      s.add(chaveUnidade(i.bloco, i.apartamento));
    }
    return s;
  }, [inadimplentes]);

  const unidadesConstrutora = useMemo(
    () => presencas.filter((p) => p.is_construtora),
    [presencas]
  );

  const contagemConstrutoraPorBloco = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of unidadesConstrutora) {
      counts.set(p.bloco, (counts.get(p.bloco) ?? 0) + 1);
    }
    return counts;
  }, [unidadesConstrutora]);

  const aptosLivresNoBloco = useMemo(
    () =>
      TODOS_APARTAMENTOS.filter((ap) => {
        const k = chaveUnidade(blocoSelecionado, ap);
        return !mapaPresencas.has(k) && !setInadimplentes.has(k);
      }),
    [blocoSelecionado, mapaPresencas, setInadimplentes]
  );

  const construtoraNoBlocoAtual = useMemo(
    () => unidadesConstrutora.filter((u) => u.bloco === blocoSelecionado),
    [unidadesConstrutora, blocoSelecionado]
  );

  const unidadesAptasNaPautaAberta = useMemo(() => {
    if (!pautaAberta) return [];
    return unidadesConstrutora.filter((u) =>
      unidadePertenceAoEscopo(u, pautaAberta.escopo)
    );
  }, [pautaAberta, unidadesConstrutora]);

  const resumoVotoConstrutoraPautaAberta = useMemo(() => {
    if (!pautaAberta) return { sim: 0, nao: 0, naoVotou: 0 };
    let sim = 0;
    let nao = 0;
    for (const v of votos) {
      if (v.pauta_id !== pautaAberta.id || !v.is_construtora) continue;
      if (v.voto === 'SIM') sim += 1;
      else if (v.voto === 'NAO') nao += 1;
    }
    const naoVotou = Math.max(unidadesAptasNaPautaAberta.length - (sim + nao), 0);
    return { sim, nao, naoVotou };
  }, [pautaAberta, unidadesAptasNaPautaAberta.length, votos]);

  const toggleApartamento = (apto: number) => {
    setAptosMarcados((atual) =>
      atual.includes(apto) ? atual.filter((a) => a !== apto) : [...atual, apto]
    );
  };

  const handleTrocarBloco = (novoBloco: number) => {
    setBlocoSelecionado(novoBloco);
    setAptosMarcados([]);
  };

  const handleCadastrarSelecionados = async () => {
    if (aptosMarcados.length === 0 || processando) return;
    setProcessando(true);
    const res = await onAdicionarConstrutora(
      aptosMarcados.map((ap) => ({ bloco: blocoSelecionado, apartamento: ap }))
    );
    setProcessando(false);
    onNotificar(res);
    if (res.ok) {
      setAptosMarcados([]);
    }
  };

  const handleRemoverIds = async (ids: readonly string[]) => {
    if (ids.length === 0 || processando) return;
    setProcessando(true);
    const res = await onRemoverConstrutora(ids);
    setProcessando(false);
    setConfirmarLimparTodas(false);
    onNotificar(res);
  };

  const handleVotarLote = async (opcao: OpcaoVoto, escolhas?: string[]) => {
    if (!pautaAberta || processando) return;
    setProcessando(true);
    const res = await onVotarEmLoteConstrutora(
      pautaAberta.id,
      pautaAberta.escopo,
      opcao,
      escolhas
    );
    setProcessando(false);
    onNotificar(res);
  };

  const toggleEscolhaLote = (optId: string) => {
    const maxEsc = Math.max(1, pautaAberta?.max_escolhas ?? opcoesPautaAberta.length);
    setEscolhasLoteConstrutora((atual) => {
      if (atual.includes(optId)) return atual.filter((id) => id !== optId);
      if (atual.length >= maxEsc) return atual;
      return [...atual, optId];
    });
  };

  return (
    <div className="space-y-6">
      {/* 1. Painel de Voto em Lote da Construtora */}
      <section className="rounded-2xl border-2 border-[#0C0C0D] bg-[#0C0C0D] p-6 text-white shadow-md">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#CCB285]/20 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-[#CCB285]">
              <Vote className="h-3.5 w-3.5" />
              Voto em Lote da Construtora (1 Voto por Apartamento)
            </div>
            <h2 className="mt-2 text-lg font-extrabold text-white">
              {pautaAberta
                ? `Pauta Aberta: #${String(pautaAberta.ordem).padStart(2, '0')} — ${pautaAberta.titulo}`
                : 'Nenhuma Pauta Aberta no Momento'}
            </h2>
            <p className="mt-1 text-xs text-slate-300">
              {pautaAberta
                ? `Escopo da pauta: ${obterMetadadosEscopo(pautaAberta.escopo).rotuloCurto} • Unidades da Construtora aptas neste escopo: ${unidadesAptasNaPautaAberta.length} de ${unidadesConstrutora.length} cadastrada(s).`
                : `Total de unidades da Construtora credenciadas na assembleia: ${unidadesConstrutora.length}. Abra uma pauta na aba "Pautas & Votação" para registrar o voto em lote.`}
            </p>
          </div>

          {pautaAberta && unidadesAptasNaPautaAberta.length > 0 && (
            <div className="rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-xs">
              <div className="font-semibold text-slate-300">Votos Construtora na Pauta:</div>
              <div className="mt-1 flex items-center gap-3 font-mono font-bold tabular-nums">
                <span className="text-emerald-400">SIM: {resumoVotoConstrutoraPautaAberta.sim}</span>
                <span className="text-rose-400">NÃO: {resumoVotoConstrutoraPautaAberta.nao}</span>
                <span className="text-amber-300">
                  NÃO VOTOU (ABST): {resumoVotoConstrutoraPautaAberta.naoVotou}
                </span>
              </div>
            </div>
          )}
        </div>

        {pautaAberta &&
          (tipoVotacaoAberta === 'SIM_NAO' ? (
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={processando || unidadesAptasNaPautaAberta.length === 0}
                onClick={() => void handleVotarLote('SIM')}
                className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3.5 text-sm font-extrabold uppercase tracking-wide text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-4 w-4" />
                Votar SIM ({unidadesAptasNaPautaAberta.length} aptos)
              </button>

              <button
                type="button"
                disabled={processando || unidadesAptasNaPautaAberta.length === 0}
                onClick={() => void handleVotarLote('NAO')}
                className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-3.5 text-sm font-extrabold uppercase tracking-wide text-white shadow transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <XCircle className="h-4 w-4" />
                Votar NÃO ({unidadesAptasNaPautaAberta.length} aptos)
              </button>
            </div>
          ) : tipoVotacaoAberta === 'MULTIPLA_UNICA' ? (
            <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {opcoesPautaAberta.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={processando || unidadesAptasNaPautaAberta.length === 0}
                  onClick={() => void handleVotarLote('MULTIPLA', [opt.id])}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[#CCB285]/40 bg-white/10 px-4 py-3 text-left text-xs font-extrabold text-white transition hover:bg-[#CCB285] hover:text-[#0C0C0D] disabled:opacity-40"
                >
                  <span className="truncate">
                    [{opt.sigla}] {opt.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px]">
                    ({unidadesAptasNaPautaAberta.length} aptos)
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {opcoesPautaAberta.map((opt) => {
                  const marcada = escolhasLoteConstrutora.includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => toggleEscolhaLote(opt.id)}
                      className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left text-xs font-bold transition ${
                        marcada
                          ? 'border-[#CCB285] bg-[#CCB285] text-[#0C0C0D]'
                          : 'border-white/20 bg-white/5 text-white hover:border-[#CCB285]/60'
                      }`}
                    >
                      <span className="font-mono font-black">[{opt.sigla}]</span>
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={
                  processando ||
                  unidadesAptasNaPautaAberta.length === 0 ||
                  escolhasLoteConstrutora.length === 0
                }
                onClick={() => void handleVotarLote('MULTIPLA', escolhasLoteConstrutora)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-xs font-extrabold uppercase tracking-wide text-white shadow transition hover:bg-emerald-500 disabled:opacity-40"
              >
                <Check className="h-4 w-4" />
                Registrar {escolhasLoteConstrutora.length} Opção(ões) para{' '}
                {unidadesAptasNaPautaAberta.length} aptos
              </button>
            </div>
          ))}
      </section>

      {/* 2. Seletor por Bloco e Apartamento (100% Opcional) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Cadastro Opcional de Unidades da Construtora (Não Vendidas / Não Entregues)
            </h3>
            <p className="text-xs text-slate-600">
              Se a Construtora não possuir unidades para representar, deixe em branco (0 unidades).
              Cada apartamento cadastrado retira a unidade do check-in público e exibe a tag{' '}
              <strong>CONSTRUTORA</strong> no telão e celulares.
            </p>
          </div>
          <span className="rounded-full bg-[#CCB285]/20 px-3 py-1 font-mono text-xs font-extrabold text-slate-900">
            Total Construtora: {unidadesConstrutora.length} unidade(s)
          </span>
        </div>

        {/* Barra de seleção rápida de Bloco */}
        <div className="mb-5">
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-700">
            1. Escolha o Bloco (01 a 34)
          </label>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-9 lg:grid-cols-17">
            {TODOS_OS_BLOCOS.map((b) => {
              const selecionado = b === blocoSelecionado;
              const qtdConst = contagemConstrutoraPorBloco.get(b) ?? 0;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => handleTrocarBloco(b)}
                  className={`relative flex flex-col items-center justify-center rounded-lg border py-2 text-xs font-bold transition ${
                    selecionado
                      ? 'border-[#0C0C0D] bg-[#0C0C0D] text-[#CCB285] shadow-sm'
                      : qtdConst > 0
                        ? 'border-[#CCB285] bg-[#CCB285]/15 text-slate-900 hover:bg-[#CCB285]/25'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <span>B{formatarBloco(b)}</span>
                  {qtdConst > 0 && (
                    <span
                      className={`text-[10px] font-extrabold ${
                        selecionado ? 'text-white' : 'text-[#A88E61]'
                      }`}
                    >
                      {qtdConst} un.
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Matriz dos 16 Apartamentos do Bloco Selecionado */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-extrabold text-slate-900">
                Bloco {infoBloco.blocoFormatado}
              </span>
              <span className="rounded-full bg-[#0C0C0D] px-2.5 py-0.5 text-xs font-bold text-[#CCB285]">
                Fase {infoBloco.fase} • Módulo {infoBloco.modulo}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={aptosLivresNoBloco.length === 0}
                onClick={() => setAptosMarcados([...aptosLivresNoBloco])}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-100 disabled:opacity-40"
              >
                <CheckSquare className="h-3.5 w-3.5 text-[#A88E61]" />
                Selecionar Livres do Bloco ({aptosLivresNoBloco.length})
              </button>

              {aptosMarcados.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAptosMarcados([])}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  Limpar seleção
                </button>
              )}

              {construtoraNoBlocoAtual.length > 0 && (
                <button
                  type="button"
                  disabled={processando}
                  onClick={() =>
                    void handleRemoverIds(construtoraNoBlocoAtual.map((c) => c.id))
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Liberar Bloco ({construtoraNoBlocoAtual.length})
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {PAVIMENTOS_APARTAMENTOS.map((pav) => (
              <div
                key={pav.pavimento}
                className="grid grid-cols-1 items-center gap-2 sm:grid-cols-12"
              >
                <div className="text-xs font-bold text-slate-600 sm:col-span-3">
                  {pav.rotulo}
                </div>
                <div className="grid grid-cols-4 gap-2 sm:col-span-9">
                  {pav.apartamentos.map((ap) => {
                    const chave = chaveUnidade(blocoSelecionado, ap);
                    const presenca = mapaPresencas.get(chave);
                    const ehInadimplente = setInadimplentes.has(chave);
                    const ehConstrutora = Boolean(presenca?.is_construtora);
                    const ehMorador = Boolean(presenca && !presenca.is_construtora);
                    const marcado = aptosMarcados.includes(ap);

                    if (ehConstrutora && presenca) {
                      return (
                        <button
                          key={ap}
                          type="button"
                          disabled={processando}
                          onClick={() => void handleRemoverIds([presenca.id])}
                          title="Clique para remover da Construtora e liberar a unidade"
                          className="flex flex-col items-center justify-center rounded-xl border-2 border-[#CCB285] bg-[#0C0C0D] px-2 py-2.5 text-center transition hover:bg-slate-800"
                        >
                          <span className="font-mono text-sm font-extrabold text-white">
                            {ap}
                          </span>
                          <span className="text-[10px] font-bold uppercase text-[#CCB285]">
                            CONSTRUTORA (×)
                          </span>
                        </button>
                      );
                    }

                    if (ehMorador) {
                      return (
                        <div
                          key={ap}
                          className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-200/70 px-2 py-2.5 text-center opacity-75"
                        >
                          <span className="font-mono text-sm font-bold text-slate-700">{ap}</span>
                          <span className="text-[10px] font-semibold uppercase text-slate-600">
                            Morador
                          </span>
                        </div>
                      );
                    }

                    if (ehInadimplente) {
                      return (
                        <div
                          key={ap}
                          className="flex flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50 px-2 py-2.5 text-center opacity-80"
                        >
                          <span className="font-mono text-sm font-bold text-rose-800">{ap}</span>
                          <span className="text-[10px] font-bold uppercase text-rose-600">
                            Inadimplente
                          </span>
                        </div>
                      );
                    }

                    return (
                      <button
                        key={ap}
                        type="button"
                        onClick={() => toggleApartamento(ap)}
                        className={`flex flex-col items-center justify-center rounded-xl border-2 px-2 py-2.5 text-center transition ${
                          marcado
                            ? 'border-emerald-600 bg-emerald-50 text-emerald-950 shadow-sm'
                            : 'border-slate-200 bg-white text-slate-800 hover:border-[#CCB285]'
                        }`}
                      >
                        <span className="font-mono text-sm font-extrabold">{ap}</span>
                        <span
                          className={`text-[10px] font-bold uppercase ${
                            marcado ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {marcado ? 'Selecionado' : 'Livre'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <span className="text-xs text-slate-600">
              Dica: clique em uma unidade já marcada como <strong>CONSTRUTORA</strong> caso deseje liberá-la individualmente.
            </span>

            <button
              type="button"
              disabled={processando || aptosMarcados.length === 0}
              onClick={() => void handleCadastrarSelecionados()}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0C0C0D] px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-[#CCB285] shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Building2 className="h-4 w-4" />
              {processando
                ? 'Salvando...'
                : `Vincular ${aptosMarcados.length} Unidade(s) à Construtora`}
            </button>
          </div>
        </div>

        {/* Lista consolidada de unidades cadastradas para a Construtora */}
        {unidadesConstrutora.length > 0 && (
          <div className="mt-6">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Unidades Atualmente Representadas pela Construtora ({unidadesConstrutora.length})
              </h4>

              {confirmarLimparTodas ? (
                <div className="flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1">
                  <span className="text-xs font-bold text-rose-900">
                    Liberar todas as {unidadesConstrutora.length} unidades?
                  </span>
                  <button
                    type="button"
                    disabled={processando}
                    onClick={() =>
                      void handleRemoverIds(unidadesConstrutora.map((u) => u.id))
                    }
                    className="rounded bg-rose-600 px-2 py-0.5 text-xs font-bold text-white"
                  >
                    Sim, liberar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmarLimparTodas(false)}
                    className="text-xs font-semibold text-slate-600"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmarLimparTodas(true)}
                  className="text-xs font-bold text-rose-600 hover:underline"
                >
                  Liberar todas da Construtora
                </button>
              )}
            </div>

            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
              {unidadesConstrutora.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={processando}
                  onClick={() => void handleRemoverIds([u.id])}
                  title="Clique para liberar esta unidade"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#CCB285]/60 bg-white px-2.5 py-1 font-mono text-xs font-bold text-slate-900 transition hover:border-rose-400 hover:bg-rose-50 hover:text-rose-800"
                >
                  <span>{formatarUnidadeCompacta(u.bloco, u.apartamento)}</span>
                  <span className="text-slate-400">×</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

