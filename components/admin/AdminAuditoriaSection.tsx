'use client';

import React, { useMemo, useState } from 'react';
import {
  Download,
  History,
  Lock,
  Search,
  ShieldCheck,
  Vote,
} from 'lucide-react';
import {
  formatarBloco,
  formatarUnidadeTelaoCompacta,
  FUSO_HORARIO_OFICIAL,
} from '@/lib/condominio';
import {
  exportarTrilhaAuditoriaOperacoesCsv,
  exportarTrilhaAuditoriaVotosCsv,
} from '@/lib/csv';
import {
  AuditoriaVotoItem,
  OperacaoAssembleiaItem,
  PautaAssembleia,
} from '@/lib/types';

interface AdminAuditoriaSectionProps {
  tituloAssembleia: string;
  pautas: readonly PautaAssembleia[];
  operacoes: readonly OperacaoAssembleiaItem[];
  votosAuditoria: readonly AuditoriaVotoItem[];
}

type SubAbaAuditoria = 'OPERACOES' | 'VOTOS';

function formatarHoraMs(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO_OFICIAL,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(dt);
}

function badgeOperacaoCor(op: string): string {
  switch (op) {
    case 'ABRIR_PAUTA':
      return 'bg-emerald-100 text-emerald-900 border-emerald-300';
    case 'ENCERRAR_PAUTA':
      return 'bg-slate-200 text-slate-900 border-slate-300';
    case 'NOVA_RODADA_PAUTA':
      return 'bg-amber-100 text-amber-950 border-amber-300';
    case 'ENCERRAR_E_ARQUIVAR':
      return 'bg-[#0C0C0D] text-[#CCB285] border-[#CCB285]/60';
    case 'CONFIRMAR_PORTARIA':
      return 'bg-violet-100 text-violet-900 border-violet-300';
    case 'CANCELAR_PORTARIA':
      return 'bg-rose-100 text-rose-900 border-rose-300';
    case 'SNAPSHOT_AUTOMATICO':
      return 'bg-sky-100 text-sky-900 border-sky-300';
    default:
      return 'bg-slate-100 text-slate-800 border-slate-300';
  }
}

export function AdminAuditoriaSection({
  tituloAssembleia,
  pautas,
  operacoes,
  votosAuditoria,
}: AdminAuditoriaSectionProps) {
  const [subAba, setSubAba] = useState<SubAbaAuditoria>('OPERACOES');
  const [busca, setBusca] = useState('');

  const mapaPautas = useMemo(() => {
    const m = new Map<string, PautaAssembleia>();
    for (const p of pautas) m.set(p.id, p);
    return m;
  }, [pautas]);

  const operacoesFiltradas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return operacoes;
    return operacoes.filter((op) => {
      const texto = [
        op.operacao,
        op.actor_email || '',
        op.actor_role || '',
        op.justificativa || '',
        JSON.stringify(op.detalhes || {}),
      ]
        .join(' ')
        .toLowerCase();
      return texto.includes(t);
    });
  }, [busca, operacoes]);

  const votosFiltrados = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return votosAuditoria;
    return votosAuditoria.filter((v) => {
      const pauta = mapaPautas.get(v.pauta_id);
      const texto = [
        `b${formatarBloco(v.bloco)}`,
        `bloco ${v.bloco}`,
        String(v.apartamento),
        v.acao,
        v.voto_anterior || '',
        v.voto_novo || '',
        `rodada ${v.rodada}`,
        v.ip_address || '',
        v.device_name || '',
        pauta?.titulo || '',
      ]
        .join(' ')
        .toLowerCase();
      return texto.includes(t);
    });
  }, [busca, mapaPautas, votosAuditoria]);

  return (
    <div className="space-y-5">
      {/* Cabeçalho Informativo de Imutabilidade */}
      <section className="rounded-2xl border-2 border-[#0C0C0D] bg-[#0C0C0D] p-5 text-white shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-[#CCB285]/20 p-2.5 text-[#CCB285] border border-[#CCB285]/40">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-white">
                  Trilha de Auditoria Jurídica Imutável (Append-Only)
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-950 border border-emerald-500/40 px-2.5 py-0.5 text-[10px] font-black uppercase text-emerald-300">
                  <Lock className="h-3 w-3" />
                  UPDATE / DELETE Bloqueados no Banco
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Todas as ações da Mesa Diretora, liberações da Portaria, novas rodadas, arquivamentos
                com SHA-256 e alterações de voto ficam gravadas permanentemente para conferência de ata.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                exportarTrilhaAuditoriaOperacoesCsv({
                  tituloAssembleia,
                  operacoes,
                  pautas,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#CCB285] px-3.5 py-2 text-xs font-black uppercase tracking-wide text-[#0C0C0D] hover:bg-[#DFCCA9]"
            >
              <Download className="h-3.5 w-3.5" />
              CSV Operações ({operacoes.length})
            </button>

            <button
              type="button"
              onClick={() =>
                exportarTrilhaAuditoriaVotosCsv({
                  tituloAssembleia,
                  votosAuditoria,
                  pautas,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#CCB285]/50 bg-slate-900 px-3.5 py-2 text-xs font-extrabold uppercase tracking-wide text-[#CCB285] hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              CSV Eventos Votos ({votosAuditoria.length})
            </button>
          </div>
        </div>
      </section>

      {/* Controles de Alternância e Busca */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 gap-1">
            <button
              type="button"
              onClick={() => setSubAba('OPERACOES')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-extrabold transition ${
                subAba === 'OPERACOES'
                  ? 'bg-[#0C0C0D] text-[#CCB285] shadow-sm'
                  : 'text-slate-700 hover:bg-slate-200'
              }`}
            >
              <History className="h-3.5 w-3.5" />
              Operações da Mesa &amp; Portaria ({operacoes.length})
            </button>
            <button
              type="button"
              onClick={() => setSubAba('VOTOS')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-extrabold transition ${
                subAba === 'VOTOS'
                  ? 'bg-[#0C0C0D] text-[#CCB285] shadow-sm'
                  : 'text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Vote className="h-3.5 w-3.5" />
              Eventos de Votos ({votosAuditoria.length})
            </button>
          </div>

          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={
                subAba === 'OPERACOES'
                  ? 'Filtrar por operação, e-mail, justificativa ou SHA-256...'
                  : 'Filtrar por Bloco (B26), Apto (101), Rodada, SIM/NÃO ou IP...'
              }
              className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-xs font-medium text-slate-900 focus:border-[#0C0C0D] focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        {subAba === 'OPERACOES' ? (
          operacoesFiltradas.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-10 text-center text-xs font-semibold text-slate-500">
              Nenhuma operação registrada para esta assembleia (a auditoria append-only entrou em
              vigor a partir da V2).
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 font-bold uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="px-3.5 py-2.5">Data/Hora (MS)</th>
                    <th className="px-3.5 py-2.5">Operação</th>
                    <th className="px-3.5 py-2.5">Operador</th>
                    <th className="px-3.5 py-2.5">Justificativa Formal</th>
                    <th className="px-3.5 py-2.5">Detalhes / Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {operacoesFiltradas.map((op) => {
                    const hash =
                      typeof op.detalhes?.sha256_hash === 'string'
                        ? op.detalhes.sha256_hash
                        : typeof op.detalhes?.snapshot_sha256 === 'string'
                          ? op.detalhes.snapshot_sha256
                          : null;
                    return (
                      <tr key={op.id} className="hover:bg-slate-50/80">
                        <td className="whitespace-nowrap px-3.5 py-2.5 font-mono text-[11px] text-slate-700 tabular-nums">
                          {formatarHoraMs(op.recorded_at)}
                        </td>
                        <td className="whitespace-nowrap px-3.5 py-2.5">
                          <span
                            className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-black uppercase ${badgeOperacaoCor(
                              op.operacao
                            )}`}
                          >
                            {op.operacao}
                          </span>
                        </td>
                        <td className="px-3.5 py-2.5">
                          <div className="font-bold text-slate-900">
                            {op.actor_email || op.actor_role || 'sistema'}
                          </div>
                          {op.actor_role && (
                            <div className="text-[10px] uppercase text-slate-500">
                              role: {op.actor_role}
                            </div>
                          )}
                        </td>
                        <td className="px-3.5 py-2.5 text-slate-800 max-w-xs">
                          {op.justificativa || <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3.5 py-2.5 font-mono text-[10px] text-slate-600 max-w-sm">
                          {hash ? (
                            <div className="font-bold text-emerald-800" title={hash}>
                              SHA-256: {hash.slice(0, 20)}…
                            </div>
                          ) : null}
                          <div className="truncate" title={JSON.stringify(op.detalhes)}>
                            {JSON.stringify(op.detalhes)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : votosFiltrados.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-10 text-center text-xs font-semibold text-slate-500">
            Nenhum evento de voto registrado nesta trilha para esta assembleia.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-bold uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-3.5 py-2.5">Data/Hora (MS)</th>
                  <th className="px-3.5 py-2.5">Pauta / Rodada</th>
                  <th className="px-3.5 py-2.5">Unidade</th>
                  <th className="px-3.5 py-2.5">Ação / Transição</th>
                  <th className="px-3.5 py-2.5">Origem / IP / Aparelho</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {votosFiltrados.map((v) => {
                  const pauta = mapaPautas.get(v.pauta_id);
                  return (
                    <tr key={v.id} className="hover:bg-slate-50/80">
                      <td className="whitespace-nowrap px-3.5 py-2.5 font-mono text-[11px] text-slate-700 tabular-nums">
                        {formatarHoraMs(v.recorded_at)}
                      </td>
                      <td className="px-3.5 py-2.5">
                        <div className="font-bold text-slate-900 truncate max-w-[220px]">
                          {pauta ? `#${pauta.ordem} ${pauta.titulo}` : v.pauta_id.slice(0, 8)}
                        </div>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">
                          Rodada {v.rodada}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3.5 py-2.5 font-mono font-extrabold text-slate-900">
                        {formatarUnidadeTelaoCompacta(v.bloco, v.apartamento)}
                        {v.is_construtora && (
                          <span className="ml-1.5 rounded bg-[#0C0C0D] px-1.5 py-0.5 text-[9px] text-[#CCB285]">
                            CONST
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3.5 py-2.5 font-mono text-xs font-bold">
                        <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700">
                          {v.acao}
                        </span>
                        {v.voto_anterior ? (
                          <>
                            <span className="text-slate-400 line-through">{v.voto_anterior}</span>
                            <span className="mx-1 text-slate-400">→</span>
                          </>
                        ) : null}
                        <span
                          className={
                            v.voto_novo === 'SIM'
                              ? 'text-emerald-700'
                              : v.voto_novo === 'NAO'
                                ? 'text-rose-700'
                                : 'text-slate-600'
                          }
                        >
                          {v.voto_novo || 'REMOVIDO'}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 font-mono text-[10px] text-slate-600">
                        <div>
                          role: {v.actor_role || '—'} • IP: {v.ip_address || '—'}
                        </div>
                        <div className="text-slate-400 truncate max-w-[220px]">
                          {v.device_name || '—'}
                          {v.idempotency_key ? ` • idem: ${v.idempotency_key.slice(-8)}` : ''}
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
