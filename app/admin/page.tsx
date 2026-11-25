'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Building2,
  Calendar,
  CheckCircle2,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  ListChecks,
  Lock,
  Mail,
  Menu,
  PlusCircle,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  UserCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { MilanoLogo } from '@/components/MilanoLogo';
import { AdminAuditoriaSection } from '@/components/admin/AdminAuditoriaSection';
import { AdminCadastroUnidadesSection } from '@/components/admin/AdminCadastroUnidadesSection';
import { AdminConstrutoraSection } from '@/components/admin/AdminConstrutoraSection';
import { AdminConvocacoesSection } from '@/components/admin/AdminConvocacoesSection';
import { AdminInadimplentesSection } from '@/components/admin/AdminInadimplentesSection';
import { AdminPautasSection } from '@/components/admin/AdminPautasSection';
import { AdminPortariaSection } from '@/components/admin/AdminPortariaSection';
import { AdminPresencasCsvSection } from '@/components/admin/AdminPresencasCsvSection';
import {
  ResultadoOperacaoAdmin,
  useAssembleiaAdminRealtime,
} from '@/hooks/useAssembleiaAdminRealtime';
import { getSupabaseAuthClient } from '@/lib/supabase';
import { AppRole } from '@/lib/types';

type AbaAdmin =
  | 'CONVOCACOES'
  | 'PORTARIA'
  | 'CADASTRO_BASE'
  | 'PAUTAS'
  | 'CONSTRUTORA'
  | 'INADIMPLENTES'
  | 'PRESENCAS_CSV'
  | 'AUDITORIA';

interface NotificacaoAdmin extends ResultadoOperacaoAdmin {
  id: number;
}

export default function PaginaAdminMesa() {
  const [verificandoSessao, setVerificandoSessao] = useState(true);
  const [autenticado, setAutenticado] = useState(false);
  const [usuarioEmail, setUsuarioEmail] = useState<string | null>(null);

  const [email, setEmail] = useState('admin@portalmilano.com');
  const [senhaDigitada, setSenhaDigitada] = useState('');
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [entrando, setEntrando] = useState(false);
  const [erroLogin, setErroLogin] = useState<string | null>(null);

  const [abaAtiva, setAbaAtiva] = useState<AbaAdmin>('CONVOCACOES');
  const [menuMobileAberto, setMenuMobileAberto] = useState(false);
  const [notificacao, setNotificacao] = useState<NotificacaoAdmin | null>(null);
  const [criandoNovaAsm, setCriandoNovaAsm] = useState(false);

  // Restaura e monitora sessão real do Supabase Auth (JWT assinado + app_metadata.app_role)
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
        if (session && role === 'admin') {
          setAutenticado(true);
          setUsuarioEmail(session.user.email ?? null);
        } else {
          setAutenticado(false);
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
      if (session && role === 'admin') {
        setAutenticado(true);
        setUsuarioEmail(session.user.email ?? null);
      } else {
        setAutenticado(false);
        setUsuarioEmail(null);
      }
    });

    return () => {
      montado = false;
      subscription.unsubscribe();
    };
  }, []);

  const notificar = useCallback((res: ResultadoOperacaoAdmin) => {
    const id = Date.now();
    setNotificacao({ ...res, id });
  }, []);

  useEffect(() => {
    if (!notificacao) return;
    const timer = window.setTimeout(() => {
      setNotificacao((atual) => (atual?.id === notificacao.id ? null : atual));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [notificacao]);

  const {
    assembleias,
    assembleiaAtual,
    assembleiaSelecionadaId,
    setAssembleiaSelecionadaId,
    config,
    unidadesCadastradas,
    presencas,
    inadimplentes,
    pautas,
    votos,
    historicoAssembleias,
    operacoesAuditoria,
    votosAuditoria,
    pautaAberta,
    carregandoInicial,
    erroConexao,
    statusConexao,
    recarregarTudo,
    criarNovaAssembleia,
    salvarConfiguracao,
    controlarTimerTelao,
    salvarUnidadeBase,
    importarUnidadesBaseEmLote,
    alternarInadimplenciaUnidadeBase,
    removerUnidadeBase,
    criarPauta,
    abrirPauta,
    encerrarPauta,
    resetarPauta,
    excluirPauta,
    adicionarUnidadesConstrutora,
    removerUnidadesConstrutora,
    votarEmLoteConstrutora,
    adicionarUnidadesInadimplentes,
    removerUnidadesInadimplentes,
    confirmarPresencaPortaria,
    credenciarManualMesa,
    atualizarPresencaMesa,
    removerPresencaMesa,
    salvarAssembleiaNoHistorico,
    encerrarEArquivarAssembleia,
    resetarAssembleiaParaNova,
    excluirAssembleiaDoHistorico,
  } = useAssembleiaAdminRealtime(autenticado, 'admin');

  const handleLoginAdmin = async (e: React.FormEvent) => {
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
        setErroLogin('E-mail ou senha inválidos. Verifique suas credenciais da Mesa Diretora.');
        return;
      }

      const role = (data.session.user.app_metadata?.app_role ?? '') as AppRole;
      if (role !== 'admin') {
        await supabase.auth.signOut();
        setErroLogin(
          'Esta conta não possui permissão de Administrador da Mesa Diretora (app_role=admin).'
        );
        return;
      }

      setSenhaDigitada('');
      setAutenticado(true);
      setUsuarioEmail(data.session.user.email ?? null);
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
    setUsuarioEmail(null);
  };

  const handleCriarNovaAssembleiaRapida = async () => {
    if (criandoNovaAsm) return;
    setCriandoNovaAsm(true);
    const hojeStr = new Date().toLocaleDateString('pt-BR');
    const res = await criarNovaAssembleia({
      titulo: `Assembleia Geral — ${hojeStr}`,
      escopo: 'TODOS',
      horario1: '19:00',
      horario2: '19:30',
      ativar: true,
    });
    setCriandoNovaAsm(false);
    notificar(res);
  };

  const contadores = useMemo(() => {
    let construtora = 0;
    for (const p of presencas) {
      if (p.is_construtora) construtora += 1;
    }
    return {
      totalPresentes: presencas.length,
      moradores: presencas.length - construtora,
      construtora,
    };
  }, [presencas]);

  if (verificandoSessao) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0C0C0D]">
        <MilanoLogo variant="mark" className="h-14 w-auto animate-pulse" />
      </div>
    );
  }

  // ===========================================================================
  // TELA DE LOGIN REAL VIA SUPABASE AUTH (MESA DIRETORA — app_role = 'admin')
  // ===========================================================================
  if (!autenticado) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0C0C0D] px-4 py-10 text-white">
        <div className="w-full max-w-md rounded-3xl border border-[#CCB285]/30 bg-[#141518] p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center">
            <MilanoLogo variant="dark" className="h-12 w-auto" />
            <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#CCB285]/40 bg-[#CCB285]/10 px-3 py-1 text-[11px] font-extrabold uppercase tracking-widest text-[#CCB285]">
              <Lock className="h-3.5 w-3.5" />
              Autenticação Segura • Mesa Diretora
            </span>
            <h1 className="mt-3 text-xl font-extrabold text-white">
              Painel de Controle e Auditoria
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Entre com sua conta administrativa oficial (<code className="text-[#CCB285]">admin@portalmilano.com</code>).
            </p>
          </div>

          <form onSubmit={(e) => void handleLoginAdmin(e)} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="admin-email"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                E-mail Administrativo
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-[#CCB285]" />
                <input
                  id="admin-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@portalmilano.com"
                  className="w-full rounded-xl border border-slate-700 bg-[#0C0C0D] py-3 pl-10 pr-4 text-sm font-semibold text-white focus:border-[#CCB285] focus:outline-none focus:ring-2 focus:ring-[#CCB285]/30"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="admin-password"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                Senha
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-[#CCB285]" />
                <input
                  id="admin-password"
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
              {entrando ? 'Autenticando...' : 'Entrar no Painel da Mesa'}
            </button>
          </form>

          <div className="mt-6 flex items-center justify-center gap-3 border-t border-slate-800 pt-4 text-xs text-slate-400">
            <Link href="/" className="hover:text-[#CCB285]">
              Tela Morador (/)
            </Link>
            <span>•</span>
            <Link href="/portaria" className="hover:text-[#CCB285]">
              Portaria (/portaria)
            </Link>
            <span>•</span>
            <Link href="/telao" className="hover:text-[#CCB285]">
              Telão (/telao)
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ===========================================================================
  // CONSOLE OPERACIONAL DA MESA DIRETORA (/admin) — COM MENU LATERAL (SIDEBAR)
  // ===========================================================================
  interface ItemMenuAdmin {
    id: AbaAdmin;
    rotulo: string;
    descricao: string;
    icone: React.ReactNode;
    contador?: number;
    destaqueVivo?: boolean;
  }

  const GRUPOS_MENU: { titulo: string; itens: ItemMenuAdmin[] }[] = [
    {
      titulo: 'Operação da Assembleia',
      itens: [
        {
          id: 'CONVOCACOES',
          rotulo: 'Quórum, Horários & Timer',
          descricao: 'Convocação, escopo, cronômetro e encerramento',
          icone: <Settings2 className="h-4 w-4" />,
        },
        {
          id: 'PAUTAS',
          rotulo: 'Pautas & Votação',
          descricao: 'Sim/Não, múltipla escolha, rodadas e placar',
          icone: <ListChecks className="h-4 w-4" />,
          contador: pautas.length,
          destaqueVivo: Boolean(pautaAberta),
        },
      ],
    },
    {
      titulo: 'Credenciamento & Unidades',
      itens: [
        {
          id: 'PORTARIA',
          rotulo: 'Portaria / Entrada (CPF)',
          descricao: 'Confirmação de entrada e procurações',
          icone: <UserCheck className="h-4 w-4" />,
          contador: contadores.moradores,
        },
        {
          id: 'CADASTRO_BASE',
          rotulo: 'Cadastro Geral (544)',
          descricao: 'Base de moradores, CPFs e importação CSV',
          icone: <Database className="h-4 w-4" />,
          contador: unidadesCadastradas.length,
        },
        {
          id: 'INADIMPLENTES',
          rotulo: 'Grade Inadimplentes',
          descricao: 'Bloqueio e liberação rápida por bloco',
          icone: <ShieldAlert className="h-4 w-4" />,
          contador: inadimplentes.length,
        },
        {
          id: 'CONSTRUTORA',
          rotulo: 'Construtora',
          descricao: 'Unidades da construtora e voto em lote',
          icone: <Building2 className="h-4 w-4" />,
          contador: contadores.construtora,
        },
      ],
    },
    {
      titulo: 'Relatórios & Auditoria',
      itens: [
        {
          id: 'PRESENCAS_CSV',
          rotulo: 'Presenças, Aparelhos & CSV',
          descricao: 'Suporte de mesa, telemetria e planilhas',
          icone: <FileSpreadsheet className="h-4 w-4" />,
          contador: contadores.totalPresentes,
        },
        {
          id: 'AUDITORIA',
          rotulo: 'Auditoria Imutável',
          descricao: 'Trilha append-only de votos e operações',
          icone: <ShieldCheck className="h-4 w-4" />,
          contador: operacoesAuditoria.length + votosAuditoria.length,
        },
      ],
    },
  ];

  const itemMenuAtual =
    GRUPOS_MENU.flatMap((g) => g.itens).find((i) => i.id === abaAtiva) ??
    GRUPOS_MENU[0].itens[0];

  const temAssembleiaAtiva = assembleias.some((a) => a.status === 'ativa');

  const selecionarAba = (id: AbaAdmin) => {
    setAbaAtiva(id);
    setMenuMobileAberto(false);
  };

  const conteudoSidebar = (
    <div className="flex h-full flex-col bg-[#0C0C0D] text-white">
      {/* Cabeçalho da Marca na Sidebar */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/90 px-4 py-4">
        <div className="min-w-0">
          <MilanoLogo variant="dark" className="h-8 w-auto" />
          <p className="mt-2 text-[10px] font-extrabold uppercase tracking-widest text-[#CCB285]">
            Mesa Diretora • V2
          </p>
          <p className="truncate text-[11px] text-slate-400">
            {usuarioEmail || 'admin@portalmilano.com'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setMenuMobileAberto(false)}
          aria-label="Fechar menu lateral"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Seletor de Assembleia + Nova Assembleia */}
      <div className="space-y-2 border-b border-slate-800/90 px-4 py-3">
        <label className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
          <Calendar className="h-3 w-3 text-[#CCB285]" />
          Assembleia em Foco
        </label>
        {assembleias.length > 0 && (
          <select
            aria-label="Selecionar Assembleia"
            value={assembleiaSelecionadaId || ''}
            onChange={(e) => setAssembleiaSelecionadaId(e.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs font-bold text-white focus:border-[#CCB285] focus:outline-none"
          >
            {assembleias.map((asm) => (
              <option key={asm.id} value={asm.id} className="bg-slate-900 text-white">
                {asm.titulo} [{asm.status.toUpperCase()}]
              </option>
            ))}
          </select>
        )}

        {!temAssembleiaAtiva && (
          <button
            type="button"
            disabled={criandoNovaAsm}
            onClick={() => void handleCriarNovaAssembleiaRapida()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-extrabold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            <PlusCircle className="h-3.5 w-3.5" />
            {criandoNovaAsm ? 'Criando...' : 'Iniciar Nova Assembleia'}
          </button>
        )}
      </div>

      {/* Navegação Lateral Agrupada */}
      <nav
        aria-label="Menu lateral da Mesa Diretora"
        className="flex-1 space-y-5 overflow-y-auto px-3 py-4 custom-scrollbar"
      >
        {GRUPOS_MENU.map((grupo) => (
          <div key={grupo.titulo} className="space-y-1">
            <p className="px-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
              {grupo.titulo}
            </p>
            <div className="space-y-1">
              {grupo.itens.map((item) => {
                const ativa = abaAtiva === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selecionarAba(item.id)}
                    className={`group flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-bold transition ${
                      ativa
                        ? 'bg-[#CCB285] text-[#0C0C0D] shadow-md'
                        : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`shrink-0 ${
                          ativa
                            ? 'text-[#0C0C0D]'
                            : 'text-[#CCB285]/80 group-hover:text-[#CCB285]'
                        }`}
                      >
                        {item.icone}
                      </span>
                      <span className="truncate">{item.rotulo}</span>
                    </span>

                    <span className="flex shrink-0 items-center gap-1.5">
                      {item.destaqueVivo && (
                        <span
                          title="Há uma votação aberta ao vivo"
                          className={`h-2 w-2 rounded-full animate-pulse ${
                            ativa ? 'bg-emerald-800' : 'bg-emerald-400'
                          }`}
                        />
                      )}
                      {typeof item.contador === 'number' && (
                        <span
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-black tabular-nums ${
                            ativa
                              ? 'bg-[#0C0C0D]/15 text-[#0C0C0D]'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {item.contador}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Rodapé da Sidebar: Atalhos Rápidos & Sair */}
      <div className="space-y-2 border-t border-slate-800/90 p-3">
        <div className="grid grid-cols-2 gap-1.5">
          <Link
            href="/telao"
            target="_blank"
            className="inline-flex items-center justify-center gap-1 rounded-xl bg-[#CCB285] px-2.5 py-2 text-[11px] font-black uppercase tracking-wide text-[#0C0C0D] transition hover:bg-[#DFCCA9]"
          >
            Telão
            <ExternalLink className="h-3 w-3" />
          </Link>
          <Link
            href="/portaria"
            target="_blank"
            className="inline-flex items-center justify-center gap-1 rounded-xl border border-[#CCB285]/50 bg-[#CCB285]/10 px-2.5 py-2 text-[11px] font-extrabold text-[#CCB285] transition hover:bg-[#CCB285]/20"
          >
            Portaria
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        <div className="flex items-center gap-1.5">
          <Link
            href="/"
            target="_blank"
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-2.5 py-2 text-[11px] font-semibold text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            <Smartphone className="h-3.5 w-3.5 text-[#CCB285]" />
            Tela Morador
          </Link>
          <button
            type="button"
            onClick={() => void handleSair()}
            className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-800 bg-transparent px-3 py-2 text-[11px] font-semibold text-slate-300 transition hover:border-rose-500/70 hover:text-rose-300"
          >
            <Lock className="h-3.5 w-3.5" />
            Sair
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F6F5F1] text-slate-900 flex">
      {/* Sidebar Desktop Fixa */}
      <aside className="hidden lg:block lg:w-72 xl:w-[292px] shrink-0 border-r border-[#CCB285]/20 sticky top-0 h-screen">
        {conteudoSidebar}
      </aside>

      {/* Drawer Mobile / Tablet */}
      {menuMobileAberto && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/65 backdrop-blur-sm"
            onClick={() => setMenuMobileAberto(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] h-full shadow-2xl">
            {conteudoSidebar}
          </aside>
        </div>
      )}

      {/* Área Principal do Conteúdo */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Barra Superior Compacta da Seção Atual */}
        <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur px-4 py-3 sm:px-6 shadow-sm">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMenuMobileAberto(true)}
                aria-label="Abrir menu lateral"
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-[#0C0C0D] p-2 text-[#CCB285] shadow-sm lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>

              <div className="min-w-0">
                <h1 className="truncate text-base sm:text-lg font-extrabold text-slate-900 flex items-center gap-2">
                  <span className="text-[#A88E61] hidden sm:inline-flex">{itemMenuAtual.icone}</span>
                  <span className="truncate">{itemMenuAtual.rotulo}</span>
                </h1>
                <p className="truncate text-xs text-slate-500">{itemMenuAtual.descricao}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${
                  statusConexao === 'AO_VIVO'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-amber-300 bg-amber-50 text-amber-800'
                }`}
              >
                {statusConexao === 'AO_VIVO' ? (
                  <Wifi className="h-3.5 w-3.5" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">
                  {statusConexao === 'AO_VIVO' ? 'Conectado' : 'Reconectando...'}
                </span>
              </span>

              <button
                type="button"
                onClick={() => void recarregarTudo()}
                title="Ressincronizar dados agora"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition hover:border-[#0C0C0D] hover:bg-slate-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sincronizar</span>
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 sm:px-6">
          {/* Banner indicando quando está visualizando assembleia histórica encerrada */}
          {assembleiaAtual && assembleiaAtual.status === 'encerrada' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-slate-300 bg-slate-100 px-4 py-3 text-xs font-bold text-slate-800">
              <div>
                Modo Consulta Histórica:{' '}
                <span className="text-slate-950">{assembleiaAtual.titulo}</span> está{' '}
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-black uppercase text-white">
                  ENCERRADA (SOMENTE LEITURA)
                </span>
                . Todos os {presencas.length} check-ins, {pautas.length} pautas e {votos.length} votos
                estão preservados.
              </div>
              {!temAssembleiaAtiva && (
                <button
                  type="button"
                  disabled={criandoNovaAsm}
                  onClick={() => void handleCriarNovaAssembleiaRapida()}
                  className="rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-emerald-800"
                >
                  + Iniciar Nova Assembleia
                </button>
              )}
            </div>
          )}

          {/* Toast / Banner de Feedback */}
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
                aria-label="Fechar notificação"
                className="rounded-lg p-1 hover:bg-black/5"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {erroConexao && (
            <div className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-900">
              Erro de sincronização com o Supabase: {erroConexao}
            </div>
          )}

          {/* Faixa de Indicadores Rápidos (KPIs padronizados com mesma altura) */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 items-stretch">
            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Base Cadastrada
              </div>
              <div className="font-mono text-xl font-extrabold text-slate-900 tabular-nums leading-none">
                {unidadesCadastradas.length}
                <span className="text-xs font-semibold text-slate-400"> / 544</span>
              </div>
              <div className="text-[11px] text-slate-500 truncate">Unidades no banco</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Presentes
              </div>
              <div className="font-mono text-xl font-extrabold text-emerald-700 tabular-nums leading-none">
                {contadores.totalPresentes}
                <span className="text-xs font-semibold text-slate-400"> / 544</span>
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {contadores.moradores} morad. • {contadores.construtora} const.
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Convocação
              </div>
              <div className="text-sm font-extrabold text-slate-900 truncate">
                {!config.assembleia_ativa
                  ? 'Encerrada / Inativa'
                  : config.convocacao_ativa === 'PRIMEIRA'
                    ? `1ª Conv. (${config.horario_primeira_convocacao})`
                    : config.convocacao_ativa === 'SEGUNDA'
                      ? `2ª Conv. (${config.horario_segunda_convocacao})`
                      : `Aguardando (${config.horario_primeira_convocacao})`}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                Escopo: {config.escopo_assembleia}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Construtora
              </div>
              <div className="font-mono text-xl font-extrabold text-[#A88E61] tabular-nums leading-none">
                {contadores.construtora}
              </div>
              <div className="text-[11px] text-slate-500 truncate">1 voto por apto</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Inadimplentes
              </div>
              <div className="font-mono text-xl font-extrabold text-rose-600 tabular-nums leading-none">
                {config.total_inadimplentes}
              </div>
              <div className="text-[11px] text-slate-500 truncate">Apenas nº total é público</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm flex flex-col justify-between min-h-[88px]">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Pauta Aberta
              </div>
              <div className="truncate text-sm font-extrabold text-slate-900">
                {pautaAberta
                  ? `#${String(pautaAberta.ordem).padStart(2, '0')} — ${pautaAberta.titulo}`
                  : 'Nenhuma aberta'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">{pautas.length} pauta(s)</div>
            </div>
          </section>

          {/* Conteúdo da Seção Selecionada no Menu Lateral */}
          {carregandoInicial ? (
            <div className="rounded-2xl border border-slate-200 bg-white py-16 text-center text-sm font-semibold text-slate-500">
              Carregando dados da Assembleia...
            </div>
          ) : (
            <>
              {abaAtiva === 'CONVOCACOES' && (
                <AdminConvocacoesSection
                  config={config}
                  presencas={presencas}
                  pautas={pautas}
                  votos={votos}
                  historicoAssembleias={historicoAssembleias}
                  onSalvarConfig={salvarConfiguracao}
                  onControlarTimer={controlarTimerTelao}
                  onSalvarAssembleia={salvarAssembleiaNoHistorico}
                  onEncerrarEArquivar={encerrarEArquivarAssembleia}
                  onResetarAssembleia={resetarAssembleiaParaNova}
                  onExcluirHistorico={excluirAssembleiaDoHistorico}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'PORTARIA' && (
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

              {abaAtiva === 'CADASTRO_BASE' && (
                <AdminCadastroUnidadesSection
                  unidades={unidadesCadastradas}
                  onSalvarUnidade={salvarUnidadeBase}
                  onImportarLote={importarUnidadesBaseEmLote}
                  onAlternarInadimplencia={alternarInadimplenciaUnidadeBase}
                  onRemoverUnidade={removerUnidadeBase}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'PAUTAS' && (
                <AdminPautasSection
                  config={config}
                  pautas={pautas}
                  presencas={presencas}
                  votos={votos}
                  onCriarPauta={criarPauta}
                  onAbrirPauta={abrirPauta}
                  onEncerrarPauta={encerrarPauta}
                  onResetarPauta={resetarPauta}
                  onExcluirPauta={excluirPauta}
                  onControlarTimer={controlarTimerTelao}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'CONSTRUTORA' && (
                <AdminConstrutoraSection
                  presencas={presencas}
                  inadimplentes={inadimplentes}
                  pautaAberta={pautaAberta}
                  votos={votos}
                  onAdicionarConstrutora={adicionarUnidadesConstrutora}
                  onRemoverConstrutora={removerUnidadesConstrutora}
                  onVotarEmLoteConstrutora={votarEmLoteConstrutora}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'INADIMPLENTES' && (
                <AdminInadimplentesSection
                  config={config}
                  inadimplentes={inadimplentes}
                  presencas={presencas}
                  onAdicionarInadimplentes={adicionarUnidadesInadimplentes}
                  onRemoverInadimplentes={removerUnidadesInadimplentes}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'PRESENCAS_CSV' && (
                <AdminPresencasCsvSection
                  presencas={presencas}
                  pautas={pautas}
                  votos={votos}
                  onCredenciarManual={credenciarManualMesa}
                  onAtualizarPresenca={atualizarPresencaMesa}
                  onRemoverPresenca={removerPresencaMesa}
                  onNotificar={notificar}
                />
              )}

              {abaAtiva === 'AUDITORIA' && (
                <AdminAuditoriaSection
                  tituloAssembleia={assembleiaAtual?.titulo || 'Assembleia Geral Milano'}
                  pautas={pautas}
                  operacoes={operacoesAuditoria}
                  votosAuditoria={votosAuditoria}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
