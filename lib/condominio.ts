import {
  AssembleiaConfig,
  ContagemOpcaoPlacar,
  EscopoVotacao,
  FaseCondominio,
  ModuloCondominio,
  OpcaoPauta,
  PautaAssembleia,
  PlacarPublicoRpc,
  PresencaPublica,
  TipoVotacaoPauta,
  VotoUnidade,
} from './types';

export const TOTAL_BLOCOS = 34;
export const APARTAMENTOS_POR_BLOCO = 16;
export const TOTAL_UNIDADES_CONDOMINIO = TOTAL_BLOCOS * APARTAMENTOS_POR_BLOCO; // 544

export const TODOS_OS_BLOCOS: readonly number[] = Array.from(
  { length: TOTAL_BLOCOS },
  (_, index) => index + 1
);

export const PAVIMENTOS_APARTAMENTOS: readonly {
  pavimento: number;
  rotulo: string;
  apartamentos: readonly number[];
}[] = [
  { pavimento: 1, rotulo: '1º Pavimento (Térreo)', apartamentos: [101, 102, 103, 104] },
  { pavimento: 2, rotulo: '2º Pavimento', apartamentos: [201, 202, 203, 204] },
  { pavimento: 3, rotulo: '3º Pavimento', apartamentos: [301, 302, 303, 304] },
  { pavimento: 4, rotulo: '4º Pavimento', apartamentos: [401, 402, 403, 404] },
] as const;

export const TODOS_APARTAMENTOS: readonly number[] = [
  101, 102, 103, 104,
  201, 202, 203, 204,
  301, 302, 303, 304,
  401, 402, 403, 404,
] as const;

export interface InfoBlocoCondominio {
  bloco: number;
  blocoFormatado: string;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  badgeIdentificacao: string;
}

/**
 * Mapeamento oficial determinístico do Condomínio Milano:
 * - Fase 1 (16 blocos / 256 apartamentos):
 *   - Módulo 1: Blocos 26 ao 34 (9 blocos / 144 apartamentos)
 *   - Módulo 2: Blocos 19 ao 25 (7 blocos / 112 apartamentos)
 * - Fase 2 (18 blocos / 288 apartamentos):
 *   - Módulo 3: Blocos 01 ao 04 e 09 ao 11 (7 blocos / 112 apartamentos)
 *   - Módulo 4: Blocos 05 ao 08 e 12 ao 18 (11 blocos / 176 apartamentos)
 */
export function obterInfoBloco(bloco: number): InfoBlocoCondominio {
  if (!Number.isInteger(bloco) || bloco < 1 || bloco > 34) {
    throw new Error(`Número de bloco inválido: ${bloco}. Deve estar entre 1 e 34.`);
  }

  let fase: FaseCondominio;
  let modulo: ModuloCondominio;

  if (bloco >= 26 && bloco <= 34) {
    fase = 1;
    modulo = 1;
  } else if (bloco >= 19 && bloco <= 25) {
    fase = 1;
    modulo = 2;
  } else if ((bloco >= 1 && bloco <= 4) || (bloco >= 9 && bloco <= 11)) {
    fase = 2;
    modulo = 3;
  } else {
    // Blocos 05 ao 08 e 12 ao 18
    fase = 2;
    modulo = 4;
  }

  const blocoFormatado = formatarBloco(bloco);

  return {
    bloco,
    blocoFormatado,
    fase,
    modulo,
    badgeIdentificacao: `Identificado: Fase ${fase} • Módulo ${modulo}`,
  };
}

export function formatarBloco(bloco: number): string {
  return String(bloco).padStart(2, '0');
}

export function chaveUnidade(bloco: number, apartamento: number): string {
  return `${bloco}-${apartamento}`;
}

export const FUSO_HORARIO_OFICIAL = 'America/Campo_Grande';

export function formatarUnidadeCompacta(bloco: number, apartamento: number): string {
  return `B${formatarBloco(bloco)} • ${apartamento}`;
}

export function formatarUnidadeTelaoCompacta(bloco: number, apartamento: number): string {
  return `B${formatarBloco(bloco)} | A${apartamento}`;
}

export function formatarUnidadeCompleta(bloco: number, apartamento: number): string {
  return `Bloco ${formatarBloco(bloco)} • Apto ${apartamento}`;
}

export function formatarSegundosMMSS(totalSegundos: number): string {
  const seg = Math.max(0, Math.floor(totalSegundos));
  const horas = Math.floor(seg / 3600);
  const minutos = Math.floor((seg % 3600) / 60);
  const segundos = seg % 60;
  if (horas > 0) {
    return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:${String(
      segundos
    ).padStart(2, '0')}`;
  }
  return `${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
}

export interface EstadoRelogioConvocacao {
  horaCampoGrande: string;
  emContagemRegressiva: boolean;
  alvoConvocacao: 'PRIMEIRA' | 'SEGUNDA' | null;
  segundosRestantes: number;
  textoContagem: string;
}

function extrairSegundosDoDiaHorario(hhmm: string): number | null {
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 3600 + m * 60;
}

/**
 * Calcula a hora oficial de Campo Grande (MS) e o cronômetro regressivo para a 1ª ou 2ª Convocação.
 * Quando a convocação já iniciou (PRIMEIRA ou SEGUNDA), exibe apenas o relógio local.
 */
export function obterEstadoRelogioCampoGrande(
  config: Pick<
    AssembleiaConfig,
    'convocacao_ativa' | 'horario_primeira_convocacao' | 'horario_segunda_convocacao'
  >,
  agoraMs: number = Date.now()
): EstadoRelogioConvocacao {
  const data = new Date(agoraMs);
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO_OFICIAL,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(data)
    .reduce<Record<string, string>>((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});

  const h = Number(partes.hour || 0);
  const m = Number(partes.minute || 0);
  const s = Number(partes.second || 0);
  const horaCampoGrande = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(
    s
  ).padStart(2, '0')}`;

  // Se a 1ª ou 2ª convocação já foi iniciada ou encerrada, mostra apenas o relógio local de Campo Grande
  if (config.convocacao_ativa !== 'AGUARDANDO') {
    return {
      horaCampoGrande,
      emContagemRegressiva: false,
      alvoConvocacao: null,
      segundosRestantes: 0,
      textoContagem: horaCampoGrande,
    };
  }

  const segundosAgora = h * 3600 + m * 60 + s;
  const segPrimeira = extrairSegundosDoDiaHorario(config.horario_primeira_convocacao);
  const segSegunda = extrairSegundosDoDiaHorario(config.horario_segunda_convocacao);

  if (segPrimeira !== null && segundosAgora < segPrimeira) {
    const rest = segPrimeira - segundosAgora;
    return {
      horaCampoGrande,
      emContagemRegressiva: true,
      alvoConvocacao: 'PRIMEIRA',
      segundosRestantes: rest,
      textoContagem: formatarSegundosMMSS(rest),
    };
  }

  if (segSegunda !== null && segundosAgora < segSegunda) {
    const rest = segSegunda - segundosAgora;
    return {
      horaCampoGrande,
      emContagemRegressiva: true,
      alvoConvocacao: 'SEGUNDA',
      segundosRestantes: rest,
      textoContagem: formatarSegundosMMSS(rest),
    };
  }

  return {
    horaCampoGrande,
    emContagemRegressiva: false,
    alvoConvocacao: null,
    segundosRestantes: 0,
    textoContagem: horaCampoGrande,
  };
}

export interface MetadadosEscopo {
  escopo: EscopoVotacao;
  rotuloCurto: string;
  rotuloSelect: string;
  badgeTelao: string;
  descricaoBlocos: string;
  totalBlocos: number;
  totalUnidades: number;
  blocos: number[];
}

export const ESCOPOS_VOTACAO: readonly EscopoVotacao[] = [
  'TODOS',
  'FASE_1',
  'FASE_2',
  'MODULO_1',
  'MODULO_2',
  'MODULO_3',
  'MODULO_4',
] as const;

const CACHE_ESCOPOS: Record<EscopoVotacao, MetadadosEscopo> = {
  TODOS: {
    escopo: 'TODOS',
    rotuloCurto: 'Todos os 34 Blocos',
    rotuloSelect: 'TODOS — Condomínio Completo (34 blocos • 544 aptos)',
    badgeTelao: 'VOTAÇÃO GERAL: TODOS OS 34 BLOCOS',
    descricaoBlocos: 'Blocos 01 ao 34',
    totalBlocos: 34,
    totalUnidades: 544,
    blocos: [...TODOS_OS_BLOCOS],
  },
  FASE_1: {
    escopo: 'FASE_1',
    rotuloCurto: 'Fase 1 (Blocos 19 ao 34)',
    rotuloSelect: 'FASE 1 — Blocos 19 ao 34 (256 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: FASE 1 (BLOCOS 19 AO 34)',
    descricaoBlocos: 'Blocos 19 ao 34 (Módulos 1 e 2)',
    totalBlocos: 16,
    totalUnidades: 256,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).fase === 1),
  },
  FASE_2: {
    escopo: 'FASE_2',
    rotuloCurto: 'Fase 2 (Blocos 01 ao 18)',
    rotuloSelect: 'FASE 2 — Blocos 01 ao 18 (288 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: FASE 2 (BLOCOS 01 AO 18)',
    descricaoBlocos: 'Blocos 01 ao 18 (Módulos 3 e 4)',
    totalBlocos: 18,
    totalUnidades: 288,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).fase === 2),
  },
  MODULO_1: {
    escopo: 'MODULO_1',
    rotuloCurto: 'Módulo 1 (Blocos 26 ao 34)',
    rotuloSelect: 'MÓDULO 1 — Fase 1 (Blocos 26 ao 34 • 144 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: MÓDULO 1 (BLOCOS 26 AO 34)',
    descricaoBlocos: 'Blocos 26 ao 34 (Fase 1)',
    totalBlocos: 9,
    totalUnidades: 144,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).modulo === 1),
  },
  MODULO_2: {
    escopo: 'MODULO_2',
    rotuloCurto: 'Módulo 2 (Blocos 19 ao 25)',
    rotuloSelect: 'MÓDULO 2 — Fase 1 (Blocos 19 ao 25 • 112 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: MÓDULO 2 (BLOCOS 19 AO 25)',
    descricaoBlocos: 'Blocos 19 ao 25 (Fase 1)',
    totalBlocos: 7,
    totalUnidades: 112,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).modulo === 2),
  },
  MODULO_3: {
    escopo: 'MODULO_3',
    rotuloCurto: 'Módulo 3 (Blocos 01–04 e 09–11)',
    rotuloSelect: 'MÓDULO 3 — Fase 2 (Blocos 01–04 e 09–11 • 112 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: MÓDULO 3 (BLOCOS 01–04 E 09–11)',
    descricaoBlocos: 'Blocos 01 ao 04 e 09 ao 11 (Fase 2)',
    totalBlocos: 7,
    totalUnidades: 112,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).modulo === 3),
  },
  MODULO_4: {
    escopo: 'MODULO_4',
    rotuloCurto: 'Módulo 4 (Blocos 05–08 e 12–18)',
    rotuloSelect: 'MÓDULO 4 — Fase 2 (Blocos 05–08 e 12–18 • 176 aptos)',
    badgeTelao: 'VOTAÇÃO EXCLUSIVA: MÓDULO 4 (BLOCOS 05–08 E 12–18)',
    descricaoBlocos: 'Blocos 05 ao 08 e 12 ao 18 (Fase 2)',
    totalBlocos: 11,
    totalUnidades: 176,
    blocos: TODOS_OS_BLOCOS.filter((b) => obterInfoBloco(b).modulo === 4),
  },
};

export function obterMetadadosEscopo(escopo: EscopoVotacao): MetadadosEscopo {
  return CACHE_ESCOPOS[escopo];
}

export function unidadePertenceAoEscopo(
  unidade: { fase: FaseCondominio; modulo: ModuloCondominio } | number,
  escopo: EscopoVotacao
): boolean {
  const info = typeof unidade === 'number' ? obterInfoBloco(unidade) : unidade;
  switch (escopo) {
    case 'TODOS':
      return true;
    case 'FASE_1':
      return info.fase === 1;
    case 'FASE_2':
      return info.fase === 2;
    case 'MODULO_1':
      return info.modulo === 1;
    case 'MODULO_2':
      return info.modulo === 2;
    case 'MODULO_3':
      return info.modulo === 3;
    case 'MODULO_4':
      return info.modulo === 4;
    default:
      return false;
  }
}

export interface ResumoQuorumEscopo {
  escopo: EscopoVotacao;
  totalFisicoEscopo: number;
  inadimplentesNoEscopo: number;
  baseConvocadosAptos: number;
  minimoPrimeiraConvocacao: number;
  presentesNoEscopo: number;
  presentesConstrutoraNoEscopo: number;
  presentesMoradoresNoEscopo: number;
  faltamParaPrimeiraConvocacao: number;
  percentualPresencaBase: number;
  atingiuMaioriaAbsoluta: boolean;
  podeAbrirVotacao: boolean;
  motivoBloqueio?: string;
}

export function calcularQuorumPorContagem(
  escopo: EscopoVotacao,
  presentesNoEscopo: number,
  config: AssembleiaConfig,
  presentesConstrutoraNoEscopo = 0
): ResumoQuorumEscopo {
  const meta = obterMetadadosEscopo(escopo);
  const totalFisicoEscopo = meta.totalUnidades;
  const inadimplentesNoEscopo = Math.max(
    0,
    Number(config.inadimplentes_por_escopo?.[escopo] ?? 0)
  );

  const baseConvocadosAptos = config.descontar_inadimplentes_quorum
    ? Math.max(totalFisicoEscopo - inadimplentesNoEscopo, 1)
    : totalFisicoEscopo;

  const minimoPrimeiraConvocacao = Math.floor(baseConvocadosAptos / 2) + 1;
  const presentesLimpos = Math.max(0, Number(presentesNoEscopo || 0));
  const construtoraLimpa = Math.max(0, Math.min(presentesLimpos, Number(presentesConstrutoraNoEscopo || 0)));

  const presentesMoradoresNoEscopo = presentesLimpos - construtoraLimpa;
  const faltamParaPrimeiraConvocacao = Math.max(minimoPrimeiraConvocacao - presentesLimpos, 0);
  const percentualPresencaBase =
    baseConvocadosAptos > 0 ? (presentesLimpos / baseConvocadosAptos) * 100 : 0;
  const atingiuMaioriaAbsoluta = presentesLimpos >= minimoPrimeiraConvocacao;

  let podeAbrirVotacao = false;
  let motivoBloqueio: string | undefined;

  if (!config.assembleia_ativa) {
    podeAbrirVotacao = false;
    motivoBloqueio =
      'Configure e salve o Quórum e os Horários de Convocação para ativar a assembleia.';
  } else if (config.convocacao_ativa === 'AGUARDANDO') {
    podeAbrirVotacao = false;
    motivoBloqueio = 'Assembleia aguardando instalação (ative a 1ª ou 2ª Convocação).';
  } else if (config.convocacao_ativa === 'ENCERRADA') {
    podeAbrirVotacao = false;
    motivoBloqueio = 'A Assembleia está marcada como encerrada.';
  } else if (config.convocacao_ativa === 'PRIMEIRA') {
    podeAbrirVotacao = atingiuMaioriaAbsoluta;
    if (!atingiuMaioriaAbsoluta) {
      motivoBloqueio = `1ª Convocação exige Maioria Absoluta (${minimoPrimeiraConvocacao} unidades). Faltam ${faltamParaPrimeiraConvocacao}.`;
    }
  } else {
    // SEGUNDA convocação: Maioria Simples (com quem estiver presente no momento)
    podeAbrirVotacao = presentesLimpos >= 1;
    if (presentesLimpos < 1) {
      motivoBloqueio = 'É necessário ao menos 1 representante credenciado no escopo para votar.';
    }
  }

  return {
    escopo,
    totalFisicoEscopo,
    inadimplentesNoEscopo,
    baseConvocadosAptos,
    minimoPrimeiraConvocacao,
    presentesNoEscopo: presentesLimpos,
    presentesConstrutoraNoEscopo: construtoraLimpa,
    presentesMoradoresNoEscopo,
    faltamParaPrimeiraConvocacao,
    percentualPresencaBase,
    atingiuMaioriaAbsoluta,
    podeAbrirVotacao,
    motivoBloqueio,
  };
}

export function calcularQuorumEscopo(
  escopo: EscopoVotacao,
  presencas: readonly PresencaPublica[],
  config: AssembleiaConfig
): ResumoQuorumEscopo {
  let presentesNoEscopo = 0;
  let presentesConstrutoraNoEscopo = 0;

  for (const p of presencas) {
    if (unidadePertenceAoEscopo(p, escopo)) {
      presentesNoEscopo += 1;
      if (p.is_construtora) {
        presentesConstrutoraNoEscopo += 1;
      }
    }
  }

  return calcularQuorumPorContagem(escopo, presentesNoEscopo, config, presentesConstrutoraNoEscopo);
}

export type ResultadoVencedorPauta = 'SIM' | 'NAO' | 'EMPATE' | 'SEM_VOTOS' | 'MULTIPLA';

export interface PlacarOpcaoItem extends ContagemOpcaoPlacar {
  /** % sobre o total de unidades votantes na pauta */
  pctVotantes: number;
  /** % sobre o total de presentes aptos no escopo */
  pctPresentes: number;
  /** Se esta opção está entre a(s) mais votada(s) */
  ehVencedora: boolean;
}

export interface PlacarPauta {
  escopo: EscopoVotacao;
  tipoVotacao: TipoVotacaoPauta;
  presentesAptos: number;
  sim: number;
  nao: number;
  /** Unidades presentes no escopo que não votaram (Abstenção / Imparcial) */
  naoVotaram: number;
  /** Alias para compatibilidade com relatórios: igual a naoVotaram */
  abstencao: number;
  /** Alias para compatibilidade: igual a naoVotaram */
  aguardando: number;
  /** Total de unidades que registraram voto deliberativo */
  totalVotosRegistrados: number;
  /** % sobre o total de presentes aptos no escopo */
  pctSim: number;
  pctNao: number;
  pctNaoVotaram: number;
  pctAbstencao: number;
  pctAguardando: number;
  /** % entre os votos deliberativos válidos (SIM vs NÃO) */
  pctSimValidos: number;
  pctNaoValidos: number;
  /** Opção com maior quantidade de votos (SIM, NAO, MULTIPLA, EMPATE ou SEM_VOTOS) */
  vencedor: ResultadoVencedorPauta;
  /** Diferença absoluta entre SIM e NÃO (ou entre 1º e 2º lugar na múltipla escolha) */
  diferencaVotos: number;
  /** Contagem detalhada por opção (para pautas MULTIPLA_UNICA e MULTIPLA_VARIAS) */
  opcoes: PlacarOpcaoItem[];
  /** IDs da(s) opção(ões) vencedora(s) em múltipla escolha */
  vencedoresIds: string[];
}

export interface PaletaOpcaoMultipla {
  bgTelaoCell: string;
  barClass: string;
  pillDark: string;
  pillLight: string;
  cardLight: string;
  cardSelected: string;
}

const PALETA_OPCOES_MULTIPLA: readonly PaletaOpcaoMultipla[] = [
  {
    bgTelaoCell: 'bg-indigo-600 border-indigo-300/90 text-white shadow-sm shadow-indigo-950/80',
    barClass: 'bg-indigo-500',
    pillDark: 'bg-indigo-500/25 border-indigo-400/60 text-indigo-200',
    pillLight: 'bg-indigo-100 border-indigo-300 text-indigo-900',
    cardLight: 'bg-indigo-50/80 border-indigo-200 text-indigo-950',
    cardSelected: 'bg-indigo-600 border-indigo-800 text-white ring-4 ring-indigo-500/25',
  },
  {
    bgTelaoCell: 'bg-teal-600 border-teal-300/90 text-white shadow-sm shadow-teal-950/80',
    barClass: 'bg-teal-500',
    pillDark: 'bg-teal-500/25 border-teal-400/60 text-teal-200',
    pillLight: 'bg-teal-100 border-teal-300 text-teal-900',
    cardLight: 'bg-teal-50/80 border-teal-200 text-teal-950',
    cardSelected: 'bg-teal-600 border-teal-800 text-white ring-4 ring-teal-500/25',
  },
  {
    bgTelaoCell: 'bg-amber-600 border-amber-300/90 text-white shadow-sm shadow-amber-950/80',
    barClass: 'bg-amber-500',
    pillDark: 'bg-amber-500/25 border-amber-400/60 text-amber-200',
    pillLight: 'bg-amber-100 border-amber-300 text-amber-950',
    cardLight: 'bg-amber-50/80 border-amber-200 text-amber-950',
    cardSelected: 'bg-amber-600 border-amber-800 text-white ring-4 ring-amber-500/25',
  },
  {
    bgTelaoCell: 'bg-fuchsia-600 border-fuchsia-300/90 text-white shadow-sm shadow-fuchsia-950/80',
    barClass: 'bg-fuchsia-500',
    pillDark: 'bg-fuchsia-500/25 border-fuchsia-400/60 text-fuchsia-200',
    pillLight: 'bg-fuchsia-100 border-fuchsia-300 text-fuchsia-900',
    cardLight: 'bg-fuchsia-50/80 border-fuchsia-200 text-fuchsia-950',
    cardSelected: 'bg-fuchsia-600 border-fuchsia-800 text-white ring-4 ring-fuchsia-500/25',
  },
  {
    bgTelaoCell: 'bg-cyan-600 border-cyan-300/90 text-white shadow-sm shadow-cyan-950/80',
    barClass: 'bg-cyan-500',
    pillDark: 'bg-cyan-500/25 border-cyan-400/60 text-cyan-200',
    pillLight: 'bg-cyan-100 border-cyan-300 text-cyan-900',
    cardLight: 'bg-cyan-50/80 border-cyan-200 text-cyan-950',
    cardSelected: 'bg-cyan-600 border-cyan-800 text-white ring-4 ring-cyan-500/25',
  },
  {
    bgTelaoCell: 'bg-orange-600 border-orange-300/90 text-white shadow-sm shadow-orange-950/80',
    barClass: 'bg-orange-500',
    pillDark: 'bg-orange-500/25 border-orange-400/60 text-orange-200',
    pillLight: 'bg-orange-100 border-orange-300 text-orange-900',
    cardLight: 'bg-orange-50/80 border-orange-200 text-orange-950',
    cardSelected: 'bg-orange-600 border-orange-800 text-white ring-4 ring-orange-500/25',
  },
  {
    bgTelaoCell: 'bg-lime-600 border-lime-300/90 text-white shadow-sm shadow-lime-950/80',
    barClass: 'bg-lime-500',
    pillDark: 'bg-lime-500/25 border-lime-400/60 text-lime-200',
    pillLight: 'bg-lime-100 border-lime-300 text-lime-900',
    cardLight: 'bg-lime-50/80 border-lime-200 text-lime-950',
    cardSelected: 'bg-lime-600 border-lime-800 text-white ring-4 ring-lime-500/25',
  },
  {
    bgTelaoCell: 'bg-pink-600 border-pink-300/90 text-white shadow-sm shadow-pink-950/80',
    barClass: 'bg-pink-500',
    pillDark: 'bg-pink-500/25 border-pink-400/60 text-pink-200',
    pillLight: 'bg-pink-100 border-pink-300 text-pink-900',
    cardLight: 'bg-pink-50/80 border-pink-200 text-pink-950',
    cardSelected: 'bg-pink-600 border-pink-800 text-white ring-4 ring-pink-500/25',
  },
];

export function obterPaletaOpcaoMultipla(index: number): PaletaOpcaoMultipla {
  return PALETA_OPCOES_MULTIPLA[Math.abs(index) % PALETA_OPCOES_MULTIPLA.length];
}

export function obterTipoVotacaoPauta(
  pauta?: Pick<PautaAssembleia, 'tipo_votacao'> | null
): TipoVotacaoPauta {
  if (pauta?.tipo_votacao === 'MULTIPLA_UNICA') return 'MULTIPLA_UNICA';
  if (pauta?.tipo_votacao === 'MULTIPLA_VARIAS') return 'MULTIPLA_VARIAS';
  return 'SIM_NAO';
}

export function obterOpcoesPauta(
  pauta?: Pick<PautaAssembleia, 'opcoes_json'> | null
): OpcaoPauta[] {
  if (!pauta || !Array.isArray(pauta.opcoes_json)) return [];
  return pauta.opcoes_json
    .filter((o) => o && typeof o.id === 'string' && typeof o.label === 'string')
    .map((o, idx) => ({
      id: o.id,
      sigla: o.sigla || String.fromCharCode(65 + idx),
      label: o.label,
    }));
}

export function formatarVotoLegivel(
  voto: Pick<VotoUnidade, 'voto' | 'escolhas_json'>,
  pauta?: Pick<PautaAssembleia, 'tipo_votacao' | 'opcoes_json'> | null
): string {
  if (voto.voto === 'SIM') return 'SIM';
  if (voto.voto === 'NAO') return 'NÃO';
  if (voto.voto === 'ABSTENCAO') return 'ABSTENÇÃO';

  const escolhas = Array.isArray(voto.escolhas_json) ? voto.escolhas_json : [];
  if (escolhas.length === 0) return 'MÚLTIPLA';

  const opcoes = obterOpcoesPauta(pauta);
  const mapa = new Map(opcoes.map((o) => [o.id, o]));
  return escolhas
    .map((id) => {
      const opt = mapa.get(id);
      return opt ? `${opt.sigla}: ${opt.label}` : id;
    })
    .join(' | ');
}

export function formatarSiglasVoto(
  escolhas: readonly string[] | undefined,
  pauta?: Pick<PautaAssembleia, 'opcoes_json'> | null
): string {
  if (!escolhas || escolhas.length === 0) return '';
  const opcoes = obterOpcoesPauta(pauta);
  const mapa = new Map(opcoes.map((o) => [o.id, o.sigla]));
  return escolhas.map((id) => mapa.get(id) ?? id).join('·');
}

export function calcularPlacarPauta(
  pauta: Pick<PautaAssembleia, 'id' | 'escopo' | 'rodada' | 'tipo_votacao' | 'opcoes_json'>,
  presencas: readonly PresencaPublica[],
  votos: readonly VotoUnidade[]
): PlacarPauta {
  const rodadaAtiva = pauta.rodada ?? 1;
  const tipoVotacao = obterTipoVotacaoPauta(pauta);
  const presentesMap = new Map<string, PresencaPublica>();
  for (const p of presencas) {
    if (unidadePertenceAoEscopo(p, pauta.escopo)) {
      presentesMap.set(chaveUnidade(p.bloco, p.apartamento), p);
    }
  }

  let sim = 0;
  let nao = 0;
  let totalUnidadesMultipla = 0;
  const opcoesBase = obterOpcoesPauta(pauta);
  const mapaContagemOpcoes = new Map<string, number>();
  for (const o of opcoesBase) mapaContagemOpcoes.set(o.id, 0);

  for (const v of votos) {
    if (v.pauta_id !== pauta.id) continue;
    if ((v.rodada ?? 1) !== rodadaAtiva) continue;
    const info = obterInfoBloco(v.bloco);
    if (!unidadePertenceAoEscopo(info, pauta.escopo)) continue;

    if (tipoVotacao === 'SIM_NAO') {
      if (v.voto === 'SIM') sim += 1;
      else if (v.voto === 'NAO') nao += 1;
    } else if (v.voto === 'MULTIPLA') {
      const escolhas = Array.isArray(v.escolhas_json) ? v.escolhas_json : [];
      if (escolhas.length > 0) {
        totalUnidadesMultipla += 1;
        for (const optId of escolhas) {
          if (mapaContagemOpcoes.has(optId)) {
            mapaContagemOpcoes.set(optId, (mapaContagemOpcoes.get(optId) ?? 0) + 1);
          }
        }
      }
    }
  }

  const totalVotosRegistrados = tipoVotacao === 'SIM_NAO' ? sim + nao : totalUnidadesMultipla;
  const presentesAptos = Math.max(presentesMap.size, totalVotosRegistrados);
  const naoVotaram = Math.max(presentesAptos - totalVotosRegistrados, 0);

  const divisorPresentes = presentesAptos > 0 ? presentesAptos : 1;
  const divisorValidos = totalVotosRegistrados > 0 ? totalVotosRegistrados : 1;
  const pctNaoVotaram = presentesAptos > 0 ? (naoVotaram / divisorPresentes) * 100 : 0;

  let vencedor: ResultadoVencedorPauta = 'SEM_VOTOS';
  let diferencaVotos = Math.abs(sim - nao);
  let vencedoresIds: string[] = [];
  let opcoes: PlacarOpcaoItem[] = [];

  if (tipoVotacao === 'SIM_NAO') {
    if (totalVotosRegistrados > 0) {
      if (sim > nao) vencedor = 'SIM';
      else if (nao > sim) vencedor = 'NAO';
      else vencedor = 'EMPATE';
    }
  } else {
    const contagens = opcoesBase.map((o) => ({
      ...o,
      votos: mapaContagemOpcoes.get(o.id) ?? 0,
    }));
    const maxVotos = contagens.reduce((acc, item) => Math.max(acc, item.votos), 0);
    if (maxVotos > 0) {
      vencedoresIds = contagens.filter((c) => c.votos === maxVotos).map((c) => c.id);
      vencedor = vencedoresIds.length > 1 ? 'EMPATE' : 'MULTIPLA';
      const ordenados = [...contagens].sort((a, b) => b.votos - a.votos);
      diferencaVotos =
        ordenados.length >= 2 ? ordenados[0].votos - ordenados[1].votos : ordenados[0]?.votos ?? 0;
    } else {
      diferencaVotos = 0;
    }

    opcoes = contagens.map((c) => ({
      ...c,
      pctVotantes: totalVotosRegistrados > 0 ? (c.votos / divisorValidos) * 100 : 0,
      pctPresentes: presentesAptos > 0 ? (c.votos / divisorPresentes) * 100 : 0,
      ehVencedora: maxVotos > 0 && vencedoresIds.includes(c.id),
    }));
  }

  return {
    escopo: pauta.escopo,
    tipoVotacao,
    presentesAptos,
    sim,
    nao,
    naoVotaram,
    abstencao: naoVotaram,
    aguardando: naoVotaram,
    totalVotosRegistrados,
    pctSim: presentesAptos > 0 ? (sim / divisorPresentes) * 100 : 0,
    pctNao: presentesAptos > 0 ? (nao / divisorPresentes) * 100 : 0,
    pctNaoVotaram,
    pctAbstencao: pctNaoVotaram,
    pctAguardando: pctNaoVotaram,
    pctSimValidos: totalVotosRegistrados > 0 ? (sim / divisorValidos) * 100 : 0,
    pctNaoValidos: totalVotosRegistrados > 0 ? (nao / divisorValidos) * 100 : 0,
    vencedor,
    diferencaVotos,
    opcoes,
    vencedoresIds,
  };
}

export function converterPlacarRpcParaPlacarPauta(placar: PlacarPublicoRpc): PlacarPauta {
  const tipoVotacao: TipoVotacaoPauta =
    placar.tipo_votacao === 'MULTIPLA_UNICA' || placar.tipo_votacao === 'MULTIPLA_VARIAS'
      ? placar.tipo_votacao
      : 'SIM_NAO';
  const sim = Math.max(0, Number(placar.sim || 0));
  const nao = Math.max(0, Number(placar.nao || 0));
  const totalVotosRegistrados = Math.max(0, Number(placar.total_votos ?? sim + nao));
  const presentesAptos = Math.max(Number(placar.presentes_aptos || 0), totalVotosRegistrados);
  const naoVotaram = Math.max(Number(placar.nao_votaram ?? presentesAptos - totalVotosRegistrados), 0);

  const divisorPresentes = presentesAptos > 0 ? presentesAptos : 1;
  const divisorValidos = totalVotosRegistrados > 0 ? totalVotosRegistrados : 1;
  const pctNaoVotaram = presentesAptos > 0 ? (naoVotaram / divisorPresentes) * 100 : 0;

  const vencedoresIds = Array.isArray(placar.vencedores_ids) ? placar.vencedores_ids : [];
  const opcoesRaw = Array.isArray(placar.opcoes_contagem) ? placar.opcoes_contagem : [];
  const opcoes: PlacarOpcaoItem[] = opcoesRaw.map((o) => {
    const v = Math.max(0, Number(o.votos || 0));
    return {
      id: o.id,
      sigla: o.sigla,
      label: o.label,
      votos: v,
      pctVotantes: totalVotosRegistrados > 0 ? (v / divisorValidos) * 100 : 0,
      pctPresentes: presentesAptos > 0 ? (v / divisorPresentes) * 100 : 0,
      ehVencedora: v > 0 && vencedoresIds.includes(o.id),
    };
  });

  const ordenados = [...opcoes].sort((a, b) => b.votos - a.votos);
  const diferencaVotos =
    tipoVotacao === 'SIM_NAO'
      ? Math.abs(sim - nao)
      : ordenados.length >= 2
        ? ordenados[0].votos - ordenados[1].votos
        : ordenados[0]?.votos ?? 0;

  return {
    escopo: placar.escopo,
    tipoVotacao,
    presentesAptos,
    sim,
    nao,
    naoVotaram,
    abstencao: naoVotaram,
    aguardando: naoVotaram,
    totalVotosRegistrados,
    pctSim: presentesAptos > 0 ? (sim / divisorPresentes) * 100 : 0,
    pctNao: presentesAptos > 0 ? (nao / divisorPresentes) * 100 : 0,
    pctNaoVotaram,
    pctAbstencao: pctNaoVotaram,
    pctAguardando: pctNaoVotaram,
    pctSimValidos: totalVotosRegistrados > 0 ? (sim / divisorValidos) * 100 : 0,
    pctNaoValidos: totalVotosRegistrados > 0 ? (nao / divisorValidos) * 100 : 0,
    vencedor: placar.vencedor,
    diferencaVotos,
    opcoes,
    vencedoresIds,
  };
}
