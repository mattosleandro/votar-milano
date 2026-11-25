import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://api.portalmilano.com';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-placeholder';

export const APP_PUBLIC_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://votar.portalmilano.com';

let publicClient: SupabaseClient | null = null;
let authClient: SupabaseClient | null = null;
let moradorClientCache: { token: string; client: SupabaseClient } | null = null;

/**
 * Cliente público (anon) — usado exclusivamente pelo /telao e leitura de RPCs públicas sanitizadas.
 */
export function getSupabasePublicClient(): SupabaseClient {
  if (!publicClient) {
    publicClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        heartbeatIntervalMs: 15000,
      },
    });
  }
  return publicClient;
}

/**
 * Cliente autenticado via Supabase Auth (e-mail + senha) — usado por /admin e /portaria.
 */
export function getSupabaseAuthClient(): SupabaseClient {
  if (!authClient) {
    authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'votar_milano_staff_auth_v2',
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        heartbeatIntervalMs: 15000,
      },
    });
  }
  return authClient;
}

/**
 * Cliente autenticado via JWT assinado do morador (emitido por POST /api/auth/checkin).
 * Usado exclusivamente na tela mobile (/) para leitura dos próprios votos e votação via RPC.
 */
export function getSupabaseMoradorClient(jwtToken: string): SupabaseClient {
  if (moradorClientCache && moradorClientCache.token === jwtToken) {
    return moradorClientCache.client;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
      heartbeatIntervalMs: 15000,
    },
  });

  moradorClientCache = { token: jwtToken, client };
  return client;
}

/**
 * Alias de compatibilidade apontando para o cliente público sanitizado.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  return getSupabasePublicClient();
}
