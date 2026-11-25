'use client';

import React, { useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  FileCheck2,
  Minimize2,
  ShieldAlert,
  Smartphone,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import { TelaoRelogioConvocacao } from '@/components/telao/TelaoClockWidgets';
import { ConexaoRealtimeStatus, ConvocacaoStatus } from '@/lib/types';

interface TelaoQrCodeOverlayProps {
  appUrl: string;
  dominioLegivel: string;
  convocacaoAtiva: ConvocacaoStatus;
  horarioPrimeira: string;
  horarioSegunda: string;
  serverOffsetMs: number;
  statusConexao: ConexaoRealtimeStatus;
  realtimeAtivo: boolean;
  confirmadosPortaria: number;
  conectadosOnline: number;
  totalPresentes: number;
  totalEscopo: number;
  comProcuracao: number;
  totalInadimplentes: number;
  onFechar: () => void;
}

/**
 * Modo QR Code Tela Cheia do /telao:
 * Ocupa 100% da projeção exibindo o QR Code gigante de acesso e exclusivamente
 * os indicadores ao vivo de entrada (validados na portaria e conectados prontos para votar).
 */
export function TelaoQrCodeOverlay({
  appUrl,
  dominioLegivel,
  convocacaoAtiva,
  horarioPrimeira,
  horarioSegunda,
  serverOffsetMs,
  statusConexao,
  realtimeAtivo,
  confirmadosPortaria,
  conectadosOnline,
  totalPresentes,
  totalEscopo,
  comProcuracao,
  totalInadimplentes,
  onFechar,
}: TelaoQrCodeOverlayProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onFechar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFechar]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="QR Code de Acesso em Tela Cheia"
      className="fixed inset-0 z-50 bg-[#0C0C0D] text-white flex flex-col justify-between p-5 sm:p-8 2xl:p-12 overflow-y-auto"
    >
      {/* Topo: Logo + Status Ao Vivo + Botão Fechar */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-milano-gold/25 pb-4 shrink-0">
        <div className="flex items-center gap-4">
          <MilanoLogo variant="dark" className="h-10 sm:h-12 2xl:h-14 w-auto" />
          <div className="hidden sm:block h-8 w-px bg-slate-800" />
          <div className="hidden sm:block">
            <p className="text-xs font-extrabold uppercase tracking-widest text-milano-gold">
              Credenciamento &amp; Acesso à Sala de Votação
            </p>
            <p className="text-xs text-slate-400">
              Confirme sua presença na recepção e aponte a câmera para o QR Code
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border ${
              statusConexao === 'AO_VIVO' && realtimeAtivo
                ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/40'
                : 'bg-amber-950/90 text-amber-300 border-amber-500/40'
            }`}
          >
            {statusConexao === 'AO_VIVO' && realtimeAtivo ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <Wifi className="w-3.5 h-3.5" />
                AO VIVO
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 animate-pulse" />
                AUTO-SYNC
              </>
            )}
          </span>

          <button
            type="button"
            onClick={onFechar}
            className="inline-flex items-center gap-2 rounded-xl bg-milano-gold px-4 py-2 text-xs sm:text-sm font-black uppercase tracking-wider text-[#0C0C0D] shadow-lg transition hover:bg-milano-gold-light"
          >
            <Minimize2 className="w-4 h-4" />
            Voltar ao Painel (ESC)
          </button>
        </div>
      </header>

      {/* Miolo Central: QR Code Gigante à Esquerda + Contadores de Entrada à Direita */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 2xl:gap-12 items-center py-6 max-w-7xl w-full mx-auto">
        {/* Coluna Esquerda: QR Code Gigante */}
        <div className="lg:col-span-6 flex flex-col items-center justify-center text-center space-y-5">
          <p className="text-sm sm:text-base 2xl:text-lg font-extrabold uppercase tracking-widest text-milano-gold-light">
            Aponte a Câmera do Celular para Votar
          </p>

          <div className="rounded-3xl bg-white p-5 sm:p-6 2xl:p-7 shadow-2xl ring-4 ring-milano-gold/50 inline-flex items-center justify-center">
            <QRCodeSVG
              value={appUrl}
              size={320}
              level="H"
              marginSize={1}
              bgColor="#FFFFFF"
              fgColor="#0C0C0D"
              className="w-[min(62vw,300px)] h-[min(62vw,300px)] sm:w-[min(46vh,340px)] sm:h-[min(46vh,340px)] 2xl:w-[380px] 2xl:h-[380px]"
              imageSettings={{
                src: '/brand/logo-mark.png',
                height: 62,
                width: 62,
                excavate: true,
              }}
            />
          </div>

          <div className="inline-flex items-center px-6 py-2.5 rounded-2xl bg-milano-gold/15 border-2 border-milano-gold/70 shadow-lg">
            <span className="font-mono text-xl sm:text-3xl 2xl:text-4xl font-black text-milano-gold tracking-tight">
              {dominioLegivel}
            </span>
          </div>
        </div>

        {/* Coluna Direita: Apenas os Dados de Quem Entrou (caixas uniformes de alto impacto) */}
        <div className="lg:col-span-6 flex flex-col justify-center gap-4 2xl:gap-5 tabular-nums">
          <TelaoRelogioConvocacao
            convocacaoAtiva={convocacaoAtiva}
            horarioPrimeira={horarioPrimeira}
            horarioSegunda={horarioSegunda}
            serverOffsetMs={serverOffsetMs}
          />

          {/* 2 Indicadores Principais: Validados na Portaria vs Conectados Prontos para Votar */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch">
            <div className="rounded-2xl bg-violet-950/55 border-2 border-violet-400/60 p-5 2xl:p-6 flex flex-col justify-between min-h-[164px] shadow-lg">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs sm:text-sm font-black uppercase tracking-wider text-violet-200">
                  Validados na Portaria
                </span>
                <UserCheck className="w-6 h-6 text-violet-300 shrink-0" />
              </div>

              <p className="font-mono text-6xl 2xl:text-7xl font-black text-white leading-none my-2">
                {confirmadosPortaria}
              </p>

              <p className="text-xs font-semibold text-violet-200/90">
                {confirmadosPortaria === 1
                  ? '1 unidade validada na recepção'
                  : `${confirmadosPortaria} unidades validadas na recepção`}
              </p>
            </div>

            <div className="rounded-2xl bg-sky-950/60 border-2 border-sky-400/60 p-5 2xl:p-6 flex flex-col justify-between min-h-[164px] shadow-lg">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs sm:text-sm font-black uppercase tracking-wider text-sky-200">
                  Prontos para Votar
                </span>
                <Smartphone className="w-6 h-6 text-sky-300 shrink-0" />
              </div>

              <p className="font-mono text-6xl 2xl:text-7xl font-black text-white leading-none my-2">
                {conectadosOnline}
              </p>

              <p className="text-xs font-semibold text-sky-200/90">
                {conectadosOnline === 1
                  ? '1 conectado pronto para votar'
                  : `${conectadosOnline} conectados prontos para votar`}
              </p>
            </div>
          </div>

          {/* Faixa Complementar Padronizada (3 caixas de mesma altura) */}
          <div className="grid grid-cols-3 gap-3 items-stretch">
            <div className="rounded-2xl bg-slate-900/90 border border-milano-gold/40 p-4 flex flex-col justify-between min-h-[96px]">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-milano-gold shrink-0" />
                Total Presentes
              </span>
              <p className="font-mono text-2xl 2xl:text-3xl font-black text-white leading-none">
                {totalPresentes}
                <span className="text-xs font-semibold text-slate-400"> / {totalEscopo}</span>
              </p>
            </div>

            <div className="rounded-2xl bg-amber-950/40 border border-amber-400/40 p-4 flex flex-col justify-between min-h-[96px]">
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-200 flex items-center gap-1.5">
                <FileCheck2 className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                Procurações
              </span>
              <p className="font-mono text-2xl 2xl:text-3xl font-black text-amber-200 leading-none">
                {comProcuracao}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-900/90 border border-slate-700/80 p-4 flex flex-col justify-between min-h-[96px]">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                Inadimplentes
              </span>
              <p className="font-mono text-2xl 2xl:text-3xl font-black text-amber-300 leading-none">
                {totalInadimplentes}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Rodapé discreto */}
      <footer className="border-t border-slate-800/80 pt-3 flex items-center justify-between text-xs text-slate-500 shrink-0">
        <span>Milano Condomínio Club • Assembleia Geral</span>
        <span>Clique em &ldquo;Voltar ao Painel&rdquo; ou pressione ESC para ver os blocos</span>
      </footer>
    </div>
  );
}
