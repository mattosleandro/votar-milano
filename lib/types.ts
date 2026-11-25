export type FaseCondominio = 1 | 2;
export type ModuloCondominio = 1 | 2 | 3 | 4;

export type EscopoVotacao =
  | 'TODOS'
  | 'FASE_1'
  | 'FASE_2'
  | 'MODULO_1'
  | 'MODULO_2'
  | 'MODULO_3'
  | 'MODULO_4';

export type ConvocacaoStatus = 'AGUARDANDO' | 'PRIMEIRA' | 'SEGUNDA' | 'ENCERRADA';

export type StatusAssembleia = 'rascunho' | 'ativa' | 'encerrada';

export type StatusPauta = 'aguardando' | 'aberta' | 'encerrada';

export type OpcaoVoto = 'SIM' | 'NAO' | 'ABSTENCAO';

export type ConexaoRealtimeStatus = 'CONECTANDO' | 'AO_VIVO' | 'RECONECTANDO';

export type AppRole = 'admin' | 'portaria' | 'morador' | '';

export type MapaInadimplentesPorEscopo = Record<EscopoVotacao, number>;

export interface AssembleiaRegistro {
  id: string;
  titulo: string;
  data_assembleia: string;
  status: StatusAssembleia;
  convocacao_ativa: ConvocacaoStatus;
  horario_primeira_convocacao: string;
  horario_segunda_convocacao: string;
  escopo_assembleia: EscopoVotacao;
  descontar_inadimplentes_quorum: boolean;
  exigir_confirmacao_portaria: boolean;
  total_inadimplentes: number;
  inadimplentes_por_escopo: MapaInadimplentesPorEscopo;
  timer_duration_seconds: number;
  timer_started_at: string | null;
  timer_running: boolean;
  version: number;
  created_at: string;
  started_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

export interface AssembleiaConfig {
  id: number;
  /** UUID da assembleia atualmente em foco (public.assembleias.id) */
  assembleia_id?: string;
  titulo?: string;
  status?: StatusAssembleia;
  /** Quando false, bloqueia o check-in por CPF e informa que não há votação ativa */
  assembleia_ativa: boolean;
  /** Quando true, exige que a entrada seja liberada na Portaria antes do morador validar no celular */
  exigir_confirmacao_portaria?: boolean;
  convocacao_ativa: ConvocacaoStatus;
  horario_primeira_convocacao: string;
  horario_segunda_convocacao: string;
  escopo_assembleia: EscopoVotacao;
  descontar_inadimplentes_quorum: boolean;
  /** Contador total agregado de unidades inadimplentes (sem expor bloco/apto) */
  total_inadimplentes: number;
  /** Contadores numéricos agregados por escopo (sem expor bloco/apto) */
  inadimplentes_por_escopo: MapaInadimplentesPorEscopo;
  /** Duração configurada do contador regressivo no telão (padrão 120s = 2 min) */
  timer_duration_seconds: number;
  /** Timestamp ISO de início da contagem regressiva atual */
  timer_started_at: string | null;
  /** Indica se o contador regressivo do telão está rodando */
  timer_running: boolean;
  version?: number;
  updated_at: string;
}

/**
 * Cadastro Base Completo de Unidades (restrito ao /admin e /portaria autenticados).
 */
export interface UnidadeCadastradaAdmin {
  id: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  nome_completo: string;
  cpf: string;
  is_inadimplente: boolean;
  is_construtora: boolean;
  observacao: string | null;
  updated_at: string;
}

/**
 * Projeção pública estrita de presença (usada em /telao — via RPC sanitizada).
 * JAMAIS inclui nome_completo, cpf, cpf_procurador ou telemetria de dispositivo.
 */
export interface PresencaPublica {
  id: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  is_construtora: boolean;
  confirmado_portaria?: boolean;
  online_conectado?: boolean;
  com_procuracao?: boolean;
  created_at: string;
}

/**
 * Entidade completa de presença restrita exclusivamente a /admin, /portaria e CSV.
 */
export interface PresencaAdmin extends PresencaPublica {
  assembleia_id?: string;
  nome_completo: string;
  cpf: string;
  cpf_procurador?: string | null;
  observacao_portaria?: string | null;
  conectado_em?: string | null;
  ip_address?: string | null;
  device_id?: string | null;
  device_name?: string | null;
  user_agent?: string | null;
}

/**
 * Unidade inadimplente restrita exclusivamente a /admin e /portaria.
 */
export interface InadimplenteAdmin {
  id: string;
  assembleia_id?: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  observacao: string | null;
  created_at: string;
}

export interface PautaAssembleia {
  id: string;
  assembleia_id?: string;
  ordem: number;
  titulo: string;
  descricao: string | null;
  escopo: EscopoVotacao;
  status: StatusPauta;
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
}

export interface VotoUnidade {
  id: string;
  assembleia_id?: string;
  pauta_id: string;
  bloco: number;
  apartamento: number;
  voto: OpcaoVoto;
  is_construtora: boolean;
  ip_address?: string | null;
  device_id?: string | null;
  device_name?: string | null;
  updated_at: string;
}

export interface UnidadeAutorizadaJwt {
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  com_procuracao: boolean;
  primeiro_nome?: string;
}

export interface SessaoMoradorLocal {
  token: string;
  exp: number;
  assembleiaId: string;
  unidadesAutorizadas: UnidadeAutorizadaJwt[];
  blocoAtivo: number;
  apartamentoAtivo: number;
  createdAt: string;
}

export interface ContadoresPublicosAssembleia {
  total: number;
  fase1: number;
  fase2: number;
  construtora: number;
  confirmados_portaria: number;
  conectados_online: number;
  com_procuracao: number;
  presentes_no_escopo: number;
}

export interface PlacarPublicoRpc {
  pauta_id: string;
  escopo: EscopoVotacao;
  presentes_aptos: number;
  sim: number;
  nao: number;
  nao_votaram: number;
  total_votos: number;
  vencedor: 'SIM' | 'NAO' | 'EMPATE' | 'SEM_VOTOS';
}

export interface GridUnidadeTelaoItem {
  id: string;
  b: number;
  a: number;
  f: FaseCondominio;
  m: ModuloCondominio;
  pres: boolean;
  port: boolean;
  onl: boolean;
  proc: boolean;
  const: boolean;
  voto: OpcaoVoto | null;
}

export interface TelemetriaDispositivo {
  ip_address: string;
  device_id: string;
  device_name: string;
  user_agent: string;
}

export interface SnapshotAssembleiaSalva {
  config: AssembleiaConfig;
  presencas: PresencaAdmin[];
  pautas: PautaAssembleia[];
  votos: VotoUnidade[];
}

export interface HistoricoAssembleia {
  id: string;
  assembleia_id?: string;
  titulo: string;
  tipo_snapshot?: 'periodico' | 'pauta_encerrada' | 'final' | 'manual';
  sha256_hash?: string | null;
  created_at: string;
  escopo_assembleia: EscopoVotacao;
  convocacao_ativa: ConvocacaoStatus;
  total_presentes: number;
  total_pautas: number;
  total_votos: number;
  dados_snapshot: SnapshotAssembleiaSalva;
}
