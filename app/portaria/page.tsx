'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  RefreshCw,
  UserCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import { AdminPortariaSection } from '@/components/admin/AdminPortariaSection';
import {
  ResultadoOperacaoAdmin,
  useAssembleiaAdminRealtime,
} from '@/hooks/useAssembleiaAdminRealtime';
import { getSupabaseAuthClient } from '@/lib/supabase';
import { AppRole } from '@/lib/types';

export default function PaginaPortaria() {
  const [autenticado, setAutenticado] = useState(false);
  const [userRole, setUserRole] = useState<AppRole>('');
  const [usuarioEmail, setUsuarioEmail] = useState<string | null>(null);
  const [verificandoSessao, setVerificandoSessao] = useState(true);

  const [email, setEmail] = useState('portaria@portalmilano.com');
  const [senhaDigitada, setSenhaDigitada] = useState('');
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [entrando, setEntrando] = useState(false);
  const [erroLogin, setErroLogin] = useState<string | null>(null);
  const [notificacao, setNotificacao] = useState<
    (ResultadoOperacaoAdmin & { id: number }) | null
  >(null);

  useEffect(() => {
    const supabase = getSupabaseAuthClient();
    let montado = true;

    const validarSessao = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!montado) return;
        const role = (session?.user?.app_metadata?.app_role ?? '') as AppRole;
        if (session && (role === 'portaria' || role === 'admin')) {
          setAutenticado(true);
          setUserRole(role);
          setUsuarioEmail(session.user.email ?? null);
        } else {
          setAutenticado(false);
          setUserRole('');
          setUsuarioEmail(null);
        }
      } finally {
        if (montado) setVerificandoSessao(false);
      }
    };

    void validarSessao();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!montado) return;
      const role = (session?.user?.app_metadata?.app_role ?? '') as AppRole;
      if (session && (role === 'portaria' || role === 'admin')) {
        setAutenticado(true);
        setUserRole(role);
        setUsuarioEmail(session.user.email ?? null);
      } else {
        setAutenticado(false);
        setUserRole('');
        setUsuarioEmail(null);
      }
    });

    return () => {
      montado = false;
      subscription.unsubscribe();
    };
  }, []);

  const notificar = useCallback((res: ResultadoOperacaoAdmin) => {
    setNotificacao({ ...res, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!notificacao) return;
    const t = window.setTimeout(() => {
      setNotificacao((atual) => (atual?.id === notificacao.id ? null : atual));
    }, 5000);
    return () => window.clearTimeout(t);
  }, [notificacao]);

  const {
    config,
    unidadesCadastradas,
    presencas,
    inadimplentes,
    carregandoInicial,
    statusConexao,
    recarregarTudo,
    confirmarPresencaPortaria,
    removerPresencaMesa,
  } = useAssembleiaAdminRealtime(autenticado, userRole || 'portaria');

  const handleAutenticar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (entrando) return;
    setEntrando(true);
    setErroLogin(null);

    try {
      const supabase = getSupabaseAuthClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: senhaDigitada,
      });

      if (error || !data.session) {
        setErroLogin('E-mail ou senha inválidos. Verifique as credenciais da Portaria.');
        return;
      }

      const role = (data.session.user.app_metadata?.app_role ?? '') as AppRole;
      if (role !== 'portaria' && role !== 'admin') {
        await supabase.auth.signOut();
        setErroLogin('Esta conta não tem permissão para acessar a Portaria.');
        return;
      }

      setSenhaDigitada('');
      setUserRole(role);
      setUsuarioEmail(data.session.user.email ?? null);
      setAutenticado(true);
    } catch {
      setErroLogin('Falha de comunicação com o servidor de autenticação.');
    } finally {
      setEntrando(false);
    }
  };

  const handleSair = async () => {
    const supabase = getSupabaseAuthClient();
    await supabase.auth.signOut();
    setAutenticado(false);
    setUserRole('');
    setUsuarioEmail(null);
  };

  if (verificandoSessao) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0C0C0D]">
        <MilanoLogo variant="mark" className="h-14 w-auto animate-pulse" />
      </div>
    );
  }

  if (!autenticado) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0C0C0D] px-4 py-10 text-white">
        <div className="w-full max-w-md rounded-3xl border border-[#CCB285]/30 bg-[#141518] p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center">
            <MilanoLogo variant="dark" className="h-12 w-auto" />
            <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#CCB285]/40 bg-[#CCB285]/10 px-3 py-1 text-[11px] font-extrabold uppercase tracking-widest text-[#CCB285]">
              <UserCheck className="h-3.5 w-3.5" />
              Portaria / Recepção • Assembleia
            </span>
            <h1 className="mt-3 text-xl font-extrabold text-white">
              Confirmação de Entrada no Portão
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Entre com a conta oficial da Portaria (<code className="text-[#CCB285]">portaria@portalmilano.com</code>) ou da Mesa.
            </p>
          </div>

          <form onSubmit={(e) => void handleAutenticar(e)} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="portaria-email"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                E-mail da Portaria
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-[#CCB285]" />
                <input
                  id="portaria-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="portaria@portalmilano.com"
                  className="w-full rounded-xl border border-slate-700 bg-[#0C0C0D] py-3 pl-10 pr-4 text-sm font-semibold text-white focus:border-[#CCB285] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/30"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="portaria-password"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                Senha
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-[#CCB285]" />
                <input
                  id="portaria-password"
                  type={mostrarSenha ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={senhaDigitada}
                  onChange={(e) => {
                    setSenhaDigitada(e.target.value);
                    if (erroLogin) setErroLogin(null);
                  }}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-700 bg-[#0C0C0D] py-3 pl-10 pr-11 font-mono text-sm font-bold text-white focus:border-[#CCB285] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/30"
                />
                <button
                  type="button"
                  onClick={() => setMostrarSenha((v) => !v)}
                  aria-label="Mostrar ou ocultar senha"
                  className="absolute right-3 top-3 text-slate-400 hover:text-white"
                >
                  {mostrarSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {erroLogin && (
              <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 px-3.5 py-2.5 text-xs font-semibold text-rose-200">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{erroLogin}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={entrando}
              className="w-full rounded-xl bg-[#CCB285] py-3.5 text-sm font-black uppercase tracking-wider text-[#0C0C0D] shadow-lg transition hover:bg-[#DFCCA9] disabled:opacity-50"
            >
              {entrando ? 'Autenticando...' : 'Acessar Portaria'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F3EE] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-[#CCB285]/30 bg-[#0C0C0D] text-white shadow-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <MilanoLogo variant="dark" className="h-8 w-auto sm:h-9" />
            <div className="hidden h-6 w-px bg-slate-800 sm:block" />
            <div>
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-[#CCB285]">
                Recepção de Entrada • Portaria
              </span>
              <h1 className="text-xs font-bold text-slate-200 sm:text-sm">
                {usuarioEmail || 'portaria@portalmilano.com'}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                statusConexao === 'AO_VIVO'
                  ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-950/60 text-amber-300'
              }`}
            >
              {statusConexao === 'AO_VIVO' ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {statusConexao === 'AO_VIVO' ? 'Conectado' : 'Reconectando'}
            </span>

            <button
              type="button"
              onClick={() => void recarregarTudo()}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-slate-200 hover:border-[#CCB285]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Atualizar</span>
            </button>

            {userRole === 'admin' && (
              <Link
                href="/admin"
                className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-[#CCB285] hover:border-[#CCB285]"
              >
                Mesa (/admin)
              </Link>
            )}

            <button
              type="button"
              onClick={() => void handleSair()}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:border-rose-500 hover:text-rose-300"
            >
              <Lock className="h-3.5 w-3.5" />
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        {notificacao && (
          <div
            role="status"
            className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-xs font-bold shadow-sm sm:text-sm ${
              notificacao.ok
                ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                : 'border-rose-300 bg-rose-50 text-rose-950'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {notificacao.ok ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="h-5 w-5 shrink-0 text-rose-600" />
              )}
              <span>{notificacao.mensagem}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotificacao(null)}
              className="rounded-lg p-1 hover:bg-black/5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {carregandoInicial ? (
          <div className="rounded-2xl border border-slate-200 bg-white py-16 text-center text-sm font-semibold text-slate-500">
            Carregando base de unidades...
          </div>
        ) : (
          <AdminPortariaSection
            config={config}
            unidades={unidadesCadastradas}
            presencas={presencas}
            inadimplentes={inadimplentes}
            onConfirmarPortaria={confirmarPresencaPortaria}
            onRemoverPresenca={removerPresencaMesa}
            onNotificar={notificar}
          />
        )}
      </main>
    </div>
  );
}
