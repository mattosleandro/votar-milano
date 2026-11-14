'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  CheckSquare,
  EyeOff,
  Search,
  ShieldAlert,
  Unlock,
} from 'lucide-react';
import {
  chaveUnidade,
  formatarBloco,
  formatarUnidadeCompleta,
  obterInfoBloco,
  PAVIMENTOS_APARTAMENTOS,
  TODOS_APARTAMENTOS,
  TODOS_OS_BLOCOS,
} from '@/lib/condominio';
import {
  AssembleiaConfig,
  InadimplenteAdmin,
  PresencaAdmin,
} from '@/lib/types';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminInadimplentesSectionProps {
  config: AssembleiaConfig;
  inadimplentes: readonly InadimplenteAdmin[];
  presencas: readonly PresencaAdmin[];
  onAdicionarInadimplentes: (
    unidades: readonly { bloco: number; apartamento: number }[],
    observacao?: string
  ) => Promise<ResultadoOperacaoAdmin>;
  onRemoverInadimplentes: (ids: readonly string[]) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

export function AdminInadimplentesSection({
  config,
  inadimplentes,
  presencas,
  onAdicionarInadimplentes,
  onRemoverInadimplentes,
  onNotificar,
}: AdminInadimplentesSectionProps) {
  const [blocoSelecionado, setBlocoSelecionado] = useState<number>(1);
  const [aptosMarcados, setAptosMarcados] = useState<number[]>([]);
  const [observacao, setObservacao] = useState('');
  const [busca, setBusca] = useState('');
  const [processando, setProcessando] = useState(false);

  const infoBloco = useMemo(() => obterInfoBloco(blocoSelecionado), [blocoSelecionado]);

  const mapaInadimplentes = useMemo(() => {
    const m = new Map<string, InadimplenteAdmin>();
    for (const item of inadimplentes) {
      m.set(chaveUnidade(item.bloco, item.apartamento), item);
    }
    return m;
  }, [inadimplentes]);

  const mapaPresencas = useMemo(() => {
    const m = new Map<string, PresencaAdmin>();
    for (const p of presencas) {
      m.set(chaveUnidade(p.bloco, p.apartamento), p);
    }
    return m;
  }, [presencas]);

  const contagemPorBloco = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of inadimplentes) {
      counts.set(item.bloco, (counts.get(item.bloco) ?? 0) + 1);
    }
    return counts;
  }, [inadimplentes]);

  const aptosDisponiveisParaMarcarNoBloco = useMemo(
    () =>
      TODOS_APARTAMENTOS.filter(
        (ap) => !mapaInadimplentes.has(chaveUnidade(blocoSelecionado, ap))
      ),
    [blocoSelecionado, mapaInadimplentes]
  );

  const inadimplentesNoBlocoAtual = useMemo(
    () => inadimplentes.filter((i) => i.bloco === blocoSelecionado),
    [inadimplentes, blocoSelecionado]
  );

  const inadimplentesFiltrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return inadimplentes;
    return inadimplentes.filter((item) => {
      const textoUnidade = `bloco ${formatarBloco(item.bloco)} b${formatarBloco(item.bloco)} ${item.apartamento}`;
      const obs = (item.observacao ?? '').toLowerCase();
      return textoUnidade.includes(termo) || obs.includes(termo);
    });
  }, [inadimplentes, busca]);

  const handleTrocarBloco = (novoBloco: number) => {
    setBlocoSelecionado(novoBloco);
    setAptosMarcados([]);
  };

  const toggleApartamento = (apto: number) => {
    setAptosMarcados((atual) =>
      atual.includes(apto) ? atual.filter((a) => a !== apto) : [...atual, apto]
    );
  };

  const handleBloquearSelecionados = async () => {
    if (aptosMarcados.length === 0 || processando) return;
    setProcessando(true);
    const res = await onAdicionarInadimplentes(
      aptosMarcados.map((ap) => ({ bloco: blocoSelecionado, apartamento: ap })),
      observacao
    );
    setProcessando(false);
    onNotificar(res);
    if (res.ok) {
      setAptosMarcados([]);
      setObservacao('');
    }
  };

  const handleLiberarUnidades = async (ids: readonly string[]) => {
    if (ids.length === 0 || processando) return;
    setProcessando(true);
    const res = await onRemoverInadimplentes(ids);
    setProcessando(false);
    onNotificar(res);
  };

  return (
    <div className="space-y-6">
      {/* Banner Jurídico & Anti-Exposição LGPD */}
      <section className="rounded-2xl border border-amber-300/80 bg-amber-50 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-800">
              <EyeOff className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-amber-950">
                Sigilo Absoluto de Inadimplência (Art. 1.335, III CC &amp; LGPD)
              </h2>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-amber-900">
                Unidades adicionadas abaixo ficam <strong>estritamente impedidas de votar</strong>.
                Tanto no celular dos moradores (<code className="font-mono font-bold">/</code>) quanto
                no projetor (<code className="font-mono font-bold">/telao</code>), o sistema exibe{' '}
                <strong>EXCLUSIVAMENTE a quantidade numérica total</strong>, sem jamais revelar ou
                trafegar o Bloco ou Apartamento.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-right shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Total Público Exibido no Telão/Celular
            </div>
            <div className="font-mono text-2xl font-extrabold text-slate-900 tabular-nums">
              {config.total_inadimplentes}{' '}
              <span className="text-xs font-semibold text-slate-500">unidade(s)</span>
            </div>
          </div>
        </div>
      </section>

      {/* Seletor Rápido por Bloco e Apartamento */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-base font-bold text-slate-900">
            Bloquear Unidades Inadimplentes (Individual ou em Lote por Bloco — Opcional)
          </h3>
          <p className="text-xs text-slate-600">
            Se uma unidade já tiver feito check-in antes do bloqueio, o credenciamento e eventual
            voto em pauta aberta serão revogados automaticamente.
          </p>
        </div>

        {/* Grade de Blocos 01..34 */}
        <div className="mb-5">
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-700">
            1. Escolha o Bloco (01 a 34)
          </label>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-9 lg:grid-cols-17">
            {TODOS_OS_BLOCOS.map((b) => {
              const selecionado = b === blocoSelecionado;
              const qtd = contagemPorBloco.get(b) ?? 0;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => handleTrocarBloco(b)}
                  className={`flex flex-col items-center justify-center rounded-lg border py-2 text-xs font-bold transition ${
                    selecionado
                      ? 'border-[#0C0C0D] bg-[#0C0C0D] text-[#CCB285] shadow-sm'
                      : qtd > 0
                        ? 'border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <span>B{formatarBloco(b)}</span>
                  {qtd > 0 && (
                    <span
                      className={`text-[10px] font-extrabold ${
                        selecionado ? 'text-rose-300' : 'text-rose-600'
                      }`}
                    >
                      {qtd} bloq.
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Matriz 16 Apartamentos */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-extrabold text-slate-900">
                Bloco {infoBloco.blocoFormatado}
              </span>
              <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-bold text-[#CCB285]">
                Fase {infoBloco.fase} • Módulo {infoBloco.modulo}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={aptosDisponiveisParaMarcarNoBloco.length === 0}
                onClick={() => setAptosMarcados([...aptosDisponiveisParaMarcarNoBloco])}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-100 disabled:opacity-40"
              >
                <CheckSquare className="h-3.5 w-3.5 text-rose-600" />
                Selecionar Bloco ({aptosDisponiveisParaMarcarNoBloco.length})
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

              {inadimplentesNoBlocoAtual.length > 0 && (
                <button
                  type="button"
                  disabled={processando}
                  onClick={() =>
                    void handleLiberarUnidades(inadimplentesNoBlocoAtual.map((i) => i.id))
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  Regularizar Bloco ({inadimplentesNoBlocoAtual.length})
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
                    const registroInad = mapaInadimplentes.get(chave);
                    const presencaExistente = mapaPresencas.get(chave);
                    const marcado = aptosMarcados.includes(ap);

                    if (registroInad) {
                      return (
                        <button
                          key={ap}
                          type="button"
                          disabled={processando}
                          onClick={() => void handleLiberarUnidades([registroInad.id])}
                          title="Clique para regularizar e liberar o voto desta unidade"
                          className="flex flex-col items-center justify-center rounded-xl border-2 border-rose-500 bg-rose-600 px-2 py-2.5 text-center text-white transition hover:bg-rose-700"
                        >
                          <span className="font-mono text-sm font-extrabold">{ap}</span>
                          <span className="text-[10px] font-bold uppercase text-rose-100">
                            Bloqueado (Liberar)
                          </span>
                        </button>
                      );
                    }

                    return (
                      <button
                        key={ap}
                        type="button"
                        onClick={() => toggleApartamento(ap)}
                        className={`flex flex-col items-center justify-center rounded-xl border-2 px-2 py-2.5 text-center transition ${
                          marcado
                            ? 'border-rose-600 bg-rose-50 text-rose-950 shadow-sm'
                            : presencaExistente
                              ? 'border-amber-300 bg-amber-50/60 text-slate-800 hover:border-rose-400'
                              : 'border-slate-200 bg-white text-slate-800 hover:border-rose-300'
                        }`}
                      >
                        <span className="font-mono text-sm font-extrabold">{ap}</span>
                        <span
                          className={`text-[10px] font-bold uppercase ${
                            marcado
                              ? 'text-rose-700'
                              : presencaExistente
                                ? 'text-amber-700'
                                : 'text-slate-400'
                          }`}
                        >
                          {marcado
                            ? 'Bloquear'
                            : presencaExistente
                              ? presencaExistente.is_construtora
                                ? 'Construtora'
                                : 'Já c/ Check-in'
                              : 'Adimplente'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-1 items-end gap-3 border-t border-slate-200 pt-4 sm:grid-cols-12">
            <div className="sm:col-span-7">
              <label
                htmlFor="obs-inadimplencia"
                className="mb-1 block text-xs font-bold text-slate-700"
              >
                Observação Interna da Mesa (Opcional — nunca exibida fora do /admin)
              </label>
              <input
                id="obs-inadimplencia"
                type="text"
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                placeholder="Ex.: Relatório financeiro administradora — verificar comprovante se comparecer"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-800 focus:border-[#0C0C0D] focus:outline-none"
              />
            </div>

            <div className="flex sm:col-span-5 sm:justify-end">
              <button
                type="button"
                disabled={processando || aptosMarcados.length === 0}
                onClick={() => void handleBloquearSelecionados()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
              >
                <ShieldAlert className="h-4 w-4" />
                {processando
                  ? 'Bloqueando...'
                  : `Bloquear ${aptosMarcados.length} Unidade(s)`}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Lista Interna da Mesa para Regularização Rápida */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Controle Interno da Mesa — Regularização Instantânea ({inadimplentes.length})
            </h3>
            <p className="text-xs text-slate-500">
              Caso o condômino apresente comprovante de quitação na Mesa, clique em{' '}
              <strong>Regularizar / Liberar</strong> para habilitar seu check-in imediatamente.
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Filtrar bloco ou apto..."
              className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        {inadimplentesFiltrados.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 py-8 text-xs font-semibold text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {inadimplentes.length === 0
              ? 'Nenhuma unidade bloqueada por inadimplência no momento.'
              : 'Nenhuma unidade encontrada para o filtro informado.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {inadimplentesFiltrados.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50/40 px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs font-extrabold text-slate-900">
                    {formatarUnidadeCompleta(item.bloco, item.apartamento)}
                  </div>
                  <div className="truncate text-[11px] text-slate-600">
                    Fase {item.fase} • Módulo {item.modulo}
                    {item.observacao ? ` — ${item.observacao}` : ''}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={processando}
                  onClick={() => void handleLiberarUnidades([item.id])}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-extrabold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Unlock className="h-3 w-3" />
                  Liberar
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

