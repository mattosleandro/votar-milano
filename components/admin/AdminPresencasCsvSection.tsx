'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Edit3,
  FileSpreadsheet,
  Search,
  Smartphone,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  chaveUnidade,
  formatarBloco,
  formatarUnidadeCompleta,
  obterInfoBloco,
  TODOS_APARTAMENTOS,
  TODOS_OS_BLOCOS,
} from '@/lib/condominio';
import { exportarAuditoriaVotosCsv, exportarListaPresencaCsv } from '@/lib/csv';
import { extrairAssinaturaFisicaAparelho } from '@/lib/deviceTelemetry';
import { PautaAssembleia, PresencaAdmin, VotoUnidade } from '@/lib/types';
import {
  aplicarMascaraCpf,
  sanitizarNomeDigitacao,
  validarCpf,
  validarNomeCompleto,
} from '@/lib/validators';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminPresencasCsvSectionProps {
  presencas: readonly PresencaAdmin[];
  pautas: readonly PautaAssembleia[];
  votos: readonly VotoUnidade[];
  onCredenciarManual: (dados: {
    bloco: number;
    apartamento: number;
    nome_completo: string;
    cpf: string;
  }) => Promise<ResultadoOperacaoAdmin>;
  onAtualizarPresenca: (
    id: string,
    dados: {
      nome_completo: string;
      cpf: string;
      bloco: number;
      apartamento: number;
    }
  ) => Promise<ResultadoOperacaoAdmin>;
  onRemoverPresenca: (
    presenca: Pick<PresencaAdmin, 'id' | 'bloco' | 'apartamento'>
  ) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

type FiltroTipoPresenca = 'TODOS' | 'MORADORES' | 'CONSTRUTORA';

export function AdminPresencasCsvSection({
  presencas,
  pautas,
  votos,
  onCredenciarManual,
  onAtualizarPresenca,
  onRemoverPresenca,
  onNotificar,
}: AdminPresencasCsvSectionProps) {
  const [pautaCsvSelecionada, setPautaCsvSelecionada] = useState<string>('TODAS');
  const [mostrarFormManual, setMostrarFormManual] = useState(false);

  // Estado do Credenciamento Manual
  const [manualBloco, setManualBloco] = useState<number>(1);
  const [manualApto, setManualApto] = useState<number>(101);
  const [manualNome, setManualNome] = useState('');
  const [manualCpf, setManualCpf] = useState('');
  const [salvandoManual, setSalvandoManual] = useState(false);

  // Busca e Filtros
  const [busca, setBusca] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<FiltroTipoPresenca>('TODOS');

  // Edição e Remoção Inline
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState('');
  const [editCpf, setEditCpf] = useState('');
  const [editBloco, setEditBloco] = useState<number>(1);
  const [editApto, setEditApto] = useState<number>(101);
  const [operandoId, setOperandoId] = useState<string | null>(null);
  const [confirmarLiberarId, setConfirmarLiberarId] = useState<string | null>(null);

  const ocupadosSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of presencas) {
      s.add(chaveUnidade(p.bloco, p.apartamento));
    }
    return s;
  }, [presencas]);

  const aptosLivresManual = useMemo(
    () =>
      TODOS_APARTAMENTOS.filter((ap) => !ocupadosSet.has(chaveUnidade(manualBloco, ap))),
    [manualBloco, ocupadosSet]
  );

  const presencasFiltradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const digitosBusca = termo.replace(/\D/g, '');

    return presencas.filter((p) => {
      if (filtroTipo === 'MORADORES' && p.is_construtora) return false;
      if (filtroTipo === 'CONSTRUTORA' && !p.is_construtora) return false;

      if (!termo) return true;

      const unidadeTxt = `bloco ${formatarBloco(p.bloco)} b${formatarBloco(p.bloco)} ${p.apartamento}`.toLowerCase();
      const nomeMatch = p.nome_completo.toLowerCase().includes(termo);
      const cpfMatch =
        p.cpf.toLowerCase().includes(termo) ||
        (digitosBusca.length >= 2 && p.cpf.includes(digitosBusca));

      return unidadeTxt.includes(termo) || nomeMatch || cpfMatch;
    });
  }, [presencas, busca, filtroTipo]);

  const handleCredenciarManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const valNome = validarNomeCompleto(manualNome);
    if (!valNome.valido) {
      onNotificar({ ok: false, mensagem: valNome.erro || 'Nome inválido.' });
      return;
    }

    const valCpf = validarCpf(manualCpf);
    if (!valCpf.valido) {
      onNotificar({ ok: false, mensagem: valCpf.erro || 'CPF inválido.' });
      return;
    }

    setSalvandoManual(true);
    const res = await onCredenciarManual({
      bloco: manualBloco,
      apartamento: manualApto,
      nome_completo: valNome.nomeLimpo,
      cpf: valCpf.cpfLimpo,
    });
    setSalvandoManual(false);
    onNotificar(res);

    if (res.ok) {
      setManualNome('');
      setManualCpf('');
      setMostrarFormManual(false);
    }
  };

  const iniciarEdicao = (p: PresencaAdmin) => {
    setEditandoId(p.id);
    setEditNome(p.nome_completo);
    setEditCpf(p.is_construtora ? 'CONSTRUTORA' : aplicarMascaraCpf(p.cpf));
    setEditBloco(p.bloco);
    setEditApto(p.apartamento);
    setConfirmarLiberarId(null);
  };

  const salvarEdicao = async (p: PresencaAdmin) => {
    if (!p.is_construtora) {
      const valNome = validarNomeCompleto(editNome);
      if (!valNome.valido) {
        onNotificar({ ok: false, mensagem: valNome.erro || 'Nome inválido.' });
        return;
      }
      const valCpf = validarCpf(editCpf);
      if (!valCpf.valido) {
        onNotificar({ ok: false, mensagem: valCpf.erro || 'CPF inválido.' });
        return;
      }
    }

    setOperandoId(p.id);
    const res = await onAtualizarPresenca(p.id, {
      nome_completo: editNome,
      cpf: p.is_construtora ? 'CONSTRUTORA' : editCpf,
      bloco: editBloco,
      apartamento: editApto,
    });
    setOperandoId(null);
    onNotificar(res);
    if (res.ok) {
      setEditandoId(null);
    }
  };

  const confirmarLiberacao = async (p: PresencaAdmin) => {
    setOperandoId(p.id);
    const res = await onRemoverPresenca({
      id: p.id,
      bloco: p.bloco,
      apartamento: p.apartamento,
    });
    setOperandoId(null);
    setConfirmarLiberarId(null);
    onNotificar(res);
  };

  const qtdMoradores = useMemo(
    () => presencas.filter((p) => !p.is_construtora).length,
    [presencas]
  );
  const qtdConstrutora = presencas.length - qtdMoradores;

  const contagemPorAparelho = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of presencas) {
      if (p.is_construtora) continue;
      const hw = extrairAssinaturaFisicaAparelho(p.device_id);
      if (hw) {
        m.set(hw, (m.get(hw) ?? 0) + 1);
      }
    }
    return m;
  }, [presencas]);

  return (
    <div className="space-y-6">
      {/* 1. Exportação Oficial CSV para Ata & Auditoria Jurídica */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-[#0C0C0D] p-2.5 text-[#CCB285]">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                Exportação Oficial para a Ata e Auditoria Jurídica (CSV / Excel)
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Arquivos gerados com codificação UTF-8 BOM para abertura direta no Microsoft Excel,
                contendo Nome Completo, CPF, Unidade, Fase, Módulo, Tipo de Representação e Horário.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4 lg:col-span-5">
            <div>
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800">
                1. Lista de Presença Completa
              </span>
              <p className="mt-1 text-xs text-slate-600">
                Todos os {presencas.length} representantes credenciados ({qtdMoradores} moradores e{' '}
                {qtdConstrutora} unidades da Construtora) para anexo oficial à ata física.
              </p>
            </div>
            <button
              type="button"
              onClick={() => exportarListaPresencaCsv(presencas)}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-[#0C0C0D] px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-[#CCB285] shadow-sm transition hover:bg-slate-800"
            >
              <Download className="h-4 w-4" />
              Baixar CSV — Lista de Presença ({presencas.length})
            </button>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4 lg:col-span-7">
            <div>
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800">
                2. Relatório Auditável de Votos (Geral ou por Pauta)
              </span>
              <p className="mt-1 text-xs text-slate-600">
                Cruza cada voto registrado com o Nome Completo e CPF do representante da unidade.
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <select
                value={pautaCsvSelecionada}
                onChange={(e) => setPautaCsvSelecionada(e.target.value)}
                aria-label="Selecionar pauta para exportação CSV"
                className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-semibold text-slate-900 focus:border-[#0C0C0D] focus:outline-none"
              >
                <option value="TODAS">
                  Todas as Pautas — Auditoria Geral ({votos.length} votos)
                </option>
                {pautas.map((p) => {
                  const qtd = votos.filter((v) => v.pauta_id === p.id).length;
                  return (
                    <option key={p.id} value={p.id}>
                      Pauta #{String(p.ordem).padStart(2, '0')} — {p.titulo.slice(0, 48)} ({qtd}{' '}
                      votos)
                    </option>
                  );
                })}
              </select>

              <button
                type="button"
                onClick={() =>
                  exportarAuditoriaVotosCsv({
                    pautas,
                    votos,
                    presencas,
                    pautaIdFiltro:
                      pautaCsvSelecionada === 'TODAS' ? undefined : pautaCsvSelecionada,
                  })
                }
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition hover:bg-emerald-800"
              >
                <Download className="h-4 w-4" />
                Baixar CSV de Votos
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Suporte de Mesa, Busca, Credenciamento Manual, Edição e Liberação */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Suporte de Mesa — Busca, Correção e Liberação de Unidades ({presencas.length})
            </h3>
            <p className="text-xs text-slate-600">
              Libere imediatamente apartamentos preenchidos por engano ou cadastre manualmente moradores sem celular.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setMostrarFormManual((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#0C0C0D] bg-white px-3.5 py-2 text-xs font-extrabold text-slate-900 transition hover:bg-slate-50"
          >
            <UserPlus className="h-4 w-4 text-[#A88E61]" />
            {mostrarFormManual ? 'Fechar Credenciamento Manual' : 'Credenciar Morador Manualmente'}
          </button>
        </div>

        {/* Formulário de Credenciamento Manual pela Mesa */}
        {mostrarFormManual && (
          <form
            onSubmit={(e) => void handleCredenciarManualSubmit(e)}
            className="mb-6 rounded-2xl border border-[#CCB285] bg-[#CCB285]/10 p-4"
          >
            <div className="mb-3 text-xs font-extrabold uppercase tracking-wider text-slate-900">
              Credenciamento Assistido pela Mesa Diretora
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <label className="mb-1 block text-[11px] font-bold text-slate-700">
                  Nome Completo *
                </label>
                <input
                  type="text"
                  required
                  value={manualNome}
                  onChange={(e) => setManualNome(sanitizarNomeDigitacao(e.target.value))}
                  placeholder="Nome e Sobrenome"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="mb-1 block text-[11px] font-bold text-slate-700">CPF *</label>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={manualCpf}
                  onChange={(e) => setManualCpf(aplicarMascaraCpf(e.target.value))}
                  placeholder="000.000.000-00"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs font-medium text-slate-900"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] font-bold text-slate-700">Bloco *</label>
                <select
                  value={manualBloco}
                  onChange={(e) => {
                    const nb = Number(e.target.value);
                    setManualBloco(nb);
                    const primeiroLivre = TODOS_APARTAMENTOS.find(
                      (ap) => !ocupadosSet.has(chaveUnidade(nb, ap))
                    );
                    if (primeiroLivre) setManualApto(primeiroLivre);
                  }}
                  className="w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-xs font-bold text-slate-900"
                >
                  {TODOS_OS_BLOCOS.map((b) => (
                    <option key={b} value={b}>
                      Bloco {formatarBloco(b)} (F{obterInfoBloco(b).fase}/M
                      {obterInfoBloco(b).modulo})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-1">
                <label className="mb-1 block text-[11px] font-bold text-slate-700">Apto *</label>
                <select
                  value={manualApto}
                  onChange={(e) => setManualApto(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-bold text-slate-900"
                >
                  {(aptosLivresManual.length > 0 ? aptosLivresManual : TODOS_APARTAMENTOS).map(
                    (ap) => (
                      <option key={ap} value={ap}>
                        {ap}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div className="flex items-end sm:col-span-2">
                <button
                  type="submit"
                  disabled={salvandoManual}
                  className="w-full rounded-xl bg-[#0C0C0D] px-3 py-2 text-xs font-extrabold text-[#CCB285] hover:bg-slate-800 disabled:opacity-50"
                >
                  {salvandoManual ? 'Salvando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Barra de Busca e Filtro por Tipo */}
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por Bloco (ex: B26), Apartamento (ex: 101), Nome Completo ou CPF..."
              className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-4 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5">
            {(
              [
                { id: 'TODOS', rotulo: `Todos (${presencas.length})` },
                { id: 'MORADORES', rotulo: `Moradores (${qtdMoradores})` },
                { id: 'CONSTRUTORA', rotulo: `Construtora (${qtdConstrutora})` },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFiltroTipo(f.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  filtroTipo === f.id
                    ? 'bg-[#0C0C0D] text-[#CCB285]'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {f.rotulo}
              </button>
            ))}
          </div>
        </div>

        {/* Tabela Responsiva de Presenças */}
        {presencasFiltradas.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-10 text-center text-xs font-semibold text-slate-500">
            Nenhum representante encontrado para os filtros aplicados.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-bold uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-4 py-3">Unidade</th>
                  <th className="px-4 py-3">Fase / Módulo</th>
                  <th className="px-4 py-3">Representante Credenciado</th>
                  <th className="px-4 py-3">CPF</th>
                  <th className="px-4 py-3">Aparelho / IP (Auditoria)</th>
                  <th className="px-4 py-3 text-right">Ações da Mesa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {presencasFiltradas.map((p) => {
                  const emEdicao = editandoId === p.id;
                  const operando = operandoId === p.id;
                  const hw = extrairAssinaturaFisicaAparelho(p.device_id);
                  const qtdMesmoAparelho = hw ? contagemPorAparelho.get(hw) ?? 1 : 1;

                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80">
                      <td className="whitespace-nowrap px-4 py-3 font-mono font-extrabold text-slate-900">
                        {emEdicao ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={editBloco}
                              onChange={(e) => setEditBloco(Number(e.target.value))}
                              className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                            >
                              {TODOS_OS_BLOCOS.map((b) => (
                                <option key={b} value={b}>
                                  B{formatarBloco(b)}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editApto}
                              onChange={(e) => setEditApto(Number(e.target.value))}
                              className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                            >
                              {TODOS_APARTAMENTOS.map((ap) => (
                                <option key={ap} value={ap}>
                                  {ap}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          formatarUnidadeCompleta(p.bloco, p.apartamento)
                        )}
                      </td>

                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">
                          Fase {p.fase} • Mód. {p.modulo}
                        </span>
                      </td>

                      <td className="px-4 py-3">
                        {emEdicao && !p.is_construtora ? (
                          <input
                            type="text"
                            value={editNome}
                            onChange={(e) => setEditNome(sanitizarNomeDigitacao(e.target.value))}
                            className="w-full min-w-[180px] rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-900"
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{p.nome_completo}</span>
                            {p.is_construtora && (
                              <span className="rounded bg-[#0C0C0D] px-1.5 py-0.5 text-[10px] font-extrabold text-[#CCB285]">
                                CONSTRUTORA
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-700">
                        {emEdicao && !p.is_construtora ? (
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editCpf}
                            onChange={(e) => setEditCpf(aplicarMascaraCpf(e.target.value))}
                            className="w-36 rounded-lg border border-slate-300 px-2.5 py-1 font-mono text-xs text-slate-900"
                          />
                        ) : p.is_construtora ? (
                          'CONSTRUTORA'
                        ) : (
                          aplicarMascaraCpf(p.cpf)
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {p.is_construtora ? (
                          <span className="text-[11px] text-slate-400">Voto em Lote Mesa</span>
                        ) : p.device_name || p.ip_address ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-800">
                              <Smartphone className="h-3 w-3 text-[#A88E61]" />
                              <span>{p.device_name || 'Dispositivo Web'}</span>
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              IP: {p.ip_address || 'N/D'} • ID: {p.device_id || 'N/D'}
                            </div>
                            {qtdMesmoAparelho > 1 && (
                              <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-900">
                                <AlertTriangle className="h-3 w-3 text-amber-600" />
                                Mesmo Aparelho ({qtdMesmoAparelho} unidades)
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">Credenciado pela Mesa</span>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {emEdicao ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={operando}
                              onClick={() => void salvarEdicao(p)}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 font-bold text-white hover:bg-emerald-700"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Salvar
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditandoId(null)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-100"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : confirmarLiberarId === p.id ? (
                          <div className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1">
                            <span className="font-bold text-rose-900">Liberar unidade?</span>
                            <button
                              type="button"
                              disabled={operando}
                              onClick={() => void confirmarLiberacao(p)}
                              className="rounded bg-rose-600 px-2 py-0.5 font-bold text-white hover:bg-rose-700"
                            >
                              Sim
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmarLiberarId(null)}
                              className="font-semibold text-slate-600 hover:text-slate-900"
                            >
                              Não
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5">
                            {!p.is_construtora && (
                              <button
                                type="button"
                                onClick={() => iniciarEdicao(p)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                                Editar
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setConfirmarLiberarId(p.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 font-bold text-rose-700 hover:bg-rose-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Liberar Unidade
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

