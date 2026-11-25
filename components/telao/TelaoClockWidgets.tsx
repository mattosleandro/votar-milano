'use client';

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Timer } from 'lucide-react';
import {
  formatarSegundosMMSS,
  obterEstadoRelogioCampoGrande,
} from '@/lib/condominio';
import { ConvocacaoStatus } from '@/lib/types';

interface TelaoRelogioConvocacaoProps {
  convocacaoAtiva: ConvocacaoStatus;
  horarioPrimeira: string;
  horarioSegunda: string;
  serverOffsetMs: number;
}

/**
 * Componente isolado do relógio de 1 segundo no /telao.
 * Evita re-renderizar a grade de 544 apartamentos a cada segundo!
 */
export const TelaoRelogioConvocacao = memo(function TelaoRelogioConvocacao({
  convocacaoAtiva,
  horarioPrimeira,
  horarioSegunda,
  serverOffsetMs,
}: TelaoRelogioConvocacaoProps) {
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now() + serverOffsetMs);

  useEffect(() => {
    setAgoraMs(Date.now() + serverOffsetMs);
    const id = window.setInterval(() => {
      setAgoraMs(Date.now() + serverOffsetMs);
    }, 1000);
    return () => window.clearInterval(id);
  }, [serverOffsetMs]);

  const estadoRelogio = useMemo(
    () =>
      obterEstadoRelogioCampoGrande(
        {
          convocacao_ativa: convocacaoAtiva,
          horario_primeira_convocacao: horarioPrimeira,
          horario_segunda_convocacao: horarioSegunda,
        },
        agoraMs
      ),
    [agoraMs, convocacaoAtiva, horarioPrimeira, horarioSegunda]
  );

  return (
    <div className="rounded-xl bg-slate-900/95 border border-milano-gold/40 px-3 py-2.5 shadow-md flex flex-col justify-center">
      {estadoRelogio.emContagemRegressiva ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-milano-gold-light">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-milano-gold animate-pulse" />
              Início da {estadoRelogio.alvoConvocacao === 'PRIMEIRA' ? '1ª' : '2ª'} Convocação
            </span>
            <span className="font-mono text-slate-400">
              {estadoRelogio.alvoConvocacao === 'PRIMEIRA' ? horarioPrimeira : horarioSegunda}
            </span>
          </div>
          <div className="flex items-baseline justify-between tabular-nums">
            <span className="text-2xl 2xl:text-3xl font-black font-mono text-white tracking-tight">
              -{estadoRelogio.textoContagem}
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              {estadoRelogio.horaCampoGrande}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 tabular-nums">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-milano-gold-light flex items-center gap-1">
              <Clock className="w-3 h-3 text-milano-gold" />
              Hora Local (MS)
            </p>
            <p className="text-2xl 2xl:text-3xl font-black font-mono text-white tracking-tight mt-0.5">
              {estadoRelogio.horaCampoGrande}
            </p>
          </div>
        </div>
      )}
    </div>
  );
});

interface TelaoTimerVotacaoProps {
  timerDurationSeconds: number;
  timerStartedAt: string | null;
  timerRunning: boolean;
  serverOffsetMs: number;
  onEsgotadoChange?: (esgotado: boolean) => void;
}

/**
 * Componente isolado do contador regressivo de votação no /telao.
 * Só notifica o componente pai na transição esgotado=false <-> true!
 */
export const TelaoTimerVotacao = memo(function TelaoTimerVotacao({
  timerDurationSeconds,
  timerStartedAt,
  timerRunning,
  serverOffsetMs,
  onEsgotadoChange,
}: TelaoTimerVotacaoProps) {
  const [agoraMs, setAgoraMs] = useState<number>(() => Date.now() + serverOffsetMs);
  const ultimoEsgotadoRef = useRef<boolean>(false);

  useEffect(() => {
    setAgoraMs(Date.now() + serverOffsetMs);
    if (!timerRunning) return;
    const id = window.setInterval(() => {
      setAgoraMs(Date.now() + serverOffsetMs);
    }, 1000);
    return () => window.clearInterval(id);
  }, [serverOffsetMs, timerRunning, timerStartedAt]);

  const estado = useMemo(() => {
    const duracaoBase = Math.max(0, Number(timerDurationSeconds ?? 120));
    if (timerRunning && timerStartedAt) {
      const inicioMs = Date.parse(timerStartedAt);
      if (!Number.isNaN(inicioMs)) {
        const decorridos = Math.max(0, Math.floor((agoraMs - inicioMs) / 1000));
        const restantes = Math.max(0, duracaoBase - decorridos);
        return {
          rodando: true,
          esgotado: restantes === 0,
          alertaFinal: restantes > 0 && restantes <= 30,
          formatado: formatarSegundosMMSS(restantes),
        };
      }
    }
    return {
      rodando: false,
      esgotado: false,
      alertaFinal: false,
      formatado: formatarSegundosMMSS(duracaoBase),
    };
  }, [agoraMs, timerDurationSeconds, timerRunning, timerStartedAt]);

  useEffect(() => {
    if (ultimoEsgotadoRef.current !== estado.esgotado) {
      ultimoEsgotadoRef.current = estado.esgotado;
      onEsgotadoChange?.(estado.esgotado);
    }
  }, [estado.esgotado, onEsgotadoChange]);

  return (
    <div
      className={`px-3 py-1.5 rounded-xl border flex items-center gap-2.5 tabular-nums transition-colors ${
        estado.esgotado
          ? 'bg-rose-950/90 border-rose-500 text-rose-200 animate-pulse'
          : estado.alertaFinal
            ? 'bg-amber-950/90 border-amber-400 text-amber-200 animate-pulse'
            : estado.rodando
              ? 'bg-emerald-950/75 border-emerald-500/60 text-emerald-200'
              : 'bg-slate-900 border-slate-700 text-slate-300'
      }`}
    >
      <Timer className="w-5 h-5 text-milano-gold shrink-0" />
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider opacity-85">
          {estado.esgotado
            ? 'Tempo Esgotado'
            : estado.rodando
              ? 'Tempo de Votação'
              : 'Timer Votação'}
        </p>
        <p className="text-xl 2xl:text-2xl font-black font-mono leading-none text-white">
          {estado.formatado}
        </p>
      </div>
    </div>
  );
});
