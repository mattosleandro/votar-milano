-- ============================================================================
-- MIGRATION FASE 3 — REALTIME BROADCAST SANITIZADO (realtime.send)
-- 2 Canais Seguros (Zero PII, Read-Only para clientes via RLS em realtime.messages):
--   1) assembleia:<id>:placar     -> evento 'placar_update' (~600B, throttle 500ms)
--   2) assembleia:<id>:telao_grid -> evento 'grid_delta'    (~140B, delta unitario)
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NAO-DESTRUTIVA sobre dados historicos de 19/11/2026 e outros apps.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. TABELA UNLOGGED DE THROTTLING / COALESCING (Zero WAL, atomica sob pico)
-- ----------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS public.assembleia_broadcast_throttle (
  topic text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz
);

REVOKE ALL ON TABLE public.assembleia_broadcast_throttle FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assembleia_broadcast_throttle TO service_role;

-- ----------------------------------------------------------------------------
-- 2. AUTORIZACAO READ-ONLY EM realtime.messages (Clientes so LÊEM; so o banco PUBLICA!)
-- Nota: realtime.messages pertence a supabase_realtime_admin (RLS ja habilitado).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    SET LOCAL ROLE supabase_realtime_admin;
  END IF;

  DROP POLICY IF EXISTS "assembleia_broadcast_read_only" ON realtime.messages;
  CREATE POLICY "assembleia_broadcast_read_only"
    ON realtime.messages
    FOR SELECT
    TO anon, authenticated
    USING (
      extension = 'broadcast'
      AND (
        topic LIKE 'assembleia:%:placar'
        OR topic LIKE 'assembleia:%:telao_grid'
      )
    );

  RESET ROLE;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. FUNCOES PUBLICADORAS SANITIZADAS (ZERO PII + RESILIENTES A FALHA)
-- Nota: executam como SECURITY DEFINER com owner supabase_realtime_admin ou superuser
-- para poder inserir em realtime.messages via realtime.send().
-- ----------------------------------------------------------------------------

-- 3.1 Publica estado agregado e placar em assembleia:<id>:placar
CREATE OR REPLACE FUNCTION public.assembleia_publicar_placar(
  p_assembleia_id uuid,
  p_force boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, realtime
AS $$
DECLARE
  v_topic text;
  v_permitido boolean := false;
  v_estado jsonb;
  v_payload jsonb;
BEGIN
  IF p_assembleia_id IS NULL THEN
    RETURN;
  END IF;

  v_topic := 'assembleia:' || p_assembleia_id::text || ':placar';

  IF p_force THEN
    INSERT INTO public.assembleia_broadcast_throttle (topic, last_sent_at)
    VALUES (v_topic, now())
    ON CONFLICT (topic) DO UPDATE SET last_sent_at = now();
    v_permitido := true;
  ELSE
    -- Throttle atomico de 500ms para evitar tempestade de broadcasts durante rajadas de votos
    INSERT INTO public.assembleia_broadcast_throttle (topic, last_sent_at)
    VALUES (v_topic, now())
    ON CONFLICT (topic) DO UPDATE
      SET last_sent_at = now()
      WHERE public.assembleia_broadcast_throttle.last_sent_at <= now() - interval '500 milliseconds'
    RETURNING true INTO v_permitido;
  END IF;

  IF NOT COALESCE(v_permitido, false) THEN
    RETURN;
  END IF;

  v_estado := public.assembleia_estado_publico(p_assembleia_id);

  -- Remove a lista completa de pautas para manter o frame leve (~600B-1KB) e 100% sanitizado (Zero PII)
  v_payload := jsonb_build_object(
    'assembleia_id', p_assembleia_id,
    'server_now', v_estado -> 'server_now',
    'assembleia', v_estado -> 'assembleia',
    'pauta_aberta', v_estado -> 'pauta_aberta',
    'ultima_pauta_encerrada', v_estado -> 'ultima_pauta_encerrada',
    'placar', v_estado -> 'placar',
    'contadores', v_estado -> 'contadores'
  );

  PERFORM realtime.send(v_payload, 'placar_update', v_topic, true);
EXCEPTION WHEN OTHERS THEN
  -- Falha no broadcast NUNCA pode derrubar um voto ou check-in no Postgres
  RAISE WARNING 'assembleia_publicar_placar warning: %', SQLERRM;
END;
$$;

-- 3.2 Publica delta unitario sanitizado em assembleia:<id>:telao_grid
CREATE OR REPLACE FUNCTION public.assembleia_publicar_telao_delta(
  p_assembleia_id uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, realtime
AS $$
DECLARE
  v_topic text;
BEGIN
  IF p_assembleia_id IS NULL OR p_payload IS NULL THEN
    RETURN;
  END IF;

  v_topic := 'assembleia:' || p_assembleia_id::text || ':telao_grid';
  PERFORM realtime.send(p_payload, 'grid_delta', v_topic, true);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'assembleia_publicar_telao_delta warning: %', SQLERRM;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. TRIGGERS DE BROADCAST SANITIZADO (Zero PII, Zero impacto em outros apps)
-- ----------------------------------------------------------------------------

-- 4.1 public.assembleias (imediato — convocacao, timer, escopo, status, total_inadimplentes)
CREATE OR REPLACE FUNCTION public.trg_fn_broadcast_assembleias()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assembleia_publicar_placar(NEW.id, true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_assembleias ON public.assembleias;
CREATE TRIGGER trg_broadcast_assembleias
  AFTER INSERT OR UPDATE ON public.assembleias
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_broadcast_assembleias();

-- 4.2 public.assembleia_pautas (imediato — abrir, encerrar, nova rodada)
CREATE OR REPLACE FUNCTION public.trg_fn_broadcast_pautas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm_id uuid;
  v_pauta_id uuid;
  v_rodada smallint;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_asm_id := OLD.assembleia_id;
    v_pauta_id := OLD.id;
    v_rodada := OLD.rodada;
    v_status := 'deleted';
  ELSE
    v_asm_id := NEW.assembleia_id;
    v_pauta_id := NEW.id;
    v_rodada := NEW.rodada;
    v_status := NEW.status;
  END IF;

  PERFORM public.assembleia_publicar_placar(v_asm_id, true);
  PERFORM public.assembleia_publicar_telao_delta(
    v_asm_id,
    jsonb_build_object(
      'op', 'RELOAD_GRID',
      'assembleia_id', v_asm_id,
      'pauta_id', v_pauta_id,
      'rodada', v_rodada,
      'status', v_status
    )
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_pautas ON public.assembleia_pautas;
CREATE TRIGGER trg_broadcast_pautas
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_pautas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_broadcast_pautas();

-- 4.3 public.assembleia_presencas (delta ZERO PII no telao + placar throttled 500ms)
CREATE OR REPLACE FUNCTION public.trg_fn_broadcast_presencas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_asm_id := OLD.assembleia_id;
    PERFORM public.assembleia_publicar_telao_delta(
      v_asm_id,
      jsonb_build_object(
        'op', 'PRESENCA_DELETE',
        'assembleia_id', v_asm_id,
        'b', OLD.bloco,
        'a', OLD.apartamento
      )
    );
  ELSE
    v_asm_id := NEW.assembleia_id;
    PERFORM public.assembleia_publicar_telao_delta(
      v_asm_id,
      jsonb_build_object(
        'op', 'PRESENCA_UPSERT',
        'assembleia_id', v_asm_id,
        'unit', jsonb_build_object(
          'id', NEW.id,
          'b', NEW.bloco,
          'a', NEW.apartamento,
          'f', NEW.fase,
          'm', NEW.modulo,
          'pres', true,
          'port', NEW.confirmado_portaria,
          'onl', NEW.online_conectado,
          'proc', NEW.com_procuracao,
          'const', NEW.is_construtora
        )
      )
    );
  END IF;

  PERFORM public.assembleia_publicar_placar(v_asm_id, false);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_presencas ON public.assembleia_presencas;
CREATE TRIGGER trg_broadcast_presencas
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_presencas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_broadcast_presencas();

-- 4.4 public.assembleia_votos (delta ZERO PII no telao + placar throttled 500ms)
CREATE OR REPLACE FUNCTION public.trg_fn_broadcast_votos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_asm_id := OLD.assembleia_id;
    PERFORM public.assembleia_publicar_telao_delta(
      v_asm_id,
      jsonb_build_object(
        'op', 'VOTO_DELETE',
        'assembleia_id', v_asm_id,
        'pauta_id', OLD.pauta_id,
        'rodada', OLD.rodada,
        'b', OLD.bloco,
        'a', OLD.apartamento
      )
    );
  ELSE
    v_asm_id := NEW.assembleia_id;
    PERFORM public.assembleia_publicar_telao_delta(
      v_asm_id,
      jsonb_build_object(
        'op', 'VOTO_UPSERT',
        'assembleia_id', v_asm_id,
        'pauta_id', NEW.pauta_id,
        'rodada', NEW.rodada,
        'b', NEW.bloco,
        'a', NEW.apartamento,
        'voto', NEW.voto,
        'const', NEW.is_construtora
      )
    );
  END IF;

  PERFORM public.assembleia_publicar_placar(v_asm_id, false);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_votos ON public.assembleia_votos;
CREATE TRIGGER trg_broadcast_votos
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_votos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_broadcast_votos();

-- Revoga acesso direto publico as funcoes internas de broadcast
REVOKE ALL ON FUNCTION public.assembleia_publicar_placar(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assembleia_publicar_telao_delta(uuid, jsonb) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
