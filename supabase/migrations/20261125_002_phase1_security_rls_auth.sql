-- ============================================================================
-- MIGRATION FASE 1 — SEGURANÇA, AUTH (ADMIN/PORTARIA), JWT (MORADOR), RLS RIGOROSO
-- E REMOÇÃO DE TABELAS SENSÍVEIS DA PUBLICATION supabase_realtime
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NÃO-DESTRUTIVA sobre os dados históricos de 19/11/2026.
-- Preserva integralmente public.unidades_milano e demais tabelas de outros apps.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO VIA JWT (app_metadata — IMUTÁVEL PELO CLIENTE)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembleia_auth_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'app_role', '');
$$;

CREATE OR REPLACE FUNCTION public.assembleia_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT auth.role() = 'service_role'
      OR public.assembleia_auth_role() = 'admin';
$$;

CREATE OR REPLACE FUNCTION public.assembleia_is_portaria_or_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT auth.role() = 'service_role'
      OR public.assembleia_auth_role() IN ('admin', 'portaria');
$$;

CREATE OR REPLACE FUNCTION public.assembleia_auth_assembleia_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw text;
BEGIN
  v_raw := auth.jwt() -> 'app_metadata' ->> 'assembleia_id';
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_auth_unidades()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' -> 'unidades_autorizadas', '[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.assembleia_jwt_autoriza_unidade(
  p_assembleia_id uuid,
  p_bloco smallint,
  p_apartamento smallint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.assembleia_auth_role() = 'morador'
     AND public.assembleia_auth_assembleia_id() = p_assembleia_id
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(public.assembleia_auth_unidades()) elem
       WHERE (elem ->> 'bloco')::smallint = p_bloco
         AND (elem ->> 'apartamento')::smallint = p_apartamento
     );
$$;

-- ----------------------------------------------------------------------------
-- 2. ATUALIZAÇÃO DE TRIGGERS PARA MULTI-ASSEMBLEIA E VALIDAÇÃO DE PORTARIA
-- ----------------------------------------------------------------------------

-- 2.1 Recalcula contadores agregados anônimos de inadimplentes por assembleia (Zero PII)
DROP FUNCTION IF EXISTS public.assembleia_recalcular_totais_inadimplentes();

CREATE OR REPLACE FUNCTION public.assembleia_recalcular_totais_inadimplentes(
  p_assembleia_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm_id uuid := COALESCE(p_assembleia_id, public.assembleia_atual_id());
  v_todos integer := 0;
  v_f1 integer := 0;
  v_f2 integer := 0;
  v_m1 integer := 0;
  v_m2 integer := 0;
  v_m3 integer := 0;
  v_m4 integer := 0;
  v_mapa jsonb;
BEGIN
  IF v_asm_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE fase = 1)::integer,
    COUNT(*) FILTER (WHERE fase = 2)::integer,
    COUNT(*) FILTER (WHERE modulo = 1)::integer,
    COUNT(*) FILTER (WHERE modulo = 2)::integer,
    COUNT(*) FILTER (WHERE modulo = 3)::integer,
    COUNT(*) FILTER (WHERE modulo = 4)::integer
  INTO v_todos, v_f1, v_f2, v_m1, v_m2, v_m3, v_m4
  FROM public.assembleia_inadimplentes
  WHERE assembleia_id = v_asm_id;

  v_mapa := jsonb_build_object(
    'TODOS', COALESCE(v_todos, 0),
    'FASE_1', COALESCE(v_f1, 0),
    'FASE_2', COALESCE(v_f2, 0),
    'MODULO_1', COALESCE(v_m1, 0),
    'MODULO_2', COALESCE(v_m2, 0),
    'MODULO_3', COALESCE(v_m3, 0),
    'MODULO_4', COALESCE(v_m4, 0)
  );

  UPDATE public.assembleias
  SET total_inadimplentes = COALESCE(v_todos, 0),
      inadimplentes_por_escopo = v_mapa,
      updated_at = now()
  WHERE id = v_asm_id;

  -- Mantém espelho legado em assembleia_config enquanto existir
  UPDATE public.assembleia_config
  SET total_inadimplentes = COALESCE(v_todos, 0),
      inadimplentes_por_escopo = v_mapa,
      updated_at = now()
  WHERE id = 1
    AND assembleia_atual_id = v_asm_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_sync_totais_inadimplentes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assembleia_recalcular_totais_inadimplentes(OLD.assembleia_id);
  ELSE
    PERFORM public.assembleia_recalcular_totais_inadimplentes(NEW.assembleia_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_totais_inadimplentes ON public.assembleia_inadimplentes;
CREATE TRIGGER trg_sync_totais_inadimplentes
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_inadimplentes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_sync_totais_inadimplentes();

-- 2.2 Ao marcar inadimplente em uma assembleia, revoga presença e voto em pauta aberta DAQUELA assembleia
CREATE OR REPLACE FUNCTION public.trg_fn_after_insert_inadimplente_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.assembleia_votos v
  USING public.assembleia_pautas p
  WHERE v.pauta_id = p.id
    AND v.assembleia_id = NEW.assembleia_id
    AND p.assembleia_id = NEW.assembleia_id
    AND p.status = 'aberta'
    AND v.bloco = NEW.bloco
    AND v.apartamento = NEW.apartamento;

  DELETE FROM public.assembleia_presencas
  WHERE assembleia_id = NEW.assembleia_id
    AND bloco = NEW.bloco
    AND apartamento = NEW.apartamento;

  RETURN NEW;
END;
$$;

-- 2.3 Garante Fase/Módulo, normaliza CPF/cpf_procurador e bloqueia inadimplente NA MESMA assembleia
CREATE OR REPLACE FUNCTION public.trg_fn_before_presenca()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assembleia_id IS NULL THEN
    NEW.assembleia_id := public.assembleia_atual_id();
  END IF;

  NEW.fase := public.assembleia_calcular_fase(NEW.bloco);
  NEW.modulo := public.assembleia_calcular_modulo(NEW.bloco);
  NEW.cpf := regexp_replace(TRIM(NEW.cpf), '[^0-9A-Za-z_-]', '', 'g');
  NEW.nome_completo := regexp_replace(TRIM(NEW.nome_completo), '\s+', ' ', 'g');

  IF NEW.cpf_procurador IS NOT NULL THEN
    NEW.cpf_procurador := NULLIF(regexp_replace(TRIM(NEW.cpf_procurador), '\D', '', 'g'), '');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assembleia_inadimplentes i
    WHERE i.assembleia_id = NEW.assembleia_id
      AND i.bloco = NEW.bloco
      AND i.apartamento = NEW.apartamento
  ) THEN
    RAISE EXCEPTION 'UNIDADE_INADIMPLENTE: Unidade bloqueada para credenciamento e voto.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- 2.4 Sincronização de assembleia_unidades com assembleia ativa (inadimplentes e construtora)
-- Proteção histórica: só sincroniza com assembleia com status = 'ativa' (NUNCA toca em encerradas como 19/11/2026!)
CREATE OR REPLACE FUNCTION public.trg_fn_after_unidade_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm_id uuid;
BEGIN
  IF COALESCE(current_setting('assembleia.syncing_unidades', true), '') = 'true' THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_asm_id FROM public.assembleias WHERE status = 'ativa' LIMIT 1;

  IF v_asm_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'true', true);

  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.assembleia_inadimplentes
    WHERE assembleia_id = v_asm_id
      AND bloco = OLD.bloco
      AND apartamento = OLD.apartamento;

    IF OLD.is_construtora THEN
      DELETE FROM public.assembleia_presencas
      WHERE assembleia_id = v_asm_id
        AND bloco = OLD.bloco
        AND apartamento = OLD.apartamento
        AND is_construtora = true;

      DELETE FROM public.assembleia_votos
      WHERE assembleia_id = v_asm_id
        AND bloco = OLD.bloco
        AND apartamento = OLD.apartamento
        AND pauta_id IN (
          SELECT id FROM public.assembleia_pautas
          WHERE assembleia_id = v_asm_id AND status = 'aberta'
        );
    END IF;

    PERFORM set_config('assembleia.syncing_unidades', 'false', true);
    RETURN OLD;
  END IF;

  IF NEW.is_inadimplente THEN
    INSERT INTO public.assembleia_inadimplentes (assembleia_id, bloco, apartamento, fase, modulo, observacao)
    VALUES (v_asm_id, NEW.bloco, NEW.apartamento, NEW.fase, NEW.modulo, NEW.observacao)
    ON CONFLICT (assembleia_id, bloco, apartamento) DO UPDATE
      SET observacao = EXCLUDED.observacao;
  ELSE
    DELETE FROM public.assembleia_inadimplentes
    WHERE assembleia_id = v_asm_id
      AND bloco = NEW.bloco
      AND apartamento = NEW.apartamento;
  END IF;

  IF NEW.is_construtora THEN
    INSERT INTO public.assembleia_presencas (
      assembleia_id, bloco, apartamento, fase, modulo, nome_completo, cpf,
      is_construtora, confirmado_portaria, online_conectado
    )
    VALUES (
      v_asm_id, NEW.bloco, NEW.apartamento, NEW.fase, NEW.modulo, NEW.nome_completo,
      'CONSTRUTORA', true, true, true
    )
    ON CONFLICT (assembleia_id, bloco, apartamento) DO UPDATE
      SET nome_completo = EXCLUDED.nome_completo,
          cpf = 'CONSTRUTORA',
          is_construtora = true,
          confirmado_portaria = true,
          online_conectado = true;
  ELSE
    DELETE FROM public.assembleia_presencas
    WHERE assembleia_id = v_asm_id
      AND bloco = NEW.bloco
      AND apartamento = NEW.apartamento
      AND is_construtora = true;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'false', true);
  RETURN NEW;
END;
$$;

-- 2.5 TRIGGER CRÍTICA DE INTEGRIDADE DO VOTO (Valida assembleia ativa, pauta aberta,
-- confirmado_portaria quando exigido, adimplência, presença e escopo)
CREATE OR REPLACE FUNCTION public.trg_fn_before_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pauta_asm_id uuid;
  v_status text;
  v_escopo text;
  v_asm_status text;
  v_exigir_portaria boolean;
  v_fase smallint;
  v_modulo smallint;
  v_is_construtora boolean;
  v_confirmado_portaria boolean;
BEGIN
  SELECT assembleia_id, status, escopo
  INTO v_pauta_asm_id, v_status, v_escopo
  FROM public.assembleia_pautas
  WHERE id = NEW.pauta_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'PAUTA_INEXISTENTE: A pauta informada não existe.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT status, exigir_confirmacao_portaria
  INTO v_asm_status, v_exigir_portaria
  FROM public.assembleias
  WHERE id = v_pauta_asm_id;

  IF v_asm_status <> 'ativa' THEN
    RAISE EXCEPTION 'ASSEMBLEIA_INATIVA: Esta assembleia não está ativa para votação.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_status <> 'aberta' THEN
    RAISE EXCEPTION 'PAUTA_ENCERRADA: A votação desta pauta não está aberta. Os votos estão congelados.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assembleia_inadimplentes i
    WHERE i.assembleia_id = v_pauta_asm_id
      AND i.bloco = NEW.bloco
      AND i.apartamento = NEW.apartamento
  ) THEN
    RAISE EXCEPTION 'UNIDADE_INADIMPLENTE: Esta unidade não está apta a votar.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT fase, modulo, is_construtora, confirmado_portaria
  INTO v_fase, v_modulo, v_is_construtora, v_confirmado_portaria
  FROM public.assembleia_presencas
  WHERE assembleia_id = v_pauta_asm_id
    AND bloco = NEW.bloco
    AND apartamento = NEW.apartamento;

  IF v_fase IS NULL THEN
    RAISE EXCEPTION 'UNIDADE_SEM_CHECKIN: A unidade precisa estar credenciada na assembleia para votar.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_exigir_portaria, true)
     AND NOT COALESCE(v_is_construtora, false)
     AND NOT COALESCE(v_confirmado_portaria, false) THEN
    RAISE EXCEPTION 'AGUARDANDO_CONFIRMACAO_PORTARIA: A unidade precisa ter a entrada confirmada na Portaria para votar.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_fase, v_modulo, v_escopo) THEN
    RAISE EXCEPTION 'FORA_DO_ESCOPO: Esta unidade não pertence ao escopo permitido desta votação (%).', v_escopo
      USING ERRCODE = 'P0001';
  END IF;

  NEW.assembleia_id := v_pauta_asm_id;
  NEW.is_construtora := COALESCE(v_is_construtora, false);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. RPCs PÚBLICAS SANITIZADAS (ZERO PII) E RPCs AUTENTICADAS POR PAPEL
-- ----------------------------------------------------------------------------

-- 3.1 Estado público 100% sanitizado (usado por / e /telao — ZERO CPF, ZERO Nome, ZERO IP/Device)
CREATE OR REPLACE FUNCTION public.assembleia_estado_publico(
  p_assembleia_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm public.assembleias%ROWTYPE;
  v_pauta_aberta public.assembleia_pautas%ROWTYPE;
  v_ultima_encerrada public.assembleia_pautas%ROWTYPE;
  v_pauta_foco public.assembleia_pautas%ROWTYPE;
  v_has_foco boolean := false;
  v_pautas_resumo jsonb := '[]'::jsonb;
  v_placar jsonb := NULL;
  v_total_presentes integer := 0;
  v_fase1 integer := 0;
  v_fase2 integer := 0;
  v_construtora integer := 0;
  v_portaria integer := 0;
  v_online integer := 0;
  v_procuracao integer := 0;
  v_presentes_escopo integer := 0;
  v_sim integer := 0;
  v_nao integer := 0;
  v_nao_votaram integer := 0;
  v_presentes_aptos integer := 0;
  v_total_votos integer := 0;
  v_vencedor text := 'SEM_VOTOS';
BEGIN
  IF p_assembleia_id IS NOT NULL THEN
    SELECT * INTO v_asm FROM public.assembleias WHERE id = p_assembleia_id;
  ELSE
    SELECT * INTO v_asm FROM public.assembleias WHERE status = 'ativa' LIMIT 1;
    IF NOT FOUND THEN
      SELECT * INTO v_asm
      FROM public.assembleias
      ORDER BY data_assembleia DESC, created_at DESC
      LIMIT 1;
    END IF;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'server_now', now(),
      'assembleia', NULL,
      'pauta_aberta', NULL,
      'ultima_pauta_encerrada', NULL,
      'pautas', '[]'::jsonb,
      'placar', NULL,
      'contadores', jsonb_build_object(
        'total', 0, 'fase1', 0, 'fase2', 0, 'construtora', 0,
        'confirmados_portaria', 0, 'conectados_online', 0, 'com_procuracao', 0,
        'presentes_no_escopo', 0
      )
    );
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'assembleia_id', p.assembleia_id,
        'ordem', p.ordem,
        'titulo', p.titulo,
        'descricao', p.descricao,
        'escopo', p.escopo,
        'status', p.status,
        'created_at', p.created_at,
        'opened_at', p.opened_at,
        'closed_at', p.closed_at
      )
      ORDER BY p.ordem ASC, p.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_pautas_resumo
  FROM public.assembleia_pautas p
  WHERE p.assembleia_id = v_asm.id;

  SELECT * INTO v_pauta_aberta
  FROM public.assembleia_pautas
  WHERE assembleia_id = v_asm.id AND status = 'aberta'
  LIMIT 1;

  SELECT * INTO v_ultima_encerrada
  FROM public.assembleia_pautas
  WHERE assembleia_id = v_asm.id AND status = 'encerrada'
  ORDER BY closed_at DESC NULLS LAST, ordem DESC
  LIMIT 1;

  IF v_pauta_aberta.id IS NOT NULL THEN
    v_pauta_foco := v_pauta_aberta;
    v_has_foco := true;
  ELSIF v_ultima_encerrada.id IS NOT NULL THEN
    v_pauta_foco := v_ultima_encerrada;
    v_has_foco := true;
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE fase = 1)::integer,
    COUNT(*) FILTER (WHERE fase = 2)::integer,
    COUNT(*) FILTER (WHERE is_construtora)::integer,
    COUNT(*) FILTER (WHERE NOT is_construtora AND confirmado_portaria)::integer,
    COUNT(*) FILTER (WHERE NOT is_construtora AND online_conectado)::integer,
    COUNT(*) FILTER (WHERE NOT is_construtora AND com_procuracao)::integer,
    COUNT(*) FILTER (
      WHERE public.assembleia_pertence_escopo(
        fase,
        modulo,
        CASE WHEN v_has_foco THEN v_pauta_foco.escopo ELSE v_asm.escopo_assembleia END
      )
    )::integer
  INTO v_total_presentes, v_fase1, v_fase2, v_construtora, v_portaria, v_online, v_procuracao, v_presentes_escopo
  FROM public.assembleia_presencas
  WHERE assembleia_id = v_asm.id;

  IF v_has_foco THEN
    SELECT
      COUNT(*) FILTER (WHERE v.voto = 'SIM')::integer,
      COUNT(*) FILTER (WHERE v.voto = 'NAO')::integer
    INTO v_sim, v_nao
    FROM public.assembleia_votos v
    WHERE v.assembleia_id = v_asm.id
      AND v.pauta_id = v_pauta_foco.id
      AND public.assembleia_pertence_escopo(
        public.assembleia_calcular_fase(v.bloco),
        public.assembleia_calcular_modulo(v.bloco),
        v_pauta_foco.escopo
      );

    v_total_votos := COALESCE(v_sim, 0) + COALESCE(v_nao, 0);
    v_presentes_aptos := GREATEST(COALESCE(v_presentes_escopo, 0), v_total_votos);
    v_nao_votaram := GREATEST(v_presentes_aptos - v_total_votos, 0);

    IF v_total_votos > 0 THEN
      IF v_sim > v_nao THEN v_vencedor := 'SIM';
      ELSIF v_nao > v_sim THEN v_vencedor := 'NAO';
      ELSE v_vencedor := 'EMPATE';
      END IF;
    END IF;

    v_placar := jsonb_build_object(
      'pauta_id', v_pauta_foco.id,
      'escopo', v_pauta_foco.escopo,
      'presentes_aptos', v_presentes_aptos,
      'sim', COALESCE(v_sim, 0),
      'nao', COALESCE(v_nao, 0),
      'nao_votaram', v_nao_votaram,
      'total_votos', v_total_votos,
      'vencedor', v_vencedor
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now', now(),
    'assembleia', jsonb_build_object(
      'id', v_asm.id,
      'titulo', v_asm.titulo,
      'data_assembleia', v_asm.data_assembleia,
      'status', v_asm.status,
      'assembleia_ativa', (v_asm.status = 'ativa' AND v_asm.convocacao_ativa <> 'ENCERRADA'),
      'convocacao_ativa', v_asm.convocacao_ativa,
      'horario_primeira_convocacao', v_asm.horario_primeira_convocacao,
      'horario_segunda_convocacao', v_asm.horario_segunda_convocacao,
      'escopo_assembleia', v_asm.escopo_assembleia,
      'descontar_inadimplentes_quorum', v_asm.descontar_inadimplentes_quorum,
      'exigir_confirmacao_portaria', v_asm.exigir_confirmacao_portaria,
      'total_inadimplentes', v_asm.total_inadimplentes,
      'inadimplentes_por_escopo', v_asm.inadimplentes_por_escopo,
      'timer_duration_seconds', v_asm.timer_duration_seconds,
      'timer_started_at', v_asm.timer_started_at,
      'timer_running', v_asm.timer_running,
      'version', v_asm.version,
      'updated_at', v_asm.updated_at
    ),
    'pauta_aberta', CASE WHEN v_pauta_aberta.id IS NOT NULL THEN jsonb_build_object(
      'id', v_pauta_aberta.id,
      'assembleia_id', v_pauta_aberta.assembleia_id,
      'ordem', v_pauta_aberta.ordem,
      'titulo', v_pauta_aberta.titulo,
      'descricao', v_pauta_aberta.descricao,
      'escopo', v_pauta_aberta.escopo,
      'status', v_pauta_aberta.status,
      'created_at', v_pauta_aberta.created_at,
      'opened_at', v_pauta_aberta.opened_at,
      'closed_at', v_pauta_aberta.closed_at
    ) ELSE NULL END,
    'ultima_pauta_encerrada', CASE WHEN v_ultima_encerrada.id IS NOT NULL THEN jsonb_build_object(
      'id', v_ultima_encerrada.id,
      'assembleia_id', v_ultima_encerrada.assembleia_id,
      'ordem', v_ultima_encerrada.ordem,
      'titulo', v_ultima_encerrada.titulo,
      'descricao', v_ultima_encerrada.descricao,
      'escopo', v_ultima_encerrada.escopo,
      'status', v_ultima_encerrada.status,
      'created_at', v_ultima_encerrada.created_at,
      'opened_at', v_ultima_encerrada.opened_at,
      'closed_at', v_ultima_encerrada.closed_at
    ) ELSE NULL END,
    'pautas', v_pautas_resumo,
    'placar', v_placar,
    'contadores', jsonb_build_object(
      'total', COALESCE(v_total_presentes, 0),
      'fase1', COALESCE(v_fase1, 0),
      'fase2', COALESCE(v_fase2, 0),
      'construtora', COALESCE(v_construtora, 0),
      'confirmados_portaria', COALESCE(v_portaria, 0),
      'conectados_online', COALESCE(v_online, 0),
      'com_procuracao', COALESCE(v_procuracao, 0),
      'presentes_no_escopo', COALESCE(v_presentes_escopo, 0)
    )
  );
END;
$$;

-- 3.2 Snapshot compacto e sanitizado do /telao (1 objeto JSON — sem limite de 1.000 linhas e ZERO PII)
CREATE OR REPLACE FUNCTION public.assembleia_telao_snapshot(
  p_assembleia_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado jsonb;
  v_asm_id uuid;
  v_pauta_foco_id uuid;
  v_unidades_grid jsonb := '[]'::jsonb;
BEGIN
  v_estado := public.assembleia_estado_publico(p_assembleia_id);
  v_asm_id := NULLIF(v_estado -> 'assembleia' ->> 'id', '')::uuid;

  IF v_asm_id IS NULL THEN
    RETURN v_estado || jsonb_build_object('unidades_grid', '[]'::jsonb);
  END IF;

  v_pauta_foco_id := COALESCE(
    NULLIF(v_estado -> 'pauta_aberta' ->> 'id', '')::uuid,
    NULLIF(v_estado -> 'ultima_pauta_encerrada' ->> 'id', '')::uuid
  );

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.id,
        'b', pr.bloco,
        'a', pr.apartamento,
        'f', pr.fase,
        'm', pr.modulo,
        'pres', true,
        'port', pr.confirmado_portaria,
        'onl', pr.online_conectado,
        'proc', pr.com_procuracao,
        'const', pr.is_construtora,
        'voto', v.voto
      )
      ORDER BY pr.bloco ASC, pr.apartamento ASC
    ),
    '[]'::jsonb
  )
  INTO v_unidades_grid
  FROM public.assembleia_presencas pr
  LEFT JOIN public.assembleia_votos v
    ON v.assembleia_id = v_asm_id
   AND v.pauta_id = v_pauta_foco_id
   AND v.bloco = pr.bloco
   AND v.apartamento = pr.apartamento
  WHERE pr.assembleia_id = v_asm_id;

  RETURN v_estado || jsonb_build_object('unidades_grid', v_unidades_grid);
END;
$$;

-- 3.3 Registro autenticado de voto via JWT (valida unidades_autorizadas no JWT + bloqueia redundância)
CREATE OR REPLACE FUNCTION public.assembleia_registrar_voto(
  p_pauta_id uuid,
  p_bloco smallint,
  p_apartamento smallint,
  p_voto text,
  p_ip_address text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_device_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_voto_limpo text := UPPER(TRIM(COALESCE(p_voto, '')));
  v_voto_atual text;
  v_registro public.assembleia_votos%ROWTYPE;
BEGIN
  IF v_voto_limpo NOT IN ('SIM', 'NAO') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'OPCAO_INVALIDA',
      'message', 'Opção de voto inválida. Escolha SIM ou NÃO.'
    );
  END IF;

  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'PAUTA_INEXISTENTE',
      'message', 'Pauta não encontrada.'
    );
  END IF;

  -- Validação estrita de autorização: apenas admin ou morador com unidade no JWT
  IF NOT (
    public.assembleia_is_admin()
    OR public.assembleia_jwt_autoriza_unidade(v_pauta.assembleia_id, p_bloco, p_apartamento)
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'NAO_AUTORIZADO',
      'message', 'Sua sessão não está autorizada a votar por esta unidade. Faça a validação por CPF novamente.'
    );
  END IF;

  -- Ignora re-submissão idêntica à opção já registrada (evita escrita redundante)
  SELECT voto INTO v_voto_atual
  FROM public.assembleia_votos
  WHERE pauta_id = p_pauta_id
    AND bloco = p_bloco
    AND apartamento = p_apartamento;

  IF v_voto_atual = v_voto_limpo THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'VOTO_JA_REGISTRADO',
      'ja_igual', true,
      'voto', v_voto_limpo,
      'pauta_id', p_pauta_id,
      'bloco', p_bloco,
      'apartamento', p_apartamento
    );
  END IF;

  INSERT INTO public.assembleia_votos (
    assembleia_id,
    pauta_id,
    bloco,
    apartamento,
    voto,
    ip_address,
    device_id,
    device_name
  )
  VALUES (
    v_pauta.assembleia_id,
    p_pauta_id,
    p_bloco,
    p_apartamento,
    v_voto_limpo,
    NULLIF(TRIM(COALESCE(p_ip_address, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_id, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_name, '')), '')
  )
  ON CONFLICT (pauta_id, bloco, apartamento) DO UPDATE
    SET voto = EXCLUDED.voto,
        ip_address = COALESCE(EXCLUDED.ip_address, public.assembleia_votos.ip_address),
        device_id = COALESCE(EXCLUDED.device_id, public.assembleia_votos.device_id),
        device_name = COALESCE(EXCLUDED.device_name, public.assembleia_votos.device_name),
        updated_at = now()
  RETURNING * INTO v_registro;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'VOTO_COMPUTADO',
    'ja_igual', false,
    'id', v_registro.id,
    'voto', v_registro.voto,
    'pauta_id', v_registro.pauta_id,
    'bloco', v_registro.bloco,
    'apartamento', v_registro.apartamento,
    'updated_at', v_registro.updated_at
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok', false,
    'code', 'ERRO_VALIDACAO_VOTO',
    'message', SQLERRM
  );
END;
$$;

-- 3.4 Confirmação de Presença na Portaria (exige role portaria ou admin + suporta cpf_procurador)
CREATE OR REPLACE FUNCTION public.assembleia_confirmar_portaria(
  p_bloco smallint,
  p_apartamento smallint,
  p_com_procuracao boolean DEFAULT false,
  p_observacao text DEFAULT NULL,
  p_cpf_procurador text DEFAULT NULL,
  p_assembleia_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm public.assembleias%ROWTYPE;
  v_unidade public.assembleia_unidades%ROWTYPE;
  v_presenca public.assembleia_presencas%ROWTYPE;
  v_cpf_proc text := NULLIF(regexp_replace(COALESCE(p_cpf_procurador, ''), '\D', '', 'g'), '');
BEGIN
  IF NOT public.assembleia_is_portaria_or_admin() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ACESSO_NEGADO',
      'message', 'Acesso restrito a usuários autenticados da Portaria ou Mesa Diretora.'
    );
  END IF;

  IF p_assembleia_id IS NOT NULL THEN
    SELECT * INTO v_asm FROM public.assembleias WHERE id = p_assembleia_id;
  ELSE
    SELECT * INTO v_asm FROM public.assembleias WHERE status = 'ativa' LIMIT 1;
  END IF;

  IF NOT FOUND OR v_asm.status <> 'ativa' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SEM_ASSEMBLEIA_ATIVA',
      'message', 'Não existe nenhuma assembleia ativa no momento. Ative a assembleia no painel da Mesa antes de liberar entradas na Portaria.'
    );
  END IF;

  SELECT * INTO v_unidade
  FROM public.assembleia_unidades
  WHERE bloco = p_bloco AND apartamento = p_apartamento;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_NAO_CADASTRADA',
      'message', 'Unidade não localizada no cadastro base.'
    );
  END IF;

  IF v_unidade.is_inadimplente OR EXISTS (
    SELECT 1 FROM public.assembleia_inadimplentes i
    WHERE i.assembleia_id = v_asm.id AND i.bloco = p_bloco AND i.apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_INADIMPLENTE',
      'message', 'Unidade consta como INADIMPLENTE e está bloqueada para voto. Encaminhe o morador ao Síndico / Mesa Diretora.'
    );
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_unidade.fase, v_unidade.modulo, v_asm.escopo_assembleia) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_QUORUM',
      'message', format(
        'O Bloco %s • Apto %s (Fase %s • Módulo %s) não pertence ao escopo desta assembleia (%s).',
        lpad(p_bloco::text, 2, '0'), p_apartamento, v_unidade.fase, v_unidade.modulo, v_asm.escopo_assembleia
      )
    );
  END IF;

  INSERT INTO public.assembleia_presencas (
    assembleia_id,
    bloco,
    apartamento,
    fase,
    modulo,
    nome_completo,
    cpf,
    is_construtora,
    confirmado_portaria,
    online_conectado,
    com_procuracao,
    observacao_portaria,
    cpf_procurador
  )
  VALUES (
    v_asm.id,
    v_unidade.bloco,
    v_unidade.apartamento,
    v_unidade.fase,
    v_unidade.modulo,
    v_unidade.nome_completo,
    v_unidade.cpf,
    v_unidade.is_construtora,
    true,
    false,
    COALESCE(p_com_procuracao, false),
    NULLIF(TRIM(COALESCE(p_observacao, '')), ''),
    CASE WHEN COALESCE(p_com_procuracao, false) THEN v_cpf_proc ELSE NULL END
  )
  ON CONFLICT (assembleia_id, bloco, apartamento) DO UPDATE
    SET confirmado_portaria = true,
        com_procuracao = COALESCE(p_com_procuracao, public.assembleia_presencas.com_procuracao),
        observacao_portaria = COALESCE(
          NULLIF(TRIM(COALESCE(p_observacao, '')), ''),
          public.assembleia_presencas.observacao_portaria
        ),
        cpf_procurador = CASE
          WHEN COALESCE(p_com_procuracao, false) THEN COALESCE(v_cpf_proc, public.assembleia_presencas.cpf_procurador)
          ELSE NULL
        END
  RETURNING * INTO v_presenca;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'PORTARIA_CONFIRMADA',
    'message', format(
      'Entrada confirmada! Bloco %s • Apto %s (Fase %s) já está visível no telão e liberado para validar no celular.',
      lpad(v_presenca.bloco::text, 2, '0'), v_presenca.apartamento, v_presenca.fase
    ),
    'presenca', jsonb_build_object(
      'id', v_presenca.id,
      'assembleia_id', v_presenca.assembleia_id,
      'bloco', v_presenca.bloco,
      'apartamento', v_presenca.apartamento,
      'fase', v_presenca.fase,
      'modulo', v_presenca.modulo,
      'nome_completo', v_presenca.nome_completo,
      'cpf', v_presenca.cpf,
      'is_construtora', v_presenca.is_construtora,
      'confirmado_portaria', v_presenca.confirmado_portaria,
      'online_conectado', v_presenca.online_conectado,
      'com_procuracao', v_presenca.com_procuracao,
      'observacao_portaria', v_presenca.observacao_portaria,
      'cpf_procurador', v_presenca.cpf_procurador,
      'created_at', v_presenca.created_at
    )
  );
END;
$$;

-- 3.5 Cancelamento de entrada na Portaria (apenas portaria ou admin, sem alterar pautas encerradas)
CREATE OR REPLACE FUNCTION public.assembleia_cancelar_entrada_portaria(
  p_presenca_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pr public.assembleia_presencas%ROWTYPE;
BEGIN
  IF NOT public.assembleia_is_portaria_or_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Acesso negado.');
  END IF;

  SELECT * INTO v_pr FROM public.assembleia_presencas WHERE id = p_presenca_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Presença não encontrada.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.assembleias WHERE id = v_pr.assembleia_id AND status = 'encerrada') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Não é possível remover presença de uma assembleia já encerrada.');
  END IF;

  IF v_pr.is_construtora AND NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Apenas administradores podem remover unidades da Construtora.');
  END IF;

  DELETE FROM public.assembleia_votos v
  USING public.assembleia_pautas p
  WHERE v.pauta_id = p.id
    AND v.assembleia_id = v_pr.assembleia_id
    AND p.status = 'aberta'
    AND v.bloco = v_pr.bloco
    AND v.apartamento = v_pr.apartamento;

  DELETE FROM public.assembleia_presencas WHERE id = p_presenca_id;

  RETURN jsonb_build_object(
    'ok', true,
    'message', format('Bloco %s • Apto %s removido da lista de presença.', lpad(v_pr.bloco::text, 2, '0'), v_pr.apartamento)
  );
END;
$$;

-- 3.6 Proteção e atualização multi-assembleia das RPCs administrativas
CREATE OR REPLACE FUNCTION public.assembleia_abrir_pauta(p_pauta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_asm public.assembleias%ROWTYPE;
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_total_fisico integer;
  v_inad_escopo integer;
  v_base_quorum integer;
  v_minimo_primeira integer;
  v_presentes_escopo integer;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem abrir pautas.');
  END IF;

  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Pauta não encontrada.');
  END IF;

  SELECT * INTO v_asm FROM public.assembleias WHERE id = v_pauta.assembleia_id;
  IF NOT FOUND OR v_asm.status <> 'ativa' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'A assembleia vinculada a esta pauta não está ativa.');
  END IF;

  IF v_asm.convocacao_ativa IN ('AGUARDANDO', 'ENCERRADA') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'message', 'A assembleia está com status "' || v_asm.convocacao_ativa || '". Ative a 1ª ou a 2ª Convocação antes de abrir uma pauta.'
    );
  END IF;

  IF v_asm.convocacao_ativa = 'PRIMEIRA' THEN
    v_total_fisico := public.assembleia_total_unidades_escopo(v_pauta.escopo);
    v_inad_escopo := COALESCE((v_asm.inadimplentes_por_escopo ->> v_pauta.escopo)::integer, 0);

    IF v_asm.descontar_inadimplentes_quorum THEN
      v_base_quorum := GREATEST(v_total_fisico - v_inad_escopo, 1);
    ELSE
      v_base_quorum := v_total_fisico;
    END IF;

    v_minimo_primeira := (v_base_quorum / 2) + 1;

    SELECT COUNT(*)::integer INTO v_presentes_escopo
    FROM public.assembleia_presencas pr
    WHERE pr.assembleia_id = v_asm.id
      AND public.assembleia_pertence_escopo(pr.fase, pr.modulo, v_pauta.escopo);

    IF v_presentes_escopo < v_minimo_primeira THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'QUORUM_INSUFICIENTE_PRIMEIRA_CONVOCACAO',
        'message', format(
          'Quórum insuficiente para 1ª Convocação (Maioria Absoluta): %s presentes de %s necessários no escopo %s.',
          v_presentes_escopo, v_minimo_primeira, v_pauta.escopo
        )
      );
    END IF;
  END IF;

  UPDATE public.assembleia_pautas
  SET status = 'encerrada', closed_at = now()
  WHERE assembleia_id = v_asm.id AND status = 'aberta' AND id <> p_pauta_id;

  UPDATE public.assembleia_pautas
  SET status = 'aberta', opened_at = COALESCE(opened_at, now()), closed_at = NULL
  WHERE id = p_pauta_id;

  UPDATE public.assembleias
  SET timer_running = true,
      timer_started_at = now(),
      timer_duration_seconds = CASE WHEN COALESCE(timer_duration_seconds, 0) <= 0 THEN 120 ELSE timer_duration_seconds END,
      updated_at = now()
  WHERE id = v_asm.id;

  RETURN jsonb_build_object('ok', true, 'message', 'Votação aberta e cronômetro iniciado com sucesso!');
END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_resetar_pauta(
  p_pauta_id uuid,
  p_reabrir boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_res jsonb;
  v_pauta public.assembleia_pautas%ROWTYPE;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem resetar pautas.');
  END IF;

  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Pauta não encontrada.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.assembleias WHERE id = v_pauta.assembleia_id AND status = 'encerrada') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Não é permitido resetar pautas de uma assembleia já encerrada.');
  END IF;

  PERFORM set_config('assembleia.allow_reset', 'true', true);
  DELETE FROM public.assembleia_votos WHERE pauta_id = p_pauta_id;
  PERFORM set_config('assembleia.allow_reset', 'false', true);

  IF p_reabrir THEN
    v_open_res := public.assembleia_abrir_pauta(p_pauta_id);
    IF NOT COALESCE((v_open_res ->> 'ok')::boolean, false) THEN
      UPDATE public.assembleia_pautas
      SET status = 'aguardando', opened_at = NULL, closed_at = NULL
      WHERE id = p_pauta_id;
      RETURN v_open_res;
    END IF;
    RETURN jsonb_build_object('ok', true, 'message', 'Votos zerados e pauta reaberta para votação!');
  ELSE
    UPDATE public.assembleia_pautas
    SET status = 'aguardando', opened_at = NULL, closed_at = NULL
    WHERE id = p_pauta_id;
    RETURN jsonb_build_object('ok', true, 'message', 'Pauta resetada para aguardando e votos zerados.');
  END IF;
END;
$$;

-- Criar nova assembleia (sem NUNCA apagar assembleias históricas anteriores!)
CREATE OR REPLACE FUNCTION public.assembleia_criar_nova(
  p_titulo text,
  p_escopo text DEFAULT 'TODOS',
  p_horario_1 text DEFAULT '19:00',
  p_horario_2 text DEFAULT '19:30',
  p_ativar boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nova public.assembleias%ROWTYPE;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem criar assembleias.');
  END IF;

  IF p_ativar AND EXISTS (SELECT 1 FROM public.assembleias WHERE status = 'ativa') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'JA_EXISTE_ASSEMBLEIA_ATIVA',
      'message', 'Já existe uma assembleia ativa. Encerre e arquive a assembleia atual antes de iniciar uma nova.'
    );
  END IF;

  INSERT INTO public.assembleias (
    titulo,
    status,
    convocacao_ativa,
    horario_primeira_convocacao,
    horario_segunda_convocacao,
    escopo_assembleia,
    started_at
  )
  VALUES (
    COALESCE(NULLIF(TRIM(p_titulo), ''), 'Assembleia Geral — ' || to_char(now() AT TIME ZONE 'America/Campo_Grande', 'DD/MM/YYYY')),
    CASE WHEN p_ativar THEN 'ativa' ELSE 'rascunho' END,
    'AGUARDANDO',
    COALESCE(NULLIF(TRIM(p_horario_1), ''), '19:00'),
    COALESCE(NULLIF(TRIM(p_horario_2), ''), '19:30'),
    COALESCE(NULLIF(TRIM(p_escopo), ''), 'TODOS'),
    CASE WHEN p_ativar THEN now() ELSE NULL END
  )
  RETURNING * INTO v_nova;

  IF p_ativar THEN
    UPDATE public.assembleia_config
    SET assembleia_atual_id = v_nova.id,
        assembleia_ativa = true,
        convocacao_ativa = v_nova.convocacao_ativa,
        horario_primeira_convocacao = v_nova.horario_primeira_convocacao,
        horario_segunda_convocacao = v_nova.horario_segunda_convocacao,
        escopo_assembleia = v_nova.escopo_assembleia,
        updated_at = now()
    WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'assembleia', to_jsonb(v_nova),
    'message', 'Nova assembleia criada com sucesso (históricos anteriores preservados intactos)!'
  );
END;
$$;

-- Proteger assembleia_resetar_geral: agora NUNCA apaga assembleias encerradas (ex: 19/11/2026)!
-- Apenas limpa rascunho/ativa atual se solicitado por admin, ou cria nova assembleia limpa.
CREATE OR REPLACE FUNCTION public.assembleia_resetar_geral(
  p_manter_cadastro_base boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ativa_id uuid;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem resetar a assembleia ativa.');
  END IF;

  SELECT id INTO v_ativa_id FROM public.assembleias WHERE status = 'ativa' LIMIT 1;

  IF v_ativa_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SEM_ASSEMBLEIA_ATIVA',
      'message', 'Não há assembleia ativa para resetar. Assembleias encerradas (como 19/11/2026) são preservadas permanentemente. Use "Criar Nova Assembleia".'
    );
  END IF;

  PERFORM set_config('assembleia.allow_reset', 'true', true);
  PERFORM set_config('assembleia.bypass_freeze', 'true', true);

  DELETE FROM public.assembleia_votos WHERE assembleia_id = v_ativa_id;
  DELETE FROM public.assembleia_pautas WHERE assembleia_id = v_ativa_id;

  IF p_manter_cadastro_base THEN
    DELETE FROM public.assembleia_presencas WHERE assembleia_id = v_ativa_id AND NOT is_construtora;
  ELSE
    DELETE FROM public.assembleia_presencas WHERE assembleia_id = v_ativa_id;
    DELETE FROM public.assembleia_inadimplentes WHERE assembleia_id = v_ativa_id;
  END IF;

  PERFORM public.assembleia_sincronizar_unidades_milano();

  UPDATE public.assembleias
  SET convocacao_ativa = 'AGUARDANDO',
      timer_running = false,
      timer_started_at = NULL,
      timer_duration_seconds = 120,
      updated_at = now()
  WHERE id = v_ativa_id;

  PERFORM public.assembleia_recalcular_totais_inadimplentes(v_ativa_id);
  PERFORM set_config('assembleia.allow_reset', 'false', true);
  PERFORM set_config('assembleia.bypass_freeze', 'false', true);

  RETURN jsonb_build_object(
    'ok', true,
    'message', 'Assembleia ativa reiniciada (históricos de assembleias anteriores mantidos intactos)!'
  );
END;
$$;

-- Proteger assembleia_checkin_morador e assembleia_sincronizar_unidades_milano para admin apenas
CREATE OR REPLACE FUNCTION public.assembleia_sincronizar_unidades_milano()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_com_cpf integer := 0;
  v_vagas integer := 0;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem sincronizar a base de unidades.');
  END IF;

  IF to_regclass('public.unidades_milano') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Tabela public.unidades_milano não encontrada.');
  END IF;

  INSERT INTO public.assembleia_unidades (
    bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora, observacao
  )
  SELECT
    um.bloco,
    um.apartamento,
    public.assembleia_calcular_fase(um.bloco),
    public.assembleia_calcular_modulo(um.bloco),
    CASE WHEN COALESCE(TRIM(um.nome_cliente), '') <> '' THEN TRIM(um.nome_cliente) ELSE 'UNIDADE VAGA / SEM CADASTRO NA CONSTRUTORA' END,
    CASE WHEN regexp_replace(COALESCE(um.cpf, ''), '\D', '', 'g') <> '' THEN regexp_replace(um.cpf, '\D', '', 'g') ELSE 'SEM_CADASTRO' END,
    false,
    false,
    CASE WHEN COALESCE(TRIM(um.cpf), '') = '' THEN COALESCE(um.observacoes, 'UNIDADE VAGA / SEM CADASTRO NA CONSTRUTORA') ELSE NULL END
  FROM public.unidades_milano um
  ON CONFLICT (bloco, apartamento) DO UPDATE
    SET nome_completo = CASE
          WHEN COALESCE(TRIM(EXCLUDED.nome_completo), '') <> '' AND EXCLUDED.cpf <> 'SEM_CADASTRO'
            THEN EXCLUDED.nome_completo
          ELSE public.assembleia_unidades.nome_completo
        END,
        cpf = CASE
          WHEN EXCLUDED.cpf <> 'SEM_CADASTRO' THEN EXCLUDED.cpf
          ELSE public.assembleia_unidades.cpf
        END,
        updated_at = now();

  SELECT COUNT(*)::integer, COUNT(*) FILTER (WHERE cpf ~ '^\d{11}$')::integer, COUNT(*) FILTER (WHERE cpf !~ '^\d{11}$')::integer
  INTO v_total, v_com_cpf, v_vagas
  FROM public.assembleia_unidades;

  RETURN jsonb_build_object(
    'ok', true,
    'total_unidades', v_total,
    'com_cpf', v_com_cpf,
    'vagas', v_vagas,
    'message', format('%s unidades sincronizadas (%s com CPF e %s vagas)!', v_total, v_com_cpf, v_vagas)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_checkin_morador(
  p_bloco smallint,
  p_apartamento smallint,
  p_nome_completo text,
  p_cpf text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf_limpo text := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  v_nome_limpo text := regexp_replace(TRIM(COALESCE(p_nome_completo, '')), '\s+', ' ', 'g');
  v_asm public.assembleias%ROWTYPE;
  v_fase smallint := public.assembleia_calcular_fase(p_bloco);
  v_modulo smallint := public.assembleia_calcular_modulo(p_bloco);
  v_novo public.assembleia_presencas%ROWTYPE;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem realizar credenciamento manual pela Mesa.');
  END IF;

  SELECT * INTO v_asm FROM public.assembleias WHERE status = 'ativa' LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SEM_ASSEMBLEIA_ATIVA', 'message', 'Nenhuma assembleia ativa no momento.');
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_fase, v_modulo, v_asm.escopo_assembleia) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORA_DO_ESCOPO_ASSEMBLEIA', 'message', 'Bloco fora do escopo convocado.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.assembleia_inadimplentes
    WHERE assembleia_id = v_asm.id AND bloco = p_bloco AND apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNIDADE_PENDENTE_MESA', 'message', 'Unidade consta como inadimplente.');
  END IF;

  INSERT INTO public.assembleia_unidades (bloco, apartamento, fase, modulo, nome_completo, cpf, is_inadimplente, is_construtora)
  VALUES (p_bloco, p_apartamento, v_fase, v_modulo, v_nome_limpo, v_cpf_limpo, false, false)
  ON CONFLICT (bloco, apartamento) DO UPDATE
    SET nome_completo = EXCLUDED.nome_completo, cpf = EXCLUDED.cpf, is_construtora = false;

  INSERT INTO public.assembleia_presencas (
    assembleia_id, bloco, apartamento, fase, modulo, nome_completo, cpf,
    is_construtora, confirmado_portaria, online_conectado
  )
  VALUES (
    v_asm.id, p_bloco, p_apartamento, v_fase, v_modulo, v_nome_limpo, v_cpf_limpo,
    false, true, false
  )
  ON CONFLICT (assembleia_id, bloco, apartamento) DO UPDATE
    SET nome_completo = EXCLUDED.nome_completo,
        cpf = EXCLUDED.cpf,
        confirmado_portaria = true
  RETURNING * INTO v_novo;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'CHECKIN_REALIZADO',
    'message', 'Presença confirmada manualmente pela Mesa!',
    'presenca', to_jsonb(v_novo)
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. REVOGAÇÃO DE PRIVILÉGIOS ABERTOS E APLICAÇÃO DO RLS RIGOROSO POR PAPEL
-- ----------------------------------------------------------------------------

-- 4.1 Remove privilégios diretos da role anon sobre TODAS as tabelas assembleia*
REVOKE ALL ON TABLE
  public.assembleias,
  public.assembleia_config,
  public.assembleia_unidades,
  public.assembleia_inadimplentes,
  public.assembleia_presencas,
  public.assembleia_pautas,
  public.assembleia_votos,
  public.assembleia_historico
FROM anon;

-- Garante privilégios mínimos em authenticated (filtrados rigorosamente pelo RLS abaixo)
REVOKE ALL ON TABLE
  public.assembleias,
  public.assembleia_config,
  public.assembleia_unidades,
  public.assembleia_inadimplentes,
  public.assembleia_presencas,
  public.assembleia_pautas,
  public.assembleia_votos,
  public.assembleia_historico
FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.assembleias,
  public.assembleia_config,
  public.assembleia_unidades,
  public.assembleia_inadimplentes,
  public.assembleia_presencas,
  public.assembleia_pautas,
  public.assembleia_votos,
  public.assembleia_historico
TO authenticated, service_role;

-- 4.2 Revoga EXECUTE aberto nas RPCs legadas sensíveis e aplica grants mínimos
REVOKE ALL ON FUNCTION public.assembleia_consultar_cpf(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assembleia_confirmar_checkin_cpf(text, smallint, smallint, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assembleia_checkin_morador(smallint, smallint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_abrir_pauta(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_resetar_pauta(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_resetar_geral(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_sincronizar_unidades_milano() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_confirmar_portaria(smallint, smallint, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_confirmar_portaria(smallint, smallint, boolean, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_cancelar_entrada_portaria(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_criar_nova(text, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_recalcular_totais_inadimplentes(uuid) FROM PUBLIC, anon, authenticated;

-- Remove sobrecarga legada de 4 parâmetros de assembleia_confirmar_portaria para evitar ambiguidade
DROP FUNCTION IF EXISTS public.assembleia_confirmar_portaria(smallint, smallint, boolean, text);

-- Grants explícitos mínimos:
GRANT EXECUTE ON FUNCTION public.assembleia_estado_publico(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_telao_snapshot(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_confirmar_portaria(smallint, smallint, boolean, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_cancelar_entrada_portaria(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_abrir_pauta(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_resetar_pauta(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_resetar_geral(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_criar_nova(text, text, text, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_sincronizar_unidades_milano() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_checkin_morador(smallint, smallint, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_consultar_cpf(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_confirmar_checkin_cpf(text, smallint, smallint, text, text, text, text) TO service_role;

-- 4.3 Drop de TODAS as policies abertas legadas
DROP POLICY IF EXISTS "assembleias_select_authenticated" ON public.assembleias;
DROP POLICY IF EXISTS "assembleia_config_all" ON public.assembleia_config;
DROP POLICY IF EXISTS "assembleia_unidades_all" ON public.assembleia_unidades;
DROP POLICY IF EXISTS "assembleia_inadimplentes_all" ON public.assembleia_inadimplentes;
DROP POLICY IF EXISTS "assembleia_presencas_all" ON public.assembleia_presencas;
DROP POLICY IF EXISTS "assembleia_pautas_all" ON public.assembleia_pautas;
DROP POLICY IF EXISTS "assembleia_votos_all" ON public.assembleia_votos;
DROP POLICY IF EXISTS "assembleia_historico_all" ON public.assembleia_historico;

-- Garante RLS ativo em todas as 8 tabelas
ALTER TABLE public.assembleias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_unidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_inadimplentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_presencas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_pautas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_votos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_historico ENABLE ROW LEVEL SECURITY;

-- 4.4 Novas Policies RLS Rigorosas (Zero acesso para anon; zero acesso para authenticated sem app_role!)

-- public.assembleias
DROP POLICY IF EXISTS "assembleias_select_staff" ON public.assembleias;
CREATE POLICY "assembleias_select_staff" ON public.assembleias
  FOR SELECT TO authenticated
  USING (public.assembleia_is_portaria_or_admin());

DROP POLICY IF EXISTS "assembleias_write_admin" ON public.assembleias;
CREATE POLICY "assembleias_write_admin" ON public.assembleias
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_config (legado sincronizado)
DROP POLICY IF EXISTS "assembleia_config_select_staff" ON public.assembleia_config;
CREATE POLICY "assembleia_config_select_staff" ON public.assembleia_config
  FOR SELECT TO authenticated
  USING (public.assembleia_is_portaria_or_admin());

DROP POLICY IF EXISTS "assembleia_config_write_admin" ON public.assembleia_config;
CREATE POLICY "assembleia_config_write_admin" ON public.assembleia_config
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_unidades (PII: Nome + CPF — apenas portaria e admin)
DROP POLICY IF EXISTS "assembleia_unidades_select_staff" ON public.assembleia_unidades;
CREATE POLICY "assembleia_unidades_select_staff" ON public.assembleia_unidades
  FOR SELECT TO authenticated
  USING (public.assembleia_is_portaria_or_admin());

DROP POLICY IF EXISTS "assembleia_unidades_write_admin" ON public.assembleia_unidades;
CREATE POLICY "assembleia_unidades_write_admin" ON public.assembleia_unidades
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_inadimplentes (Sigilo LGPD — apenas portaria lê status e admin gerencia)
DROP POLICY IF EXISTS "assembleia_inadimplentes_select_staff" ON public.assembleia_inadimplentes;
CREATE POLICY "assembleia_inadimplentes_select_staff" ON public.assembleia_inadimplentes
  FOR SELECT TO authenticated
  USING (public.assembleia_is_portaria_or_admin());

DROP POLICY IF EXISTS "assembleia_inadimplentes_write_admin" ON public.assembleia_inadimplentes;
CREATE POLICY "assembleia_inadimplentes_write_admin" ON public.assembleia_inadimplentes
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_presencas (PII + Telemetria — staff lê tudo; morador lê APENAS as unidades do seu JWT)
DROP POLICY IF EXISTS "assembleia_presencas_select_authorized" ON public.assembleia_presencas;
CREATE POLICY "assembleia_presencas_select_authorized" ON public.assembleia_presencas
  FOR SELECT TO authenticated
  USING (
    public.assembleia_is_portaria_or_admin()
    OR public.assembleia_jwt_autoriza_unidade(assembleia_id, bloco, apartamento)
  );

DROP POLICY IF EXISTS "assembleia_presencas_write_admin" ON public.assembleia_presencas;
CREATE POLICY "assembleia_presencas_write_admin" ON public.assembleia_presencas
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_pautas (admin direto; públicos via RPC sanitizada)
DROP POLICY IF EXISTS "assembleia_pautas_all_admin" ON public.assembleia_pautas;
CREATE POLICY "assembleia_pautas_all_admin" ON public.assembleia_pautas
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_votos (admin lê/edita; morador lê APENAS seus próprios votos e vota via RPC assembleia_registrar_voto)
DROP POLICY IF EXISTS "assembleia_votos_select_authorized" ON public.assembleia_votos;
CREATE POLICY "assembleia_votos_select_authorized" ON public.assembleia_votos
  FOR SELECT TO authenticated
  USING (
    public.assembleia_is_admin()
    OR public.assembleia_jwt_autoriza_unidade(assembleia_id, bloco, apartamento)
  );

DROP POLICY IF EXISTS "assembleia_votos_write_admin" ON public.assembleia_votos;
CREATE POLICY "assembleia_votos_write_admin" ON public.assembleia_votos
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- public.assembleia_historico (exclusivo admin)
DROP POLICY IF EXISTS "assembleia_historico_all_admin" ON public.assembleia_historico;
CREATE POLICY "assembleia_historico_all_admin" ON public.assembleia_historico
  FOR ALL TO authenticated
  USING (public.assembleia_is_admin())
  WITH CHECK (public.assembleia_is_admin());

-- ----------------------------------------------------------------------------
-- 5. REMOÇÃO DAS 4 TABELAS assembleia_* DA PUBLICATION supabase_realtime (ZERO VAZAMENTO PII!)
-- Preserva intactas as tabelas de outros apps: unidades_milano, campanha_convite_wa, participantes_grupo_wa
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'assembleia_config',
    'assembleia_presencas',
    'assembleia_pautas',
    'assembleia_votos'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_tbl);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
