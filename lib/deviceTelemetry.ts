'use client';

import { TelemetriaDispositivo } from './types';

const STORAGE_DEVICE_TOKEN = 'votar_milano_device_token_v1';

interface NavigatorUAData {
  brands?: { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    model?: string;
    platform?: string;
    platformVersion?: string;
  }>;
}

function gerarHashCurto(texto: string): string {
  let h1 = 0xdeadbeef ^ texto.length;
  let h2 = 0x41c6ce57 ^ texto.length;
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}`.toUpperCase();
}

function obterRendererWebGL(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) return 'no-webgl';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return 'std-webgl';
    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === 'string' ? renderer : 'webgl';
  } catch {
    return 'err-webgl';
  }
}

function inferirNomeAparelhoPorUA(ua: string): string {
  let so = 'SO Desconhecido';
  if (/iPhone/i.test(ua)) {
    const matchIos = ua.match(/OS (\d+[_\d]*)/i);
    so = `iPhone (iOS ${matchIos ? matchIos[1].replace(/_/g, '.') : ''})`.trim();
  } else if (/iPad/i.test(ua)) {
    so = 'iPad (iPadOS)';
  } else if (/Android/i.test(ua)) {
    const matchAndroid = ua.match(/Android\s+([0-9.]+)(?:;\s*([^;)]+))?/i);
    const versao = matchAndroid?.[1] ? `Android ${matchAndroid[1]}` : 'Android';
    const modelo = matchAndroid?.[2]?.replace(/\s+Build\/.*$/i, '').trim();
    so = modelo ? `${modelo} (${versao})` : versao;
  } else if (/Windows NT/i.test(ua)) {
    so = 'Windows PC';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    so = 'Mac';
  } else if (/Linux/i.test(ua)) {
    so = 'Linux';
  }

  let navegador = 'Navegador';
  if (/EdgA?\//i.test(ua)) navegador = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) navegador = 'Opera';
  else if (/SamsungBrowser\//i.test(ua)) navegador = 'Samsung Internet';
  else if (/CriOS\//i.test(ua)) navegador = 'Chrome iOS';
  else if (/FxiOS\//i.test(ua)) navegador = 'Firefox iOS';
  else if (/Chrome\//i.test(ua)) navegador = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) navegador = 'Safari';
  else if (/Firefox\//i.test(ua)) navegador = 'Firefox';

  return `${so} • ${navegador}`;
}

let cacheTelemetria: TelemetriaDispositivo | null = null;

/**
 * Coleta informações de rede (IP real via /api/device-info) e assinatura de hardware/aparelho
 * para análise de múltiplos votos no mesmo dispositivo no painel /admin e relatórios CSV.
 */
export async function coletarTelemetriaDispositivo(): Promise<TelemetriaDispositivo> {
  if (cacheTelemetria) return cacheTelemetria;

  if (typeof window === 'undefined') {
    return {
      ip_address: 'SSR',
      device_id: 'SSR',
      device_name: 'SSR',
      user_agent: '',
    };
  }

  const ua = window.navigator.userAgent || '';
  const largura = window.screen?.width || 0;
  const altura = window.screen?.height || 0;
  const dpr = window.devicePixelRatio || 1;
  const cores = window.navigator.hardwareConcurrency || 0;
  const idioma = window.navigator.language || 'pt-BR';
  const gpu = obterRendererWebGL();

  // Assinatura física do aparelho (mesmo se usar aba anônima no mesmo celular, o hash HW permanece igual)
  const hwHash = gerarHashCurto(`${ua}|${largura}x${altura}@${dpr}|${cores}|${idioma}|${gpu}`).slice(
    0,
    10
  );

  let tokenLocal = '';
  try {
    tokenLocal = window.localStorage.getItem(STORAGE_DEVICE_TOKEN) || '';
    if (!tokenLocal) {
      tokenLocal = gerarHashCurto(`${Date.now()}-${Math.random()}`).slice(0, 6);
      window.localStorage.setItem(STORAGE_DEVICE_TOKEN, tokenLocal);
    }
  } catch {
    tokenLocal = hwHash.slice(0, 6);
  }

  // O prefixo HW-<hwHash> permite agrupar o mesmo aparelho físico mesmo em aba anônima
  const device_id = `DEV-${hwHash}-${tokenLocal}`;

  let device_name = `${inferirNomeAparelhoPorUA(ua)} [${largura}x${altura}]`;

  try {
    const navUA = (window.navigator as Navigator & { userAgentData?: NavigatorUAData })
      .userAgentData;
    if (navUA?.getHighEntropyValues) {
      const hints = await navUA.getHighEntropyValues([
        'model',
        'platform',
        'platformVersion',
      ]);
      if (hints.model && hints.model.trim()) {
        device_name = `${hints.model.trim()} • ${hints.platform || ''} (${largura}x${altura})`.trim();
      }
    }
  } catch {
    // Mantém fallback por User-Agent
  }

  let ip_address = 'Não identificado';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const resp = await fetch('/api/device-info', {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const json = (await resp.json()) as { ip?: string };
      if (json.ip) ip_address = json.ip;
    }
  } catch {
    // Fallback rápido para 4G instável ou offline
  }

  cacheTelemetria = {
    ip_address,
    device_id,
    device_name,
    user_agent: ua.slice(0, 280),
  };

  return cacheTelemetria;
}

/**
 * Extrai a chave de hardware física do device_id (ex: DEV-A1B2C3D4E5-XXXXXX -> DEV-A1B2C3D4E5)
 * para detectar múltiplos check-ins feitos no mesmo aparelho físico (mesmo em aba anônima).
 */
export function extrairAssinaturaFisicaAparelho(
  deviceId: string | null | undefined
): string | null {
  if (!deviceId) return null;
  const partes = deviceId.split('-');
  if (partes.length >= 2 && partes[0] === 'DEV') {
    return `${partes[0]}-${partes[1]}`;
  }
  return deviceId;
}

