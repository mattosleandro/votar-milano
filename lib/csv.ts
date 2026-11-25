import {
  calcularPlacarPauta,
  chaveUnidade,
  formatarBloco,
  FUSO_HORARIO_OFICIAL,
  obterInfoBloco,
  obterMetadadosEscopo,
} from './condominio';
import { extrairAssinaturaFisicaAparelho } from './deviceTelemetry';
import {
  AssembleiaConfig,
  PautaAssembleia,
  PresencaAdmin,
  UnidadeCadastradaAdmin,
  VotoUnidade,
} from './types';
import { aplicarMascaraCpf } from './validators';

function escaparCelulaCsv(valor: string | number | boolean | null | undefined): string {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  const escapado = texto.replace(/"/g, '""');
  return `"${escapado}"`;
}

function formatarDataHoraLocal(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const data = new Date(isoString);
  if (Number.isNaN(data.getTime())) return isoString;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO_OFICIAL,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(data);
}

function sufixoArquivoDataHora(): string {
  const agora = new Date();
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO_OFICIAL,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .formatToParts(agora)
    .reduce<Record<string, string>>((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});

  return `${partes.year}-${partes.month}-${partes.day}-${partes.hour}h${partes.minute}`;
}

export function obterSugestaoTituloAssembleia(): string {
  const agora = new Date();
  const dataFmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO_OFICIAL,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(agora);
  return `Assembleia ${dataFmt}`;
}

function dispararDownloadCsv(nomeArquivo: string, linhas: string[][]): void {
  if (typeof window === 'undefined') return;

  // Separador ';' + UTF-8 BOM (\uFEFF) garante abertura direta com colunas e acentos perfeitos no Excel PT-BR e Google Sheets
  const conteudo =
    '\uFEFF' + linhas.map((colunas) => colunas.map(escaparCelulaCsv).join(';')).join('\r\n');

  const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', nomeArquivo);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatarCpfAuditoria(cpf: string, isConstrutora: boolean): string {
  if (isConstrutora || cpf.toUpperCase() === 'CONSTRUTORA') {
    return 'CONSTRUTORA';
  }
  const formatado = aplicarMascaraCpf(cpf);
  return formatado || cpf;
}

function rotuloVotoCsv(voto: VotoUnidade['voto']): string {
  if (voto === 'SIM') return 'SIM';
  if (voto === 'NAO') return 'NÃO';
  return 'ABSTENÇÃO';
}

export function exportarListaPresencaCsv(presencas: readonly PresencaAdmin[]): void {
  const contagemPorAparelho = new Map<string, number>();
  for (const p of presencas) {
    if (p.is_construtora) continue;
    const hw = extrairAssinaturaFisicaAparelho(p.device_id);
    if (hw) {
      contagemPorAparelho.set(hw, (contagemPorAparelho.get(hw) ?? 0) + 1);
    }
  }

  const cabecalho = [
    'Bloco',
    'Apartamento',
    'Unidade',
    'Fase',
    'Módulo',
    'Tipo de Representação',
    'Nome Completo do Representante',
    'CPF',
    'IP do Aparelho',
    'ID Assinatura Aparelho',
    'Modelo / Sistema do Aparelho',
    'Análise Múltiplo Acesso',
    'Data/Hora Check-in',
  ];

  const ordenadas = [...presencas].sort(
    (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
  );

  const linhasDados = ordenadas.map((p) => {
    const blocoFmt = formatarBloco(p.bloco);
    const hw = extrairAssinaturaFisicaAparelho(p.device_id);
    const qtdNoMesmoAparelho = hw ? contagemPorAparelho.get(hw) ?? 1 : 1;

    return [
      `Bloco ${blocoFmt}`,
      String(p.apartamento),
      `B${blocoFmt} | A${p.apartamento}`,
      `Fase ${p.fase}`,
      `Módulo ${p.modulo}`,
      p.is_construtora
        ? 'CONSTRUTORA'
        : p.com_procuracao
          ? p.observacao_portaria
            ? `PROCURAÇÃO (${p.observacao_portaria})`
            : 'PROCURAÇÃO'
          : 'TITULAR / PROPRIETÁRIO',
      p.nome_completo,
      formatarCpfAuditoria(p.cpf, p.is_construtora),
      p.ip_address || '',
      p.device_id || '',
      p.device_name || '',
      !p.is_construtora && qtdNoMesmoAparelho > 1
        ? `ALERTA: ${qtdNoMesmoAparelho} unidades neste mesmo aparelho`
        : 'Normal (1 unidade)',
      formatarDataHoraLocal(p.created_at),
    ];
  });

  dispararDownloadCsv(`milano-lista-presenca-${sufixoArquivoDataHora()}.csv`, [
    cabecalho,
    ...linhasDados,
  ]);
}

export function exportarAuditoriaVotosCsv(params: {
  pautas: readonly PautaAssembleia[];
  votos: readonly VotoUnidade[];
  presencas: readonly PresencaAdmin[];
  pautaIdFiltro?: string;
}): void {
  const { pautas, votos, presencas, pautaIdFiltro } = params;

  const mapaPautas = new Map<string, PautaAssembleia>();
  for (const p of pautas) {
    mapaPautas.set(p.id, p);
  }

  const mapaPresencas = new Map<string, PresencaAdmin>();
  for (const pr of presencas) {
    mapaPresencas.set(chaveUnidade(pr.bloco, pr.apartamento), pr);
  }

  const votosFiltrados = pautaIdFiltro
    ? votos.filter((v) => v.pauta_id === pautaIdFiltro)
    : [...votos];

  votosFiltrados.sort((a, b) => {
    const pautaA = mapaPautas.get(a.pauta_id)?.ordem ?? 9999;
    const pautaB = mapaPautas.get(b.pauta_id)?.ordem ?? 9999;
    if (pautaA !== pautaB) return pautaA - pautaB;
    const rA = a.rodada ?? 1;
    const rB = b.rodada ?? 1;
    if (rA !== rB) return rA - rB;
    if (a.bloco !== b.bloco) return a.bloco - b.bloco;
    return a.apartamento - b.apartamento;
  });

  const cabecalho = [
    'Ordem Pauta',
    'Rodada',
    'Status Rodada',
    'Título da Pauta',
    'Escopo da Pauta',
    'Status da Pauta',
    'Bloco',
    'Apartamento',
    'Unidade',
    'Fase',
    'Módulo',
    'Tipo de Representação',
    'Nome Completo do Votante',
    'CPF do Votante',
    'Voto Computado',
    'IP do Aparelho',
    'ID Assinatura Aparelho',
    'Modelo / Sistema do Aparelho',
    'Data/Hora do Voto',
  ];

  const linhasDados = votosFiltrados.map((v) => {
    const pauta = mapaPautas.get(v.pauta_id);
    const rodadaVoto = v.rodada ?? 1;
    const rodadaAtual = pauta?.rodada ?? 1;
    const presenca = mapaPresencas.get(chaveUnidade(v.bloco, v.apartamento));
    const infoBloco = obterInfoBloco(v.bloco);
    const blocoFmt = formatarBloco(v.bloco);
    const isConstrutora = v.is_construtora || Boolean(presenca?.is_construtora);
    const metaEscopo = pauta ? obterMetadadosEscopo(pauta.escopo).rotuloCurto : '';

    return [
      pauta ? String(pauta.ordem) : '',
      `Rodada ${rodadaVoto}`,
      rodadaVoto === rodadaAtual ? 'VIGENTE' : 'RODADA ANTERIOR (HISTÓRICO)',
      pauta ? pauta.titulo : v.pauta_id,
      metaEscopo,
      pauta ? pauta.status.toUpperCase() : '',
      `Bloco ${blocoFmt}`,
      String(v.apartamento),
      `B${blocoFmt} | A${v.apartamento}`,
      `Fase ${infoBloco.fase}`,
      `Módulo ${infoBloco.modulo}`,
      isConstrutora ? 'CONSTRUTORA' : 'MORADOR / PROPRIETÁRIO',
      presenca
        ? presenca.nome_completo
        : isConstrutora
          ? 'CONSTRUTORA MILANO'
          : '(Presença removida após voto)',
      presenca
        ? formatarCpfAuditoria(presenca.cpf, isConstrutora)
        : isConstrutora
          ? 'CONSTRUTORA'
          : '',
      rotuloVotoCsv(v.voto),
      v.ip_address || presenca?.ip_address || '',
      v.device_id || presenca?.device_id || '',
      v.device_name || presenca?.device_name || '',
      formatarDataHoraLocal(v.updated_at),
    ];
  });

  const pautaAlvo = pautaIdFiltro ? mapaPautas.get(pautaIdFiltro) : undefined;
  const prefixo = pautaAlvo
    ? `milano-auditoria-votos-pauta-${String(pautaAlvo.ordem).padStart(2, '0')}`
    : 'milano-auditoria-votos-geral';

  dispararDownloadCsv(`${prefixo}-${sufixoArquivoDataHora()}.csv`, [cabecalho, ...linhasDados]);
}

/**
 * Exporta um arquivo CSV único consolidado com TUDO que foi credenciado e votado na Assembleia:
 * 1) Resumo Geral da Assembleia
 * 2) Placar Final de Todas as Pautas
 * 3) Lista Completa de Presença
 * 4) Auditoria Nominal de Todos os Votos
 */
export function exportarPacoteCompletoAssembleiaCsv(params: {
  tituloAssembleia: string;
  config: AssembleiaConfig;
  presencas: readonly PresencaAdmin[];
  pautas: readonly PautaAssembleia[];
  votos: readonly VotoUnidade[];
}): void {
  const { tituloAssembleia, config, presencas, pautas, votos } = params;
  const linhas: string[][] = [];

  linhas.push(['RELATÓRIO OFICIAL CONSOLIDADO — MILANO CONDOMÍNIO CLUB']);
  linhas.push(['Identificação da Assembleia', tituloAssembleia]);
  linhas.push(['Data/Hora de Emissão', formatarDataHoraLocal(new Date().toISOString())]);
  linhas.push([
    'Escopo / Quórum Configurado',
    obterMetadadosEscopo(config.escopo_assembleia).rotuloSelect,
  ]);
  linhas.push(['Convocação', config.convocacao_ativa]);
  linhas.push([
    'Horários Definidos',
    `1ª Conv.: ${config.horario_primeira_convocacao} | 2ª Conv.: ${config.horario_segunda_convocacao}`,
  ]);
  linhas.push(['Total de Unidades Presentes', String(presencas.length)]);
  linhas.push(['Total de Pautas Deliberadas', String(pautas.length)]);
  linhas.push(['Total de Votos Computados', String(votos.length)]);
  linhas.push([]);

  // Seção 1: Resumo de Placares das Pautas
  linhas.push(['=== 1. RESUMO DE PAUTAS E PLACARES ===']);
  linhas.push([
    'Ordem',
    'Título da Pauta',
    'Escopo',
    'Status',
    'Resultado / Vencedor',
    'Presentes Aptos',
    'Votos SIM',
    '% SIM (Válidos)',
    'Votos NÃO',
    '% NÃO (Válidos)',
    'Não Votaram (Abstenções)',
    '% Não Votou',
    'Total Votos (SIM + NÃO)',
  ]);

  const pautasOrdenadas = [...pautas].sort((a, b) => a.ordem - b.ordem);
  for (const p of pautasOrdenadas) {
    const placar = calcularPlacarPauta(p, presencas, votos);
    const rotuloResultado =
      placar.vencedor === 'SIM'
        ? 'VENCEDOR: MAIORIA SIM'
        : placar.vencedor === 'NAO'
          ? 'VENCEDOR: MAIORIA NÃO'
          : placar.vencedor === 'EMPATE'
            ? 'EMPATE'
            : 'SEM VOTOS';
    linhas.push([
      String(p.ordem),
      p.titulo,
      obterMetadadosEscopo(p.escopo).rotuloCurto,
      p.status.toUpperCase(),
      rotuloResultado,
      String(placar.presentesAptos),
      String(placar.sim),
      `${placar.pctSimValidos.toFixed(1)}%`,
      String(placar.nao),
      `${placar.pctNaoValidos.toFixed(1)}%`,
      String(placar.naoVotaram),
      `${placar.pctNaoVotaram.toFixed(1)}%`,
      String(placar.totalVotosRegistrados),
    ]);
  }
  linhas.push([]);

  // Seção 2: Lista de Presença
  linhas.push(['=== 2. LISTA DE PRESENÇA CREDENCIADA ===']);
  linhas.push([
    'Bloco',
    'Apartamento',
    'Unidade',
    'Fase',
    'Módulo',
    'Tipo de Representação',
    'Nome Completo',
    'CPF',
    'IP do Aparelho',
    'ID Assinatura Aparelho',
    'Modelo do Aparelho',
    'Data/Hora Check-in',
  ]);

  const presencasOrdenadas = [...presencas].sort(
    (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
  );
  for (const pr of presencasOrdenadas) {
    const bFmt = formatarBloco(pr.bloco);
    linhas.push([
      `Bloco ${bFmt}`,
      String(pr.apartamento),
      `B${bFmt} | A${pr.apartamento}`,
      `Fase ${pr.fase}`,
      `Módulo ${pr.modulo}`,
      pr.is_construtora
        ? 'CONSTRUTORA'
        : pr.com_procuracao
          ? pr.observacao_portaria
            ? `PROCURAÇÃO (${pr.observacao_portaria})`
            : 'PROCURAÇÃO'
          : 'TITULAR / PROPRIETÁRIO',
      pr.nome_completo,
      formatarCpfAuditoria(pr.cpf, pr.is_construtora),
      pr.ip_address || '',
      pr.device_id || '',
      pr.device_name || '',
      formatarDataHoraLocal(pr.created_at),
    ]);
  }
  linhas.push([]);

  // Seção 3: Auditoria Nominal de Todos os Votos (incluindo todas as rodadas)
  linhas.push(['=== 3. AUDITORIA NOMINAL DE VOTOS POR PAUTA ===']);
  linhas.push([
    'Ordem Pauta',
    'Rodada',
    'Título da Pauta',
    'Unidade',
    'Fase',
    'Módulo',
    'Nome Completo do Votante',
    'CPF do Votante',
    'Voto Computado',
    'IP do Aparelho',
    'ID Assinatura Aparelho',
    'Modelo do Aparelho',
    'Data/Hora do Voto',
  ]);

  const mapaPautas = new Map<string, PautaAssembleia>();
  for (const p of pautas) mapaPautas.set(p.id, p);

  const mapaPresencas = new Map<string, PresencaAdmin>();
  for (const pr of presencas) mapaPresencas.set(chaveUnidade(pr.bloco, pr.apartamento), pr);

  const votosOrdenados = [...votos].sort((a, b) => {
    const oA = mapaPautas.get(a.pauta_id)?.ordem ?? 9999;
    const oB = mapaPautas.get(b.pauta_id)?.ordem ?? 9999;
    if (oA !== oB) return oA - oB;
    const rA = a.rodada ?? 1;
    const rB = b.rodada ?? 1;
    if (rA !== rB) return rA - rB;
    return a.bloco - b.bloco || a.apartamento - b.apartamento;
  });

  for (const v of votosOrdenados) {
    const pauta = mapaPautas.get(v.pauta_id);
    const pr = mapaPresencas.get(chaveUnidade(v.bloco, v.apartamento));
    const info = obterInfoBloco(v.bloco);
    const bFmt = formatarBloco(v.bloco);
    const isConst = v.is_construtora || Boolean(pr?.is_construtora);

    linhas.push([
      pauta ? String(pauta.ordem) : '',
      `Rodada ${v.rodada ?? 1}`,
      pauta ? pauta.titulo : v.pauta_id,
      `B${bFmt} | A${v.apartamento}`,
      `Fase ${info.fase}`,
      `Módulo ${info.modulo}`,
      pr ? pr.nome_completo : isConst ? 'CONSTRUTORA MILANO' : '(Presença removida)',
      pr ? formatarCpfAuditoria(pr.cpf, isConst) : isConst ? 'CONSTRUTORA' : '',
      rotuloVotoCsv(v.voto),
      v.ip_address || pr?.ip_address || '',
      v.device_id || pr?.device_id || '',
      v.device_name || pr?.device_name || '',
      formatarDataHoraLocal(v.updated_at),
    ]);
  }

  const slug = tituloAssembleia
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  dispararDownloadCsv(`milano-${slug || 'assembleia'}-${sufixoArquivoDataHora()}.csv`, linhas);
}

export function exportarCadastroBaseCsv(unidades: readonly UnidadeCadastradaAdmin[]): void {
  const cabecalho = [
    'Bloco',
    'Apartamento',
    'Fase',
    'Modulo',
    'Nome Completo',
    'CPF',
    'Status (ADIMPLENTE / INADIMPLENTE / CONSTRUTORA)',
    'Observacao',
  ];

  const ordenadas = [...unidades].sort(
    (a, b) => a.bloco - b.bloco || a.apartamento - b.apartamento
  );

  const linhas = ordenadas.map((u) => [
    String(u.bloco),
    String(u.apartamento),
    String(u.fase),
    String(u.modulo),
    u.nome_completo,
    u.is_construtora ? 'CONSTRUTORA' : aplicarMascaraCpf(u.cpf),
    u.is_construtora ? 'CONSTRUTORA' : u.is_inadimplente ? 'INADIMPLENTE' : 'ADIMPLENTE',
    u.observacao || '',
  ]);

  dispararDownloadCsv(`milano-cadastro-unidades-${sufixoArquivoDataHora()}.csv`, [
    cabecalho,
    ...linhas,
  ]);
}

export function baixarModeloImportacaoUnidadesCsv(): void {
  const cabecalho = ['Bloco', 'Apartamento', 'Nome Completo', 'CPF', 'Status', 'Observacao'];
  const exemplos = [
    ['26', '101', 'Maria Silva Santos', '529.982.247-25', 'ADIMPLENTE', ''],
    ['26', '102', 'Joao Pereira Oliveira', '111.444.777-35', 'INADIMPLENTE', 'Pendente taxa condominial'],
    ['01', '101', 'CONSTRUTORA MILANO', 'CONSTRUTORA', 'CONSTRUTORA', 'Unidade nao entregue'],
  ];
  dispararDownloadCsv('modelo-importacao-condominos-milano.csv', [cabecalho, ...exemplos]);
}
