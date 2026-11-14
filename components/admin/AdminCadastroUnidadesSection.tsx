'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Edit3,
  FileSpreadsheet,
  PlusCircle,
  Search,
  ShieldAlert,
  Trash2,
  Unlock,
  Upload,
} from 'lucide-react';
import {
  formatarBloco,
  obterInfoBloco,
  TODOS_APARTAMENTOS,
  TODOS_OS_BLOCOS,
} from '@/lib/condominio';
import {
  baixarModeloImportacaoUnidadesCsv,
  exportarCadastroBaseCsv,
} from '@/lib/csv';
import { UnidadeCadastradaAdmin } from '@/lib/types';
import {
  aplicarMascaraCpf,
  limparCpf,
  sanitizarNomeDigitacao,
  validarCpf,
  validarNomeCompleto,
} from '@/lib/validators';
import { ResultadoOperacaoAdmin } from '@/hooks/useAssembleiaAdminRealtime';

interface AdminCadastroUnidadesSectionProps {
  unidades: readonly UnidadeCadastradaAdmin[];
  onSalvarUnidade: (dados: {
    bloco: number;
    apartamento: number;
    nome_completo: string;
    cpf: string;
    is_inadimplente: boolean;
    is_construtora: boolean;
    observacao?: string;
  }) => Promise<ResultadoOperacaoAdmin>;
  onImportarLote: (
    lista: readonly {
      bloco: number;
      apartamento: number;
      nome_completo: string;
      cpf: string;
      is_inadimplente: boolean;
      is_construtora: boolean;
      observacao?: string;
    }[]
  ) => Promise<ResultadoOperacaoAdmin>;
  onAlternarInadimplencia: (
    unidade: UnidadeCadastradaAdmin
  ) => Promise<ResultadoOperacaoAdmin>;
  onRemoverUnidade: (id: string) => Promise<ResultadoOperacaoAdmin>;
  onNotificar: (res: ResultadoOperacaoAdmin) => void;
}

type StatusCadastroUnidade = 'ADIMPLENTE' | 'INADIMPLENTE' | 'CONSTRUTORA';
type FiltroListaUnidades = 'TODAS' | 'ADIMPLENTES' | 'INADIMPLENTES' | 'CONSTRUTORA';

export function AdminCadastroUnidadesSection({
  unidades,
  onSalvarUnidade,
  onImportarLote,
  onAlternarInadimplencia,
  onRemoverUnidade,
  onNotificar,
}: AdminCadastroUnidadesSectionProps) {
  const [bloco, setBloco] = useState<number>(1);
  const [apartamento, setApartamento] = useState<number>(101);
  const [nomeCompleto, setNomeCompleto] = useState('');
  const [cpf, setCpf] = useState('');
  const [statusUnidade, setStatusUnidade] =
    useState<StatusCadastroUnidade>('ADIMPLENTE');
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<FiltroListaUnidades>('TODAS');
  const [operandoId, setOperandoId] = useState<string | null>(null);
  const [importandoCsv, setImportandoCsv] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const infoBloco = useMemo(() => obterInfoBloco(bloco), [bloco]);

  const contadores = useMemo(() => {
    let adimplentes = 0;
    let inadimplentes = 0;
    let construtora = 0;
    for (const u of unidades) {
      if (u.is_construtora) construtora += 1;
      else if (u.is_inadimplente) inadimplentes += 1;
      else adimplentes += 1;
    }
    return {
      total: unidades.length,
      adimplentes,
      inadimplentes,
      construtora,
    };
  }, [unidades]);

  const unidadesFiltradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const digitos = termo.replace(/\D/g, '');

    return unidades.filter((u) => {
      if (filtro === 'ADIMPLENTES' && (u.is_inadimplente || u.is_construtora)) {
        return false;
      }
      if (filtro === 'INADIMPLENTES' && !u.is_inadimplente) return false;
      if (filtro === 'CONSTRUTORA' && !u.is_construtora) return false;

      if (!termo) return true;

      const bFmt = formatarBloco(u.bloco);
      const txtUnidade = `bloco ${bFmt} b${bFmt} ${u.apartamento} a${u.apartamento}`.toLowerCase();
      const matchNome = u.nome_completo.toLowerCase().includes(termo);
      const matchCpf =
        u.cpf.toLowerCase().includes(termo) ||
        (digitos.length >= 2 && u.cpf.includes(digitos));

      return txtUnidade.includes(termo) || matchNome || matchCpf;
    });
  }, [unidades, busca, filtro]);

  const handleSalvarSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const isConstrutora = statusUnidade === 'CONSTRUTORA';
    const isInadimplente = statusUnidade === 'INADIMPLENTE';

    if (!isConstrutora) {
      const valNome = validarNomeCompleto(nomeCompleto);
      if (!valNome.valido) {
        onNotificar({ ok: false, mensagem: valNome.erro || 'Nome inválido.' });
        return;
      }

      const valCpf = validarCpf(cpf);
      if (!valCpf.valido) {
        onNotificar({ ok: false, mensagem: valCpf.erro || 'CPF inválido.' });
        return;
      }
    }

    setSalvando(true);
    const res = await onSalvarUnidade({
      bloco,
      apartamento,
      nome_completo: isConstrutora
        ? nomeCompleto.trim() || 'CONSTRUTORA MILANO'
        : nomeCompleto.trim(),
      cpf: isConstrutora ? 'CONSTRUTORA' : limparCpf(cpf),
      is_inadimplente: isInadimplente,
      is_construtora: isConstrutora,
      observacao,
    });
    setSalvando(false);
    onNotificar(res);

    if (res.ok) {
      setNomeCompleto('');
      setCpf('');
      setObservacao('');
    }
  };

  const carregarParaEdicao = (u: UnidadeCadastradaAdmin) => {
    setBloco(u.bloco);
    setApartamento(u.apartamento);
    setNomeCompleto(u.nome_completo);
    setCpf(u.is_construtora ? '' : aplicarMascaraCpf(u.cpf));
    setStatusUnidade(
      u.is_construtora
        ? 'CONSTRUTORA'
        : u.is_inadimplente
          ? 'INADIMPLENTE'
          : 'ADIMPLENTE'
    );
    setObservacao(u.observacao || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleUploadCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportandoCsv(true);
    try {
      const texto = await file.text();
      const linhas = texto
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      if (linhas.length <= 1) {
        onNotificar({
          ok: false,
          mensagem: 'O arquivo CSV está vazio ou contém apenas o cabeçalho.',
        });
        return;
      }

      const lotes: {
        bloco: number;
        apartamento: number;
        nome_completo: string;
        cpf: string;
        is_inadimplente: boolean;
        is_construtora: boolean;
        observacao?: string;
      }[] = [];

      const linhasIgnoradas: string[] = [];

      // Ignora linha 0 (cabeçalho)
      for (let i = 1; i < linhas.length; i += 1) {
        const separador = linhas[i].includes(';') ? ';' : ',';
        const cols = linhas[i]
          .split(separador)
          .map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));

        if (cols.length < 4) {
          linhasIgnoradas.push(`Linha ${i + 1} (colunas insuficientes)`);
          continue;
        }

        const numBloco = Number(cols[0].replace(/\D/g, ''));
        const numApto = Number(cols[1].replace(/\D/g, ''));
        if (
          !Number.isInteger(numBloco) ||
          numBloco < 1 ||
          numBloco > 34 ||
          !TODOS_APARTAMENTOS.includes(numApto)
        ) {
          linhasIgnoradas.push(`Linha ${i + 1} (Bloco/Apto inválido: ${cols[0]}/${cols[1]})`);
          continue;
        }

        // Suporta tanto formato (Bloco;Apto;Nome;CPF;Status;Obs) quanto (Bloco;Apto;Fase;Modulo;Nome;CPF;Status;Obs)
        let colNome = cols[2] || '';
        let colCpf = cols[3] || '';
        let colStatus = (cols[4] || 'ADIMPLENTE').toUpperCase();
        let colObs = cols[5] || '';

        if (/^[12]$/.test(cols[2]) && /^[1-4]$/.test(cols[3]) && cols.length >= 6) {
          colNome = cols[4] || '';
          colCpf = cols[5] || '';
          colStatus = (cols[6] || 'ADIMPLENTE').toUpperCase();
          colObs = cols[7] || '';
        }

        const ehConstrutora =
          colStatus.includes('CONSTRUTORA') ||
          colCpf.toUpperCase().includes('CONSTRUTORA');
        const ehInadimplente = !ehConstrutora && colStatus.includes('INADIMPLENTE');
        let cpfDigitos = limparCpf(colCpf);

        // Recupera zeros à esquerda removidos automaticamente pelo Excel (ex.: 9 ou 10 dígitos -> 11 dígitos)
        if (!ehConstrutora && cpfDigitos.length >= 8 && cpfDigitos.length < 11) {
          cpfDigitos = cpfDigitos.padStart(11, '0');
        }

        if (!ehConstrutora && cpfDigitos.length !== 11) {
          linhasIgnoradas.push(
            `Linha ${i + 1} (B${formatarBloco(numBloco)} A${numApto}: CPF inválido "${colCpf}")`
          );
          continue;
        }

        lotes.push({
          bloco: numBloco,
          apartamento: numApto,
          nome_completo: ehConstrutora
            ? colNome || 'CONSTRUTORA MILANO'
            : colNome || `Condômino B${formatarBloco(numBloco)} AP ${numApto}`,
          cpf: ehConstrutora ? 'CONSTRUTORA' : cpfDigitos,
          is_inadimplente: ehInadimplente,
          is_construtora: ehConstrutora,
          observacao: colObs || undefined,
        });
      }

      const res = await onImportarLote(lotes);
      if (res.ok && linhasIgnoradas.length > 0) {
        onNotificar({
          ok: true,
          mensagem: `${res.mensagem} Atenção: ${linhasIgnoradas.length} linha(s) foram ignoradas (${linhasIgnoradas.slice(0, 3).join('; ')}${linhasIgnoradas.length > 3 ? '...' : ''}).`,
        });
      } else {
        onNotificar(res);
      }
    } catch (err) {
      onNotificar({
        ok: false,
        mensagem:
          err instanceof Error ? err.message : 'Erro ao processar arquivo CSV.',
      });
    } finally {
      setImportandoCsv(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Formulário de Cadastro / Atualização de Condômino e Unidade */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">
              Cadastro Geral de Condôminos, Unidades e Inadimplentes
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              Cadastre os apartamentos com CPF, Bloco, Apartamento e Nome Completo. No check-in (
              <code className="font-mono font-bold">/</code>), o morador precisará digitar{' '}
              <strong>apenas o CPF</strong> para confirmar sua unidade ou ver o aviso de bloqueio
              se estiver inadimplente.
            </p>
          </div>

          {/* Botões de Importação / Exportação em Lote */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => baixarModeloImportacaoUnidadesCsv()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-100"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-[#A88E61]" />
              Baixar Modelo CSV
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void handleUploadCsv(e)}
              className="hidden"
            />
            <button
              type="button"
              disabled={importandoCsv}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#0C0C0D] bg-white px-3.5 py-2 text-xs font-extrabold text-slate-900 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5 text-[#A88E61]" />
              {importandoCsv ? 'Importando...' : 'Importar Planilha CSV'}
            </button>

            {unidades.length > 0 && (
              <button
                type="button"
                onClick={() => exportarCadastroBaseCsv(unidades)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-bold text-[#CCB285] transition hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5" />
                Exportar Base ({unidades.length})
              </button>
            )}
          </div>
        </div>

        <form
          onSubmit={(e) => void handleSalvarSubmit(e)}
          className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 lg:grid-cols-12"
        >
          <div className="lg:col-span-2">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-700">
              Bloco *
            </label>
            <select
              value={bloco}
              onChange={(e) => setBloco(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-900"
            >
              {TODOS_OS_BLOCOS.map((b) => (
                <option key={b} value={b}>
                  Bloco {formatarBloco(b)}
                </option>
              ))}
            </select>
            <span className="mt-1 inline-block text-[11px] font-bold text-[#A88E61]">
              Fase {infoBloco.fase} • Módulo {infoBloco.modulo}
            </span>
          </div>

          <div className="lg:col-span-2">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-700">
              Apartamento *
            </label>
            <select
              value={apartamento}
              onChange={(e) => setApartamento(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm font-bold text-slate-900"
            >
              {TODOS_APARTAMENTOS.map((ap) => (
                <option key={ap} value={ap}>
                  Apto {ap}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-700">
              Situação da Unidade *
            </label>
            <select
              value={statusUnidade}
              onChange={(e) =>
                setStatusUnidade(e.target.value as StatusCadastroUnidade)
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-900"
            >
              <option value="ADIMPLENTE">✅ Adimplente (Apto a Votar)</option>
              <option value="INADIMPLENTE">🚫 Inadimplente (Bloqueado)</option>
              <option value="CONSTRUTORA">🏢 Unidade da Construtora</option>
            </select>
          </div>

          <div className="lg:col-span-3">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-700">
              Nome Completo {statusUnidade !== 'CONSTRUTORA' ? '*' : ''}
            </label>
            <input
              type="text"
              required={statusUnidade !== 'CONSTRUTORA'}
              value={nomeCompleto}
              onChange={(e) =>
                setNomeCompleto(sanitizarNomeDigitacao(e.target.value))
              }
              placeholder={
                statusUnidade === 'CONSTRUTORA'
                  ? 'CONSTRUTORA MILANO'
                  : 'Nome e Sobrenome do Condômino'
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900"
            />
          </div>

          <div className="lg:col-span-2">
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-700">
              CPF {statusUnidade !== 'CONSTRUTORA' ? '*' : ''}
            </label>
            <input
              type="text"
              inputMode="numeric"
              disabled={statusUnidade === 'CONSTRUTORA'}
              required={statusUnidade !== 'CONSTRUTORA'}
              value={
                statusUnidade === 'CONSTRUTORA' ? 'CONSTRUTORA' : cpf
              }
              onChange={(e) => setCpf(aplicarMascaraCpf(e.target.value))}
              placeholder="000.000.000-00"
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm font-bold text-slate-900 disabled:bg-slate-100"
            />
          </div>

          <div className="lg:col-span-9">
            <label className="mb-1 block text-xs font-bold text-slate-600">
              Observação Interna da Mesa (Opcional — ex.: acordo financeiro / procuração)
            </label>
            <input
              type="text"
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Anotação restrita à Mesa Diretora..."
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-800"
            />
          </div>

          <div className="flex items-end lg:col-span-3">
            <button
              type="submit"
              disabled={salvando}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0C0C0D] px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-[#CCB285] shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
            >
              <PlusCircle className="h-4 w-4" />
              {salvando ? 'Salvando...' : 'Salvar Unidade na Base'}
            </button>
          </div>
        </form>
      </section>

      {/* 2. Listagem, Busca e Liberação Instantânea de Inadimplentes pelo Síndico */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar unidade cadastrada por CPF, Nome, Bloco (ex: B26) ou Apto (ex: 101)..."
              className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-10 pr-4 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'TODAS', rotulo: `Todas (${contadores.total})` },
                {
                  id: 'ADIMPLENTES',
                  rotulo: `Adimplentes (${contadores.adimplentes})`,
                },
                {
                  id: 'INADIMPLENTES',
                  rotulo: `Inadimplentes (${contadores.inadimplentes})`,
                },
                {
                  id: 'CONSTRUTORA',
                  rotulo: `Construtora (${contadores.construtora})`,
                },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFiltro(f.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  filtro === f.id
                    ? 'bg-[#0C0C0D] text-[#CCB285]'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {f.rotulo}
              </button>
            ))}
          </div>
        </div>

        {unidadesFiltradas.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-10 text-center text-xs font-semibold text-slate-500">
            {unidades.length === 0
              ? 'Nenhuma unidade cadastrada na base ainda. Cadastre no formulário acima ou importe uma planilha CSV.'
              : 'Nenhuma unidade localizada para a busca informada.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-bold uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-4 py-3">Unidade</th>
                  <th className="px-4 py-3">Fase / Módulo</th>
                  <th className="px-4 py-3">Nome Completo</th>
                  <th className="px-4 py-3">CPF</th>
                  <th className="px-4 py-3">Status Votação</th>
                  <th className="px-4 py-3 text-right">Ações / Síndico</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {unidadesFiltradas.map((u) => {
                  const operando = operandoId === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-slate-50/80">
                      <td className="whitespace-nowrap px-4 py-3 font-mono font-extrabold text-slate-900">
                        B{formatarBloco(u.bloco)} | A{u.apartamento}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="rounded bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">
                          Fase {u.fase} • Mód. {u.modulo}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-900">{u.nome_completo}</div>
                        {u.observacao && (
                          <div className="text-[11px] text-slate-500">{u.observacao}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-slate-700">
                        {u.is_construtora ? 'CONSTRUTORA' : aplicarMascaraCpf(u.cpf)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {u.is_construtora ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#0C0C0D] px-2.5 py-0.5 text-[11px] font-extrabold text-[#CCB285]">
                            CONSTRUTORA
                          </span>
                        ) : u.is_inadimplente ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-extrabold text-rose-800">
                            <ShieldAlert className="h-3 w-3" />
                            INADIMPLENTE (BLOQUEADO)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-extrabold text-emerald-800">
                            <CheckCircle2 className="h-3 w-3" />
                            ADIMPLENTE (APTO)
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {!u.is_construtora && (
                            <button
                              type="button"
                              disabled={operando}
                              onClick={async () => {
                                setOperandoId(u.id);
                                const res = await onAlternarInadimplencia(u);
                                setOperandoId(null);
                                onNotificar(res);
                              }}
                              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-bold transition ${
                                u.is_inadimplente
                                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                                  : 'border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                              }`}
                            >
                              {u.is_inadimplente ? (
                                <>
                                  <Unlock className="h-3.5 w-3.5" />
                                  Liberar Voto (Síndico)
                                </>
                              ) : (
                                <>
                                  <ShieldAlert className="h-3.5 w-3.5" />
                                  Bloquear Inadimplente
                                </>
                              )}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => carregarParaEdicao(u)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700 hover:bg-slate-50"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            Editar
                          </button>

                          <button
                            type="button"
                            disabled={operando}
                            onClick={async () => {
                              setOperandoId(u.id);
                              const res = await onRemoverUnidade(u.id);
                              setOperandoId(null);
                              onNotificar(res);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 font-bold text-rose-700 hover:bg-rose-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
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

