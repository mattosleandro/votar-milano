const REGEX_CARACTERES_INVALIDOS_NOME = /[^A-Za-zÀ-ÖØ-öø-ÿ\s]/g;
const REGEX_NOME_COMPLETO_VALIDO = /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]{1,})+$/;

/**
 * Remove imediatamente números e caracteres especiais durante a digitação do Nome Completo.
 */
export function sanitizarNomeDigitacao(valor: string): string {
  return valor
    .replace(REGEX_CARACTERES_INVALIDOS_NOME, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s+/, '');
}

/**
 * Valida o Nome Completo exigindo no mínimo nome e sobrenome, sem números nem caracteres especiais.
 */
export function validarNomeCompleto(valor: string): {
  valido: boolean;
  nomeLimpo: string;
  erro?: string;
} {
  const bruto = valor.trim().replace(/\s+/g, ' ');

  if (!bruto) {
    return {
      valido: false,
      nomeLimpo: '',
      erro: 'Informe seu nome completo (nome e sobrenome).',
    };
  }

  if (/[^A-Za-zÀ-ÖØ-öø-ÿ\s]/.test(bruto)) {
    return {
      valido: false,
      nomeLimpo: sanitizarNomeDigitacao(bruto).trim(),
      erro: 'Use apenas letras e espaços (números e símbolos não são permitidos).',
    };
  }

  const partes = bruto.split(' ').filter(Boolean);
  const partesSignificativas = partes.filter((p) => p.length >= 2);

  if (partes.length < 2 || partesSignificativas.length < 2 || !REGEX_NOME_COMPLETO_VALIDO.test(bruto)) {
    return {
      valido: false,
      nomeLimpo: bruto,
      erro: 'Digite seu nome e sobrenome completos.',
    };
  }

  return {
    valido: true,
    nomeLimpo: bruto,
  };
}

/**
 * Extrai apenas os 11 dígitos numéricos do CPF (bloqueia letras e caracteres especiais).
 */
export function limparCpf(valor: string): string {
  return valor.replace(/\D/g, '').slice(0, 11);
}

/**
 * Aplica a máscara oficial 000.000.000-00 bloqueando qualquer letra ou símbolo não numérico.
 */
export function aplicarMascaraCpf(valor: string): string {
  const digitos = limparCpf(valor);

  if (digitos.length <= 3) return digitos;
  if (digitos.length <= 6) return `${digitos.slice(0, 3)}.${digitos.slice(3)}`;
  if (digitos.length <= 9) {
    return `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6)}`;
  }
  return `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9, 11)}`;
}

/**
 * Validação matemática oficial dos dois dígitos verificadores do CPF (Módulo 11).
 */
export function validarCpf(valor: string): {
  valido: boolean;
  cpfLimpo: string;
  erro?: string;
} {
  const cpf = limparCpf(valor);

  if (cpf.length === 0) {
    return { valido: false, cpfLimpo: '', erro: 'Informe o seu CPF.' };
  }

  if (cpf.length !== 11) {
    return {
      valido: false,
      cpfLimpo: cpf,
      erro: 'O CPF deve conter os 11 dígitos numéricos.',
    };
  }

  // Rejeita sequências repetidas conhecidas (000.000.000-00 a 999.999.999-99)
  if (/^(\d)\1{10}$/.test(cpf)) {
    return {
      valido: false,
      cpfLimpo: cpf,
      erro: 'CPF inválido (sequência repetida).',
    };
  }

  // Cálculo do 1º dígito verificador
  let soma1 = 0;
  for (let i = 0; i < 9; i += 1) {
    soma1 += Number(cpf[i]) * (10 - i);
  }
  let resto1 = (soma1 * 10) % 11;
  if (resto1 === 10 || resto1 === 11) resto1 = 0;
  if (resto1 !== Number(cpf[9])) {
    return {
      valido: false,
      cpfLimpo: cpf,
      erro: 'CPF inválido (dígitos verificadores não conferem).',
    };
  }

  // Cálculo do 2º dígito verificador
  let soma2 = 0;
  for (let i = 0; i < 10; i += 1) {
    soma2 += Number(cpf[i]) * (11 - i);
  }
  let resto2 = (soma2 * 10) % 11;
  if (resto2 === 10 || resto2 === 11) resto2 = 0;
  if (resto2 !== Number(cpf[10])) {
    return {
      valido: false,
      cpfLimpo: cpf,
      erro: 'CPF inválido (dígitos verificadores não conferem).',
    };
  }

  return {
    valido: true,
    cpfLimpo: cpf,
  };
}
