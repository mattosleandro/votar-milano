import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { UnidadeAutorizadaJwt } from './types';

function getInternalSupabaseUrl(): string {
  return (
    process.env.SUPABASE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    'http://supabase-envoy:8000'
  );
}

function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada no ambiente do servidor.');
  }
  return key;
}

function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error('SUPABASE_JWT_SECRET não configurada no ambiente do servidor.');
  }
  return secret;
}

let serverServiceClient: SupabaseClient | null = null;

/**
 * Cliente Supabase privilegiado (service_role) exclusivamente server-side.
 * Fala diretamente com http://supabase-envoy:8000 pela rede interna milano_net.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  if (!serverServiceClient) {
    serverServiceClient = createClient(getInternalSupabaseUrl(), getServiceRoleKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return serverServiceClient;
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Emite um JWT HS256 assinado com SUPABASE_JWT_SECRET compatível com PostgREST e Realtime.
 * As permissões ficam exclusivamente em app_metadata (lido por auth.jwt() no PostgreSQL).
 */
export function assinarJwtMorador(params: {
  cpfLimpo: string;
  assembleiaId: string;
  unidadesAutorizadas: UnidadeAutorizadaJwt[];
  ttlSegundos?: number;
}): { token: string; exp: number } {
  const secret = getJwtSecret();
  const agoraSec = Math.floor(Date.now() / 1000);
  const exp = agoraSec + (params.ttlSegundos ?? 8 * 60 * 60); // 8 horas de duração máxima da assembleia

  // Sub determinístico derivado via SHA-256 (nunca expõe o CPF em texto plano no payload do JWT)
  const subHash = crypto
    .createHash('sha256')
    .update(`milano-morador:${params.assembleiaId}:${params.cpfLimpo}`)
    .digest('hex');
  const subUuid = [
    subHash.slice(0, 8),
    subHash.slice(8, 12),
    '4' + subHash.slice(13, 16),
    'a' + subHash.slice(17, 20),
    subHash.slice(20, 32),
  ].join('-');

  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: subUuid,
    iat: agoraSec,
    exp,
    app_metadata: {
      app_role: 'morador',
      assembleia_id: params.assembleiaId,
      unidades_autorizadas: params.unidadesAutorizadas.map((u) => ({
        bloco: u.bloco,
        apartamento: u.apartamento,
        fase: u.fase,
        modulo: u.modulo,
        com_procuracao: Boolean(u.com_procuracao),
      })),
    },
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest();

  const encodedSignature = base64UrlEncode(signature);
  return {
    token: `${signingInput}.${encodedSignature}`,
    exp,
  };
}

// ----------------------------------------------------------------------------
// Rate Limiter leve em memória por CF-Connecting-IP (proteção contra brute-force de CPF)
// ----------------------------------------------------------------------------
interface RateLimitBucket {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitBucket>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQ = 30;

export function verificarRateLimitCheckin(ip: string): {
  permitido: boolean;
  retryAfterSeconds: number;
} {
  const agora = Date.now();
  const chave = ip || 'unknown';
  const bucket = rateLimitStore.get(chave) ?? { timestamps: [] };

  bucket.timestamps = bucket.timestamps.filter((t) => agora - t < RATE_LIMIT_WINDOW_MS);

  if (bucket.timestamps.length >= RATE_LIMIT_MAX_REQ) {
    const maisAntigo = bucket.timestamps[0] ?? agora;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((RATE_LIMIT_WINDOW_MS - (agora - maisAntigo)) / 1000)
    );
    rateLimitStore.set(chave, bucket);
    return { permitido: false, retryAfterSeconds };
  }

  bucket.timestamps.push(agora);
  rateLimitStore.set(chave, bucket);

  // Limpeza periódica para evitar crescimento ilimitado em memória
  if (rateLimitStore.size > 2000) {
    for (const [k, v] of rateLimitStore.entries()) {
      const ativos = v.timestamps.filter((t) => agora - t < RATE_LIMIT_WINDOW_MS);
      if (ativos.length === 0) rateLimitStore.delete(k);
      else v.timestamps = ativos;
    }
  }

  return { permitido: true, retryAfterSeconds: 0 };
}
