import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://api.portalmilano.com';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-placeholder';

export const APP_PUBLIC_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://votar.portalmilano.com';

export const ADMIN_SENHA_INTERNA = 'M1l@no#26A';

// Garante que mesmo se uma variável de ambiente sem aspas tiver truncado no '#', a senha de 10 caracteres funcione
const envPinRaw = (
  process.env.NEXT_PUBLIC_ADMIN_PASSWORD ||
  process.env.NEXT_PUBLIC_ADMIN_PIN ||
  ''
).trim();

export const ADMIN_PIN_CONFIGURADO =
  envPinRaw.length >= 10 ? envPinRaw : ADMIN_SENHA_INTERNA;

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 25,
        },
        heartbeatIntervalMs: 15000,
      },
    });
  }
  return browserClient;
}
