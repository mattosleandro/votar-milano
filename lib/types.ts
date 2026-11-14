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

export type StatusPauta = 'aguardando' | 'aberta' | 'encerrada';

export type OpcaoVoto = 'SIM' | 'NAO' | 'ABSTENCAO';

export type ConexaoRealtimeStatus = 'CONECTANDO' | 'AO_VIVO' | 'RECONECTANDO';

export type MapaInadimplentesPorEscopo = Record<EscopoVotacao, number>;

export interface AssembleiaConfig {
  id: number;
  /** Quando false, bloqueia o check-in por CPF e informa que não há votação ativa */
  assembleia_ativa: boolean;
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
  updated_at: string;
}

/**
 * Cadastro Base Completo de Unidades (restrito ao /admin e consultado via RPC segura por CPF).
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
 * Projeção pública estrita de presença (usada em / e /telao).
 * JAMAIS inclui nome_completo, cpf ou telemetria de dispositivo.
 */
export interface PresencaPublica {
  id: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  is_construtora: boolean;
  created_at: string;
}

/**
 * Entidade completa de presença restrita exclusivamente ao painel /admin e exportação CSV.
 */
export interface PresencaAdmin extends PresencaPublica {
  nome_completo: string;
  cpf: string;
  ip_address?: string | null;
  device_id?: string | null;
  device_name?: string | null;
  user_agent?: string | null;
}

/**
 * Unidade inadimplente restrita exclusivamente ao painel /admin (nunca trafegada em / ou /telao).
 */
export interface InadimplenteAdmin {
  id: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  observacao: string | null;
  created_at: string;
}

export interface PautaAssembleia {
  id: string;
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

export interface SessaoMoradorLocal {
  id: string;
  bloco: number;
  apartamento: number;
  fase: FaseCondominio;
  modulo: ModuloCondominio;
  primeiroNome: string;
  cpfLimpo?: string;
  createdAt: string;
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
  titulo: string;
  created_at: string;
  escopo_assembleia: EscopoVotacao;
  convocacao_ativa: ConvocacaoStatus;
  total_presentes: number;
  total_pautas: number;
  total_votos: number;
  dados_snapshot: SnapshotAssembleiaSalva;
}
