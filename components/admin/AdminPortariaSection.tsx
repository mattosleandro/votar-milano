'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileCheck2,
  Search,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  chaveUnidade,
  formatarBloco,
  formatarUnidadeCompleta,
  formatarUnidadeTelaoCompacta,
  obterInfoBloco,
  obterMetadadosEscopo,
  TODOS_OS_BLOCOS,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';
import {
  AssembleiaConfig,
  InadimplenteAdmin,
  PresencaAdmin,
  UnidadeCadastradaAdmin,
} from '@/lib/types';
import { aplicarMascaraCpf, limparCpf } from '@/lib/validators';

interface AdminPortariaSectionProps {
  config: AssembleiaConfig;
  unidades: readonly UnidadeCadastradaAdmin[];
  presencas: readonly PresencaAdmin[];
  inadimplentes: readonly InadimplenteAdmin[];
  onConfirmarPortaria: (dados: {
    bloco: number;
    apartamento: number;
    com_procuracao?: boolean;
    observacao?: string;
  }) => Promise<ResultadoOperacaoAdmin>;
  onRemoverPresenca: (
    presenca: Pick<PresencaAdmin, 'id' | 'bloco' | 'apartamento'>
  ) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

export function AdminPortariaSection({
  config,
  unidades,
  presencas,
  inadimplentes,
  onConfirmarPortaria,
  onRemoverPresenca,
  onNotificar,
}: AdminPortariaSectionProps) {
  const [termoBusca, setTermoBusca] = useState('');
  const [blocoFiltro, setBlocoFiltro] = useState<string>('TODOS');
  const [tipoEntradaPorUnidade, setTipoEntradaPorUnidade] = useState<
    Record<string, boolean>
  >({});
  const [obsProcuracaoPorUnidade, setObsProcuracaoPorUnidade] = useState<
    Record<string, string>
  >({});
  const [chaveProcessando, setChaveProcessando] = useState<string | null>(null);

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
    for (const u of unidades) {
      if (u.is_inadimplente) {
        s.add(chaveUnidade(u.bloco, u.apartamento));
      }
    }
    return s;
  }, [inadimplentes, unidades]);

  const resumoPortaria = useMemo(() => {
    let confirmadosPortaria = 0;
    let conectadosOnline = 0;
    let comProcuracao = 0;

    for (const p of presencas) {
      if (p.is_construtora) continue;
      if (p.confirmado_portaria !== false) confirmadosPortaria += 1;
      if (p.online_conectado) conectadosOnline += 1;
      if (p.com_procuracao) comProcuracao += 1;
    }

    return {
      confirmadosPortaria,
      conectadosOnline,
      aguardandoCelular: Math.max(confirmadosPortaria - conectadosOnline, 0),
      comProcuracao,
    };
  }, [presencas]);

  const unidadesLocalizadas = useMemo(() => {
    const q = termoBusca.trim().toLowerCase();
    const digitos = limparCpf(termoBusca);

    const base = unidades.filter((u) => !u.is_construtora);

    const filtradas = base.filter((u) => {
      if (blocoFiltro !== 'TODOS' && u.bloco !== Number(blocoFiltro)) {
        return false;
      }

      if (!q) {
        return blocoFiltro !== 'TODOS';
      }

      const cpfUnidade = limparCpf(u.cpf);
      const blocoStr = formatarBloco(u.bloco);
      const aptoStr = String(u.apartamento);
      const tagCompacta = `b${blocoStr} a${aptoStr}`;
      const tagCompleta = `bloco ${blocoStr} apto ${aptoStr}`;

      if (digitos.length >= 3 && cpfUnidade.includes(digitos)) {
        return true;
      }

      return (
        u.nome_completo.toLowerCase().includes(q) ||
        aptoStr === q ||
        blocoStr === q ||
        tagCompacta.includes(q) ||
        tagCompleta.includes(q)
      );
    });

    return filtradas.slice(0, 24);
  }, [blocoFiltro, termoBusca, unidades]);

  const handleConfirmarUnidade = async (u: UnidadeCadastradaAdmin) => {
    const k = chaveUnidade(u.bloco, u.apartamento);
    if (chaveProcessando) return;

    setChaveProcessando(k);
    const comProcuracao = Boolean(tipoEntradaPorUnidade[k]);
    const observacao = obsProcuracaoPorUnidade[k] || '';

    const res = await onConfirmarPortaria({
      bloco: u.bloco,
      apartamento: u.apartamento,
      com_procuracao: comProcuracao,
      observacao,
    });
    setChaveProcessando(null);
    onNotificar(res);
  };

  const handleRemoverConfirmacao = async (presenca: PresencaAdmin) => {
    const k = chaveUnidade(presenca.bloco, presenca.apartamento);
    if (chaveProcessando) return;

    setChaveProcessando(k);
    const res = await onRemoverPresenca(presenca);
    setChaveProcessando(null);
    onNotificar(res);
  };

  const presencasMoradoresRecentes = useMemo(() => {
    return presencas
      .filter((p) => !p.is_construtora)
      .slice()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [presencas]);

  const metaEscopo = obterMetadadosEscopo(config.escopo_assembleia);

  return (
    <div className="space-y-6">
      {/* KPIs de Portaria / Recepção */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-violet-200 bg-violet-50/70 p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-violet-800">
            Confirmados no Portão
          </div>
          <div className="mt-1 font-mono text-2xl font-extrabold text-violet-900 tabular-nums">
            {resumoPortaria.confirmadosPortaria}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-violet-700">
            Já aparecem no telão
          </div>
        </div>

        <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-sky-800">
            Conectados no Celular
          </div>
          <div className="mt-1 font-mono text-2xl font-extrabold text-sky-900 tabular-nums">
            {resumoPortaria.conectadosOnline}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-sky-700">
            Validaram o CPF no site
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
            Aguardando Abrir Site
          </div>
          <div className="mt-1 font-mono text-2xl font-extrabold text-amber-900 tabular-nums">
            {resumoPortaria.aguardandoCelular}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-amber-700">
            Liberados na portaria
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
            Com Procuração
          </div>
          <div className="mt-1 font-mono text-2xl font-extrabold text-slate-900 tabular-nums">
            {resumoPortaria.comProcuracao}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            Escopo: {metaEscopo.rotuloCurto}
          </div>
        </div>
      </section>

      {/* Busca Rápida de CPF / Documento / Procuração no Portão */}
      <section className="rounded-2xl border-2 border-[#0C0C0D] bg-white p-5 sm:p-6 shadow-md space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#0C0C0D] px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-[#CCB285]">
              <UserCheck className="h-3.5 w-3.5" />
              Portaria / Recepção • Liberação de Entrada por CPF
            </span>
            <h2 className="mt-2 text-lg sm:text-xl font-extrabold text-slate-900">
              Conferência de Documento ou Procuração do Proprietário
            </h2>
            <p className="mt-0.5 text-xs sm:text-sm text-slate-600">
              Digite o <strong>CPF do proprietário</strong> (do documento ou da procuração) para
              localizar <strong>Bloco, Apartamento e Fase</strong>. Ao confirmar, o morador já
              aparece no <strong>Telão como CONFIRMADO</strong> e fica liberado para validar no
              celular!
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
          <div className="sm:col-span-8">
            <label
              htmlFor="busca-portaria-cpf"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              CPF do Proprietário (ou Nome / Apartamento)
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-3.5 h-5 w-5 text-slate-400" />
              <input
                id="busca-portaria-cpf"
                type="text"
                autoFocus
                value={termoBusca}
                onChange={(e) => {
                  const val = e.target.value;
                  if (/^[\d.\-\s]+$/.test(val) && limparCpf(val).length <= 11) {
                    setTermoBusca(aplicarMascaraCpf(val));
                  } else {
                    setTermoBusca(val);
                  }
                }}
                placeholder="Digite o CPF (000.000.000-00), Nome ou Apto..."
                className="w-full rounded-xl border-2 border-slate-300 bg-slate-50 py-3 pl-11 pr-20 text-base font-bold text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#CCB285]/40"
              />
              {termoBusca && (
                <button
                  type="button"
                  onClick={() => setTermoBusca('')}
                  className="absolute right-3 top-2.5 rounded-lg bg-slate-200 px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-300"
                >
                  Limpar
                </button>
              )}
            </div>
          </div>

          <div className="sm:col-span-4">
            <label
              htmlFor="filtro-bloco-portaria"
              className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-700"
            >
              Ou Filtrar por Bloco
            </label>
            <select
              id="filtro-bloco-portaria"
              value={blocoFiltro}
              onChange={(e) => setBlocoFiltro(e.target.value)}
              className="w-full rounded-xl border-2 border-slate-300 bg-slate-50 px-3.5 py-3 text-base font-bold text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none"
            >
              <option value="TODOS">Todos os Blocos (01 a 34)</option>
              {TODOS_OS_BLOCOS.map((numBloco) => {
                const info = obterInfoBloco(numBloco);
                return (
                  <option key={numBloco} value={numBloco}>
                    Bloco {formatarBloco(numBloco)} (Fase {info.fase} • Mód. {info.modulo})
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Resultados da Busca para Confirmação Imediata */}
        {!termoBusca.trim() && blocoFiltro === 'TODOS' ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-8 text-center">
            <p className="text-sm font-bold text-slate-700">
              Digite o CPF informado pelo morador na entrada ou selecione um Bloco acima.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Total de unidades cadastradas na base: <strong>{unidades.length}</strong> de 544.
            </p>
          </div>
        ) : unidadesLocalizadas.length === 0 ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-center space-y-1">
            <p className="text-sm font-extrabold text-amber-950">
              Nenhuma unidade localizada para &ldquo;{termoBusca}&rdquo;.
            </p>
            <p className="text-xs text-amber-800">
              Verifique o CPF digitado ou filtre pelo Bloco do morador. Caso ainda não esteja
              cadastrado, adicione na aba &ldquo;Cadastro Geral (544)&rdquo;.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {unidadesLocalizadas.map((u) => {
              const k = chaveUnidade(u.bloco, u.apartamento);
              const presencaAtual = mapaPresencas.get(k);
              const inadimplente = setInadimplentes.has(k);
              const noEscopo = unidadePertenceAoEscopo(u, config.escopo_assembleia);
              const processando = chaveProcessando === k;
              const comProcuracao = Boolean(tipoEntradaPorUnidade[k]);
              const obsProcuracao = obsProcuracaoPorUnidade[k] || '';

              return (
                <div
                  key={u.id}
                  className={`rounded-2xl border-2 p-4 sm:p-5 transition flex flex-col justify-between gap-4 ${
                    inadimplente
                      ? 'border-rose-400 bg-rose-50/60'
                      : presencaAtual?.online_conectado
                        ? 'border-sky-500 bg-sky-50/50'
                        : presencaAtual
                          ? 'border-violet-500 bg-violet-50/50'
                          : 'border-slate-300 bg-white hover:border-[#0C0C0D]'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Topo do Card: Bloco | Apto | Fase */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="rounded-xl bg-[#0C0C0D] px-3 py-1.5 font-mono text-sm sm:text-base font-black text-[#CCB285]">
                          {formatarUnidadeTelaoCompacta(u.bloco, u.apartamento)}
                        </span>
                        <div>
                          <div className="text-sm sm:text-base font-extrabold text-slate-900">
                            {formatarUnidadeCompleta(u.bloco, u.apartamento)}
                          </div>
                          <div className="text-xs font-bold text-slate-600">
                            Fase {u.fase} • Módulo {u.modulo}
                          </div>
                        </div>
                      </div>

                      {inadimplente ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1 text-xs font-extrabold uppercase text-white">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Inadimplente
                        </span>
                      ) : presencaAtual?.online_conectado ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-600 px-3 py-1 text-xs font-extrabold uppercase text-white">
                          <Smartphone className="h-3.5 w-3.5" />
                          Conectado no Celular
                        </span>
                      ) : presencaAtual ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-3 py-1 text-xs font-extrabold uppercase text-white">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Confirmado no Telão
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-3 py-1 text-xs font-bold uppercase text-slate-700">
                          Aguardando Entrada
                        </span>
                      )}
                    </div>

                    {/* Dados do Proprietário */}
                    <div className="rounded-xl border border-slate-200 bg-slate-50/90 p-3 space-y-1">
                      <div className="text-xs font-semibold text-slate-500 uppercase">
                        Proprietário / Condômino Cadastrado
                      </div>
                      <div className="text-sm sm:text-base font-extrabold text-slate-900">
                        {u.nome_completo}
                      </div>
                      <div className="font-mono text-xs font-bold text-slate-700">
                        CPF: {aplicarMascaraCpf(u.cpf)}
                      </div>
                    </div>

                    {/* Seletor Titular vs Procuração (quando apto e ainda não confirmado) */}
                    {!inadimplente && noEscopo && !presencaAtual && (
                      <div className="space-y-2 pt-1">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setTipoEntradaPorUnidade((prev) => ({ ...prev, [k]: false }))
                            }
                            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-extrabold transition ${
                              !comProcuracao
                                ? 'border-[#0C0C0D] bg-[#0C0C0D] text-[#CCB285]'
                                : 'border-slate-300 bg-white text-slate-700'
                            }`}
                          >
                            Titular (Documento)
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setTipoEntradaPorUnidade((prev) => ({ ...prev, [k]: true }))
                            }
                            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-extrabold transition inline-flex items-center justify-center gap-1 ${
                              comProcuracao
                                ? 'border-[#0C0C0D] bg-[#0C0C0D] text-[#CCB285]'
                                : 'border-slate-300 bg-white text-slate-700'
                            }`}
                          >
                            <FileCheck2 className="h-3.5 w-3.5" />
                            Com Procuração
                          </button>
                        </div>

                        {comProcuracao && (
                          <input
                            type="text"
                            value={obsProcuracao}
                            onChange={(e) =>
                              setObsProcuracaoPorUnidade((prev) => ({
                                ...prev,
                                [k]: e.target.value,
                              }))
                            }
                            placeholder="Nome do procurador / observação (opcional)..."
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
                          />
                        )}
                      </div>
                    )}
                  </div>

                  {/* Ação de Liberação na Portaria */}
                  <div>
                    {inadimplente ? (
                      <div className="rounded-xl border border-rose-300 bg-rose-100/90 p-3 text-xs font-bold text-rose-950 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0 text-rose-700" />
                        <span>
                          Unidade bloqueada para voto por inadimplência. Encaminhe o morador ao
                          Síndico / Mesa Diretora para regularização.
                        </span>
                      </div>
                    ) : !noEscopo ? (
                      <div className="rounded-xl border border-amber-300 bg-amber-100/80 p-3 text-xs font-bold text-amber-950">
                        Esta unidade (Fase {u.fase} • Módulo {u.modulo}) não pertence ao escopo
                        convocado ({metaEscopo.rotuloCurto}).
                      </div>
                    ) : presencaAtual ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200 bg-white p-3">
                        <div className="text-xs">
                          <span className="font-extrabold text-violet-950 block">
                            {presencaAtual.online_conectado
                              ? '✓ Morador já validou o CPF no celular e está conectado!'
                              : '✓ Presença confirmada no telão! Aguardando morador validar no site.'}
                          </span>
                          {presencaAtual.com_procuracao && (
                            <span className="text-[11px] font-semibold text-slate-600">
                              Representado por Procuração{' '}
                              {presencaAtual.observacao_portaria
                                ? `(${presencaAtual.observacao_portaria})`
                                : ''}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={processando}
                          onClick={() => void handleRemoverConfirmacao(presencaAtual)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Cancelar Entrada
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={processando}
                        onClick={() => void handleConfirmarUnidade(u)}
                        className="w-full min-h-[52px] rounded-xl bg-emerald-600 px-4 py-3 text-sm font-extrabold uppercase tracking-wide text-white shadow-md transition hover:bg-emerald-500 disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        <UserCheck className="h-5 w-5" />
                        {processando
                          ? 'Confirmando Entrada...'
                          : `Confirmar Entrada e Liberar Voto (${formatarUnidadeTelaoCompacta(
                              u.bloco,
                              u.apartamento
                            )})`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Lista de Unidades Confirmadas na Portaria em Tempo Real */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
              <Users className="h-4 w-4 text-[#A88E61]" />
              Unidades Confirmadas na Entrada ({presencasMoradoresRecentes.length})
            </h3>
            <p className="text-xs text-slate-500">
              Acompanhe em tempo real quem já passou pela portaria e quem já conectou o celular no
              site.
            </p>
          </div>
        </div>

        {presencasMoradoresRecentes.length === 0 ? (
          <p className="py-6 text-center text-xs font-semibold text-slate-500">
            Nenhuma unidade confirmada na portaria até o momento.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {presencasMoradoresRecentes.map((pr) => (
              <div
                key={pr.id}
                className={`rounded-xl border p-3 flex items-center justify-between gap-3 ${
                  pr.online_conectado
                    ? 'border-sky-300 bg-sky-50/60'
                    : 'border-violet-300 bg-violet-50/60'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-[#0C0C0D] px-2 py-0.5 font-mono text-xs font-extrabold text-[#CCB285]">
                      {formatarUnidadeTelaoCompacta(pr.bloco, pr.apartamento)}
                    </span>
                    <span className="text-xs font-bold text-slate-600">
                      Fase {pr.fase} • Mód. {pr.modulo}
                    </span>
                    {pr.com_procuracao && (
                      <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-amber-950">
                        Procuração
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs font-extrabold text-slate-900">
                    {pr.nome_completo}
                  </p>
                  <p className="text-[11px] font-semibold">
                    {pr.online_conectado ? (
                      <span className="text-sky-700">● Conectado no celular</span>
                    ) : (
                      <span className="text-violet-700">● Confirmado no portão (aguard. site)</span>
                    )}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void handleRemoverConfirmacao(pr)}
                  title="Remover confirmação"
                  className="rounded-lg p-2 text-slate-400 hover:bg-rose-100 hover:text-rose-700 transition shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
