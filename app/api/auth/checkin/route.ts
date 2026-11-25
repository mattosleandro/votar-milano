import { NextRequest, NextResponse } from 'next/server';
import {
  chaveUnidade,
  obterInfoBloco,
  unidadePertenceAoEscopo,
} from '@/lib/condominio';
import {
  assinarJwtMorador,
  getSupabaseServiceClient,
  verificarRateLimitCheckin,
} from '@/lib/supabaseServer';
import {
  EscopoVotacao,
  FaseCondominio,
  ModuloCondominio,
  UnidadeAutorizadaJwt,
} from '@/lib/types';
import { validarCpf } from '@/lib/validators';

export const dynamic = 'force-dynamic';

interface CheckinBody {
  action?: 'consultar' | 'confirmar';
  cpf?: string;
  bloco?: number;
  apartamento?: number;
  device_id?: string;
  device_name?: string;
  user_agent?: string;
}

interface UnidadeElegivel {
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  primeiro_nome: string;
  is_inadimplente: boolean;
  pertence_escopo: boolean;
  confirmado_portaria: boolean;
  online_conectado: boolean;
  com_procuracao: boolean;
  origem: 'PROPRIA' | 'PROCURACAO';
}

function extrairIpCliente(request: NextRequest): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  const realIp = request.headers.get('x-real-ip');
  const forwardedFor = request.headers.get('x-forwarded-for');
  return (
    cfIp?.trim() ||
    realIp?.trim() ||
    forwardedFor?.split(',')[0]?.trim() ||
    'IP-Local'
  );
}

export async function POST(request: NextRequest) {
  const ipCliente = extrairIpCliente(request);
  const limite = verificarRateLimitCheckin(ipCliente);

  if (!limite.permitido) {
    return NextResponse.json(
      {
        ok: false,
        code: 'RATE_LIMIT_EXCEDIDO',
        message: `Muitas tentativas deste aparelho. Aguarde ${limite.retryAfterSeconds} segundos e tente novamente.`,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(limite.retryAfterSeconds),
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  let body: CheckinBody;
  try {
    body = (await request.json()) as CheckinBody;
  } catch {
    return NextResponse.json(
      { ok: false, code: 'JSON_INVALIDO', message: 'Requisição inválida.' },
      { status: 400 }
    );
  }

  const action = body.action === 'confirmar' ? 'confirmar' : 'consultar';
  const resCpf = validarCpf(body.cpf ?? '');
  if (!resCpf.valido) {
    return NextResponse.json(
      {
        ok: false,
        code: 'CPF_INVALIDO',
        message: resCpf.erro || 'Informe um CPF válido de 11 dígitos.',
      },
      { status: 400 }
    );
  }

  const cpfLimpo = resCpf.cpfLimpo;

  try {
    const supabase = getSupabaseServiceClient();

    // 1. Busca a assembleia ativa atual
    const { data: assembleia, error: errAsm } = await supabase
      .from('assembleias')
      .select(
        'id, titulo, status, convocacao_ativa, escopo_assembleia, exigir_confirmacao_portaria'
      )
      .eq('status', 'ativa')
      .maybeSingle();

    if (errAsm) {
      return NextResponse.json(
        { ok: false, code: 'ERRO_SERVIDOR', message: 'Falha ao consultar estado da assembleia.' },
        { status: 500 }
      );
    }

    if (!assembleia || assembleia.convocacao_ativa === 'ENCERRADA') {
      return NextResponse.json(
        {
          ok: false,
          code: 'SEM_VOTACAO_ATIVA',
          message: 'Não existe nenhuma votação ativa no momento.',
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const escopoAssembleia = (assembleia.escopo_assembleia || 'TODOS') as EscopoVotacao;
    const exigirPortaria = assembleia.exigir_confirmacao_portaria !== false;

    // 2. Consulta paralela:
    //    - Unidades próprias do CPF em assembleia_unidades
    //    - Presenças já registradas nesta assembleia pelo CPF titular OU como cpf_procurador
    //    - Inadimplentes desta assembleia
    const [unidPropriasRes, presencasRelRes, inadRes] = await Promise.all([
      supabase
        .from('assembleia_unidades')
        .select('bloco, apartamento, fase, modulo, nome_completo, is_inadimplente, is_construtora')
        .eq('cpf', cpfLimpo)
        .eq('is_construtora', false)
        .order('bloco', { ascending: true })
        .order('apartamento', { ascending: true }),
      supabase
        .from('assembleia_presencas')
        .select(
          'id, bloco, apartamento, fase, modulo, nome_completo, cpf, cpf_procurador, confirmado_portaria, online_conectado, com_procuracao, is_construtora'
        )
        .eq('assembleia_id', assembleia.id)
        .or(`cpf.eq.${cpfLimpo},cpf_procurador.eq.${cpfLimpo}`)
        .eq('is_construtora', false),
      supabase
        .from('assembleia_inadimplentes')
        .select('bloco, apartamento')
        .eq('assembleia_id', assembleia.id),
    ]);

    if (unidPropriasRes.error || presencasRelRes.error || inadRes.error) {
      return NextResponse.json(
        { ok: false, code: 'ERRO_SERVIDOR', message: 'Falha ao verificar elegibilidade no banco.' },
        { status: 500 }
      );
    }

    const inadSet = new Set<string>();
    for (const i of inadRes.data ?? []) {
      inadSet.add(chaveUnidade(i.bloco, i.apartamento));
    }

    const presencaMap = new Map<
      string,
      {
        id: string;
        bloco: number;
        apartamento: number;
        fase: FaseCondominio;
        modulo: ModuloCondominio;
        nome_completo: string;
        cpf: string;
        cpf_procurador: string | null;
        confirmado_portaria: boolean;
        online_conectado: boolean;
        com_procuracao: boolean;
      }
    >();

    for (const pr of presencasRelRes.data ?? []) {
      presencaMap.set(chaveUnidade(pr.bloco, pr.apartamento), {
        id: pr.id,
        bloco: pr.bloco,
        apartamento: pr.apartamento,
        fase: pr.fase as FaseCondominio,
        modulo: pr.modulo as ModuloCondominio,
        nome_completo: pr.nome_completo,
        cpf: pr.cpf,
        cpf_procurador: pr.cpf_procurador,
        confirmado_portaria: Boolean(pr.confirmado_portaria),
        online_conectado: Boolean(pr.online_conectado),
        com_procuracao: Boolean(pr.com_procuracao),
      });
    }

    // Mescla unidades próprias + unidades representadas por procuração (cpf_procurador)
    const unidadesMap = new Map<string, UnidadeElegivel>();

    for (const u of unidPropriasRes.data ?? []) {
      const k = chaveUnidade(u.bloco, u.apartamento);
      const pr = presencaMap.get(k);
      const info = obterInfoBloco(u.bloco);
      const isInad = Boolean(u.is_inadimplente) || inadSet.has(k);
      const pertence = unidadePertenceAoEscopo(info, escopoAssembleia);

      unidadesMap.set(k, {
        bloco: u.bloco,
        apartamento: u.apartamento,
        fase: info.fase,
        modulo: info.modulo,
        primeiro_nome: (u.nome_completo || 'Condômino').trim().split(/\s+/)[0] || 'Condômino',
        is_inadimplente: isInad,
        pertence_escopo: pertence,
        confirmado_portaria: Boolean(pr?.confirmado_portaria),
        online_conectado: Boolean(pr?.online_conectado),
        com_procuracao: Boolean(pr?.com_procuracao),
        origem: 'PROPRIA',
      });
    }

    // Adiciona unidades em que este CPF foi registrado como Procurador na Portaria
    for (const [k, pr] of presencaMap.entries()) {
      if (unidadesMap.has(k)) continue;
      if (pr.cpf_procurador !== cpfLimpo) continue;

      const info = obterInfoBloco(pr.bloco);
      const isInad = inadSet.has(k);
      const pertence = unidadePertenceAoEscopo(info, escopoAssembleia);

      unidadesMap.set(k, {
        bloco: pr.bloco,
        apartamento: pr.apartamento,
        fase: info.fase,
        modulo: info.modulo,
        primeiro_nome: (pr.nome_completo || 'Condômino').trim().split(/\s+/)[0] || 'Condômino',
        is_inadimplente: isInad,
        pertence_escopo: pertence,
        confirmado_portaria: pr.confirmado_portaria,
        online_conectado: pr.online_conectado,
        com_procuracao: true,
        origem: 'PROCURACAO',
      });
    }

    const listaUnidades = Array.from(unidadesMap.values()).sort(
      (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
    );

    if (listaUnidades.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'CPF_NAO_CADASTRADO',
          message:
            'CPF não encontrado na base de unidades cadastradas nem como procurador confirmado. Procure a Recepção / Mesa Diretora.',
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const todasInadimplentes = listaUnidades.every((u) => u.is_inadimplente);
    if (todasInadimplentes) {
      return NextResponse.json(
        {
          ok: false,
          code: 'UNIDADE_INADIMPLENTE',
          message:
            'Unidade bloqueada para realizar votação. Para liberar o direito a voto, efetue o pagamento dos valores referentes ao condomínio e apresente o comprovante ao Síndico / Mesa Diretora.',
          unidades: listaUnidades,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const aptasEscopo = listaUnidades.filter((u) => !u.is_inadimplente && u.pertence_escopo);
    if (aptasEscopo.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'FORA_DO_ESCOPO_QUORUM',
          message: `Sua unidade foi localizada, porém não pertence ao quórum/escopo habilitado para esta convocação (${escopoAssembleia}).`,
          unidades: listaUnidades,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const aptasPortaria = exigirPortaria
      ? aptasEscopo.filter((u) => u.confirmado_portaria)
      : aptasEscopo;

    if (exigirPortaria && aptasPortaria.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'AGUARDANDO_LIBERACAO_PORTARIA',
          message:
            'Sua unidade foi localizada, mas ainda aguarda a confirmação de presença na entrada (Portaria). Apresente seu documento ou procuração aos atendentes na entrada para liberar a votação.',
          assembleia_id: assembleia.id,
          escopo_assembleia: escopoAssembleia,
          exigir_confirmacao_portaria: exigirPortaria,
          unidades: listaUnidades,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // MODO CONSULTAR: devolve apenas campos sanitizados (sem CPF nem nome completo!)
    if (action === 'consultar') {
      return NextResponse.json(
        {
          ok: true,
          code: 'UNIDADES_LOCALIZADAS',
          assembleia_id: assembleia.id,
          escopo_assembleia: escopoAssembleia,
          exigir_confirmacao_portaria: exigirPortaria,
          unidades: listaUnidades,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // MODO CONFIRMAR: conecta todas as unidades aptas e confirmadas daquele CPF (própria + procurações)
    // Se exigir_confirmacao_portaria = false, garante registro em assembleia_presencas.
    const agoraIso = new Date().toISOString();
    const userAgent = (body.user_agent || request.headers.get('user-agent') || '').slice(0, 300);
    const deviceId = (body.device_id || '').slice(0, 120) || null;
    const deviceName = (body.device_name || '').slice(0, 160) || null;

    const unidadesAutorizadas: UnidadeAutorizadaJwt[] = [];

    for (const u of aptasPortaria) {
      const k = chaveUnidade(u.bloco, u.apartamento);
      const prExistente = presencaMap.get(k);

      if (prExistente) {
        await supabase
          .from('assembleia_presencas')
          .update({
            online_conectado: true,
            conectado_em: agoraIso,
            ip_address: ipCliente,
            device_id: deviceId,
            device_name: deviceName,
            user_agent: userAgent || null,
          })
          .eq('id', prExistente.id);
      } else if (!exigirPortaria) {
        const unidBase = (unidPropriasRes.data ?? []).find(
          (row) => row.bloco === u.bloco && row.apartamento === u.apartamento
        );
        await supabase.from('assembleia_presencas').upsert(
          {
            assembleia_id: assembleia.id,
            bloco: u.bloco,
            apartamento: u.apartamento,
            fase: u.fase,
            modulo: u.modulo,
            nome_completo: unidBase?.nome_completo || u.primeiro_nome,
            cpf: cpfLimpo,
            is_construtora: false,
            confirmado_portaria: true,
            online_conectado: true,
            conectado_em: agoraIso,
            ip_address: ipCliente,
            device_id: deviceId,
            device_name: deviceName,
            user_agent: userAgent || null,
          },
          { onConflict: 'assembleia_id,bloco,apartamento' }
        );
      }

      unidadesAutorizadas.push({
        bloco: u.bloco,
        apartamento: u.apartamento,
        fase: u.fase,
        modulo: u.modulo,
        com_procuracao: u.com_procuracao,
        primeiro_nome: u.primeiro_nome,
      });
    }

    // Ordena deixando a unidade explicitamente selecionada no topo (se informada)
    if (body.bloco && body.apartamento) {
      unidadesAutorizadas.sort((a, b) => {
        const aSel = a.bloco === body.bloco && a.apartamento === body.apartamento ? 0 : 1;
        const bSel = b.bloco === body.bloco && b.apartamento === body.apartamento ? 0 : 1;
        return aSel - bSel || a.bloco - b.bloco || a.apartamento - b.apartamento;
      });
    }

    const { token, exp } = assinarJwtMorador({
      cpfLimpo,
      assembleiaId: assembleia.id,
      unidadesAutorizadas,
    });

    return NextResponse.json(
      {
        ok: true,
        code: 'CHECKIN_REALIZADO',
        message:
          unidadesAutorizadas.length > 1
            ? `Acesso validado com sucesso! ${unidadesAutorizadas.length} unidades autorizadas nesta sessão.`
            : 'Acesso validado e conectado com sucesso!',
        token,
        exp,
        assembleia_id: assembleia.id,
        unidades_autorizadas: unidadesAutorizadas,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[POST /api/auth/checkin] Erro interno:', err);
    return NextResponse.json(
      {
        ok: false,
        code: 'ERRO_INTERNO',
        message: 'Falha interna ao processar credenciamento. Tente novamente.',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
