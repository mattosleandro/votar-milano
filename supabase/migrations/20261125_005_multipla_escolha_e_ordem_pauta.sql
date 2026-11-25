-- ============================================================================
-- MIGRATION 005 — ORDEM DE PAUTA POR ASSEMBLEIA + VOTAÇÃO MÚLTIPLA ESCOLHA
-- (Escolha Única e Múltiplas Escolhas Configuráveis)
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NÃO-DESTRUTIVA sobre os dados históricos de 19/11/2026 (732 votos)
--        e sobre a assembleia ativa atual.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. ORDEM DE PAUTAS REINICIANDO EM 1 POR ASSEMBLEIA
-- ----------------------------------------------------------------------------

-- Remove identity global para permitir numeração independente por assembleia_id
ALTER TABLE public.assembleia_pautas
  ALTER COLUMN ordem DROP IDENTITY IF EXISTS;

ALTER TABLE public.assembleia_pautas
  ALTER COLUMN ordem DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.trg_fn_ordem_pauta_por_assembleia()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_proxima integer;
BEGIN
  IF NEW.assembleia_id IS NULL THEN
    NEW.assembleia_id := public.assembleia_atual_id();
  END IF;

  IF NEW.ordem IS NULL OR NEW.ordem <= 0 THEN
    -- Lock transacional leve por assembleia evita duplicação sob inserção concorrente
    PERFORM pg_advisory_xact_lock(hashtext('assembleia_pauta_ordem_' || NEW.assembleia_id::text));

    SELECT COALESCE(MAX(ordem), 0) + 1
    INTO v_proxima
    FROM public.assembleia_pautas
    WHERE assembleia_id = NEW.assembleia_id;

    NEW.ordem := v_proxima;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ordem_pauta_por_assembleia ON public.assembleia_pautas;
CREATE TRIGGER trg_ordem_pauta_por_assembleia
  BEFORE INSERT ON public.assembleia_pautas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_ordem_pauta_por_assembleia();

-- Corrige ordem deslocada (ex.: 13 -> 1) APENAS em assembleias ativas/rascunho,
-- preservando 100% intocada a numeração de assembleias encerradas (19/11/2026).
WITH pautas_ativas_renumeradas AS (
  SELECT
    p.id,
    ROW_NUMBER() OVER (
      PARTITION BY p.assembleia_id
      ORDER BY p.ordem ASC, p.created_at ASC, p.id ASC
    )::integer AS nova_ordem
  FROM public.assembleia_pautas p
  JOIN public.assembleias a ON a.id = p.assembleia_id
  WHERE a.status <> 'encerrada'
)
UPDATE public.assembleia_pautas p
SET ordem = r.nova_ordem
FROM pautas_ativas_renumeradas r
WHERE p.id = r.id
  AND p.ordem <> r.nova_ordem;

-- ----------------------------------------------------------------------------
-- 2. COLUNAS DE MÚLTIPLA ESCOLHA EM PAUTAS, VOTOS E AUDITORIA (RETROCOMPATÍVEL)
-- ----------------------------------------------------------------------------

-- 2.1 assembleia_pautas
ALTER TABLE public.assembleia_pautas
  ADD COLUMN IF NOT EXISTS tipo_votacao text NOT NULL DEFAULT 'SIM_NAO',
  ADD COLUMN IF NOT EXISTS opcoes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS max_escolhas smallint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assembleia_pautas_tipo_votacao_check'
      AND conrelid = 'public.assembleia_pautas'::regclass
  ) THEN
    ALTER TABLE public.assembleia_pautas
      ADD CONSTRAINT assembleia_pautas_tipo_votacao_check
      CHECK (tipo_votacao IN ('SIM_NAO', 'MULTIPLA_UNICA', 'MULTIPLA_VARIAS'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assembleia_pautas_max_escolhas_check'
      AND conrelid = 'public.assembleia_pautas'::regclass
  ) THEN
    ALTER TABLE public.assembleia_pautas
      ADD CONSTRAINT assembleia_pautas_max_escolhas_check
      CHECK (max_escolhas >= 1 AND max_escolhas <= 10);
  END IF;
END;
$$;

-- 2.2 assembleia_votos: adiciona escolhas_json e libera voto = 'MULTIPLA'
ALTER TABLE public.assembleia_votos
  ADD COLUMN IF NOT EXISTS escolhas_json jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.assembleia_votos
  DROP CONSTRAINT IF EXISTS assembleia_votos_voto_check;

ALTER TABLE public.assembleia_votos
  ADD CONSTRAINT assembleia_votos_voto_check
  CHECK (voto IN ('SIM', 'NAO', 'ABSTENCAO', 'MULTIPLA'));

-- 2.3 assembleia_votos_auditoria: colunas JSON de escolhas para trilha completa
ALTER TABLE public.assembleia_votos_auditoria
  ADD COLUMN IF NOT EXISTS escolhas_anterior jsonb,
  ADD COLUMN IF NOT EXISTS escolhas_novo jsonb;

-- ----------------------------------------------------------------------------
-- 3. FUNÇÃO AUXILIAR DE VALIDAÇÃO E NORMALIZAÇÃO DE ESCOLHAS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembleia_normalizar_escolhas_pauta(
  p_opcoes_json jsonb,
  p_escolhas_json jsonb,
  p_tipo_votacao text,
  p_max_escolhas smallint
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_valid_ids text[];
  v_escolhidos text[];
  v_max_permitido integer;
BEGIN
  IF p_opcoes_json IS NULL OR jsonb_typeof(p_opcoes_json) <> 'array' OR jsonb_array_length(p_opcoes_json) < 2 THEN
    RAISE EXCEPTION 'PAUTA_OPCOES_INVALIDAS: Esta pauta de múltipla escolha não possui opções válidas configuradas.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_escolhas_json IS NULL OR jsonb_typeof(p_escolhas_json) <> 'array' THEN
    RAISE EXCEPTION 'ESCOLHAS_INVALIDAS: Selecione ao menos uma opção válida para votar.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(elem ->> 'id' ORDER BY ord), ARRAY[]::text[])
  INTO v_valid_ids
  FROM jsonb_array_elements(p_opcoes_json) WITH ORDINALITY AS t(elem, ord)
  WHERE NULLIF(TRIM(COALESCE(elem ->> 'id', '')), '') IS NOT NULL;

  -- Verifica se há alguma escolha fora das opções cadastradas da pauta
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_escolhas_json) AS e(val)
    WHERE NOT (e.val = ANY(v_valid_ids))
  ) THEN
    RAISE EXCEPTION 'OPCAO_INVALIDA: Uma ou mais opções selecionadas não pertencem a esta pauta.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Deduplica preservando a ordem oficial das opções da pauta
  SELECT COALESCE(array_agg(v ORDER BY array_position(v_valid_ids, v)), ARRAY[]::text[])
  INTO v_escolhidos
  FROM (
    SELECT DISTINCT e.val AS v
    FROM jsonb_array_elements_text(p_escolhas_json) AS e(val)
    WHERE e.val = ANY(v_valid_ids)
  ) sub;

  IF COALESCE(array_length(v_escolhidos, 1), 0) < 1 THEN
    RAISE EXCEPTION 'SELECIONE_OPCAO: Selecione ao menos uma opção para confirmar seu voto.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_tipo_votacao = 'MULTIPLA_UNICA' THEN
    v_max_permitido := 1;
  ELSE
    v_max_permitido := LEAST(GREATEST(COALESCE(p_max_escolhas, array_length(v_valid_ids, 1)), 1), array_length(v_valid_ids, 1));
  END IF;

  IF array_length(v_escolhidos, 1) > v_max_permitido THEN
    RAISE EXCEPTION 'LIMITE_ESCOLHAS_EXCEDIDO: Esta pauta permite selecionar no máximo % opção(ões).', v_max_permitido
      USING ERRCODE = 'P0001';
  END IF;

  RETURN to_jsonb(v_escolhidos);
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. ATUALIZA TRIGGERS DE VALIDAÇÃO E AUDITORIA DE VOTO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fn_before_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pauta_asm_id uuid;
  v_status text;
  v_escopo text;
  v_rodada smallint;
  v_tipo_votacao text;
  v_opcoes_json jsonb;
  v_max_escolhas smallint;
  v_asm_status text;
  v_exigir_portaria boolean;
  v_fase smallint;
  v_modulo smallint;
  v_is_construtora boolean;
  v_confirmado_portaria boolean;
BEGIN
  SELECT assembleia_id, status, escopo, rodada, tipo_votacao, opcoes_json, max_escolhas
  INTO v_pauta_asm_id, v_status, v_escopo, v_rodada, v_tipo_votacao, v_opcoes_json, v_max_escolhas
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

  -- Validação específica por tipo de votação da pauta
  IF COALESCE(v_tipo_votacao, 'SIM_NAO') = 'SIM_NAO' THEN
    IF UPPER(TRIM(COALESCE(NEW.voto, ''))) NOT IN ('SIM', 'NAO') THEN
      RAISE EXCEPTION 'OPCAO_INVALIDA: Esta pauta aceita apenas SIM ou NÃO.'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.voto := UPPER(TRIM(NEW.voto));
    NEW.escolhas_json := jsonb_build_array(NEW.voto);
  ELSE
    NEW.escolhas_json := public.assembleia_normalizar_escolhas_pauta(
      v_opcoes_json,
      NEW.escolhas_json,
      v_tipo_votacao,
      v_max_escolhas
    );
    NEW.voto := 'MULTIPLA';
  END IF;

  NEW.assembleia_id := v_pauta_asm_id;
  NEW.rodada := v_rodada;
  NEW.is_construtora := COALESCE(v_is_construtora, false);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_audit_voto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(NULLIF(public.assembleia_auth_role(), ''), NULLIF(auth.role(), ''), current_user);
  v_sub text := NULLIF(COALESCE(auth.jwt() ->> 'sub', ''), '');
  v_old_label text;
  v_new_label text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new_label := CASE
      WHEN NEW.voto = 'MULTIPLA' THEN COALESCE((SELECT string_agg(val, ', ') FROM jsonb_array_elements_text(NEW.escolhas_json) AS t(val)), 'MULTIPLA')
      ELSE NEW.voto
    END;
    INSERT INTO public.assembleia_votos_auditoria (
      assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
      voto_anterior, voto_novo, escolhas_anterior, escolhas_novo,
      is_construtora, idempotency_key,
      actor_role, actor_sub, ip_address, device_id, device_name
    )
    VALUES (
      NEW.assembleia_id, NEW.pauta_id, NEW.rodada, NEW.bloco, NEW.apartamento, 'INSERT',
      NULL, v_new_label, NULL, NEW.escolhas_json,
      NEW.is_construtora, NEW.idempotency_key,
      v_role, v_sub, NEW.ip_address, NEW.device_id, NEW.device_name
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.voto IS DISTINCT FROM NEW.voto
       OR OLD.escolhas_json IS DISTINCT FROM NEW.escolhas_json
       OR OLD.rodada IS DISTINCT FROM NEW.rodada THEN
      v_old_label := CASE
        WHEN OLD.voto = 'MULTIPLA' THEN COALESCE((SELECT string_agg(val, ', ') FROM jsonb_array_elements_text(OLD.escolhas_json) AS t(val)), 'MULTIPLA')
        ELSE OLD.voto
      END;
      v_new_label := CASE
        WHEN NEW.voto = 'MULTIPLA' THEN COALESCE((SELECT string_agg(val, ', ') FROM jsonb_array_elements_text(NEW.escolhas_json) AS t(val)), 'MULTIPLA')
        ELSE NEW.voto
      END;
      INSERT INTO public.assembleia_votos_auditoria (
        assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
        voto_anterior, voto_novo, escolhas_anterior, escolhas_novo,
        is_construtora, idempotency_key,
        actor_role, actor_sub, ip_address, device_id, device_name
      )
      VALUES (
        NEW.assembleia_id, NEW.pauta_id, NEW.rodada, NEW.bloco, NEW.apartamento, 'UPDATE',
        v_old_label, v_new_label, OLD.escolhas_json, NEW.escolhas_json,
        NEW.is_construtora, NEW.idempotency_key,
        v_role, v_sub, NEW.ip_address, NEW.device_id, NEW.device_name
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_label := CASE
      WHEN OLD.voto = 'MULTIPLA' THEN COALESCE((SELECT string_agg(val, ', ') FROM jsonb_array_elements_text(OLD.escolhas_json) AS t(val)), 'MULTIPLA')
      ELSE OLD.voto
    END;
    INSERT INTO public.assembleia_votos_auditoria (
      assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
      voto_anterior, voto_novo, escolhas_anterior, escolhas_novo,
      is_construtora, idempotency_key,
      actor_role, actor_sub, ip_address, device_id, device_name
    )
    VALUES (
      OLD.assembleia_id, OLD.pauta_id, OLD.rodada, OLD.bloco, OLD.apartamento, 'DELETE',
      v_old_label, NULL, OLD.escolhas_json, NULL,
      OLD.is_construtora, OLD.idempotency_key,
      v_role, v_sub, OLD.ip_address, OLD.device_id, OLD.device_name
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. ATUALIZA RPCs PÚBLICAS, DE VOTO, DE TELÃO E BROADCAST
-- ----------------------------------------------------------------------------

-- 5.1 assembleia_estado_publico: inclui tipo_votacao, opcoes_json, max_escolhas e placar por opção
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
  v_opcoes_contagem jsonb := '[]'::jsonb;
  v_vencedores_ids jsonb := '[]'::jsonb;
  v_max_opcao_votos integer := 0;
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
        'tipo_votacao', p.tipo_votacao,
        'opcoes_json', p.opcoes_json,
        'max_escolhas', p.max_escolhas,
        'status', p.status,
        'rodada', p.rodada,
        'version', p.version,
        'motivo_ultima_rodada', p.motivo_ultima_rodada,
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
    IF COALESCE(v_pauta_foco.tipo_votacao, 'SIM_NAO') = 'SIM_NAO' THEN
      SELECT
        COUNT(*) FILTER (WHERE v.voto = 'SIM')::integer,
        COUNT(*) FILTER (WHERE v.voto = 'NAO')::integer
      INTO v_sim, v_nao
      FROM public.assembleia_votos v
      WHERE v.assembleia_id = v_asm.id
        AND v.pauta_id = v_pauta_foco.id
        AND v.rodada = v_pauta_foco.rodada
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
    ELSE
      -- Múltipla escolha (Única ou Várias): total_votos = unidades votantes distintas
      SELECT COUNT(*)::integer
      INTO v_total_votos
      FROM public.assembleia_votos v
      WHERE v.assembleia_id = v_asm.id
        AND v.pauta_id = v_pauta_foco.id
        AND v.rodada = v_pauta_foco.rodada
        AND v.voto = 'MULTIPLA'
        AND jsonb_array_length(COALESCE(v.escolhas_json, '[]'::jsonb)) > 0
        AND public.assembleia_pertence_escopo(
          public.assembleia_calcular_fase(v.bloco),
          public.assembleia_calcular_modulo(v.bloco),
          v_pauta_foco.escopo
        );

      v_presentes_aptos := GREATEST(COALESCE(v_presentes_escopo, 0), COALESCE(v_total_votos, 0));
      v_nao_votaram := GREATEST(v_presentes_aptos - COALESCE(v_total_votos, 0), 0);

      WITH opcoes AS (
        SELECT
          elem ->> 'id' AS opt_id,
          elem ->> 'label' AS opt_label,
          COALESCE(NULLIF(elem ->> 'sigla', ''), chr(64 + ord::integer)) AS opt_sigla,
          ord
        FROM jsonb_array_elements(COALESCE(v_pauta_foco.opcoes_json, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      ),
      contagens AS (
        SELECT
          e.val AS opt_id,
          COUNT(*)::integer AS qtd
        FROM public.assembleia_votos v
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(v.escolhas_json, '[]'::jsonb)) AS e(val)
        WHERE v.assembleia_id = v_asm.id
          AND v.pauta_id = v_pauta_foco.id
          AND v.rodada = v_pauta_foco.rodada
          AND v.voto = 'MULTIPLA'
          AND public.assembleia_pertence_escopo(
            public.assembleia_calcular_fase(v.bloco),
            public.assembleia_calcular_modulo(v.bloco),
            v_pauta_foco.escopo
          )
        GROUP BY e.val
      ),
      resumo AS (
        SELECT
          o.opt_id,
          o.opt_label,
          o.opt_sigla,
          o.ord,
          COALESCE(c.qtd, 0)::integer AS votos
        FROM opcoes o
        LEFT JOIN contagens c ON c.opt_id = o.opt_id
      )
      SELECT
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', r.opt_id,
              'label', r.opt_label,
              'sigla', r.opt_sigla,
              'votos', r.votos
            )
            ORDER BY r.ord
          ),
          '[]'::jsonb
        ),
        COALESCE(MAX(r.votos), 0)::integer
      INTO v_opcoes_contagem, v_max_opcao_votos
      FROM resumo r;

      IF v_max_opcao_votos > 0 THEN
        SELECT COALESCE(jsonb_agg(elem ->> 'id'), '[]'::jsonb)
        INTO v_vencedores_ids
        FROM jsonb_array_elements(v_opcoes_contagem) AS elem
        WHERE (elem ->> 'votos')::integer = v_max_opcao_votos;

        IF jsonb_array_length(v_vencedores_ids) > 1 THEN
          v_vencedor := 'EMPATE';
        ELSE
          v_vencedor := 'MULTIPLA';
        END IF;
      ELSE
        v_vencedor := 'SEM_VOTOS';
      END IF;
    END IF;

    v_placar := jsonb_build_object(
      'pauta_id', v_pauta_foco.id,
      'rodada', v_pauta_foco.rodada,
      'escopo', v_pauta_foco.escopo,
      'tipo_votacao', v_pauta_foco.tipo_votacao,
      'presentes_aptos', v_presentes_aptos,
      'sim', COALESCE(v_sim, 0),
      'nao', COALESCE(v_nao, 0),
      'nao_votaram', v_nao_votaram,
      'total_votos', COALESCE(v_total_votos, 0),
      'vencedor', v_vencedor,
      'opcoes_contagem', v_opcoes_contagem,
      'vencedores_ids', v_vencedores_ids
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
      'tipo_votacao', v_pauta_aberta.tipo_votacao,
      'opcoes_json', v_pauta_aberta.opcoes_json,
      'max_escolhas', v_pauta_aberta.max_escolhas,
      'status', v_pauta_aberta.status,
      'rodada', v_pauta_aberta.rodada,
      'version', v_pauta_aberta.version,
      'motivo_ultima_rodada', v_pauta_aberta.motivo_ultima_rodada,
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
      'tipo_votacao', v_ultima_encerrada.tipo_votacao,
      'opcoes_json', v_ultima_encerrada.opcoes_json,
      'max_escolhas', v_ultima_encerrada.max_escolhas,
      'status', v_ultima_encerrada.status,
      'rodada', v_ultima_encerrada.rodada,
      'version', v_ultima_encerrada.version,
      'motivo_ultima_rodada', v_ultima_encerrada.motivo_ultima_rodada,
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

-- 5.2 assembleia_telao_snapshot: inclui escolhas sanitizadas por unidade no grid
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
  v_pauta_foco_rodada smallint;
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
  v_pauta_foco_rodada := COALESCE(
    NULLIF(v_estado -> 'pauta_aberta' ->> 'rodada', '')::smallint,
    NULLIF(v_estado -> 'ultima_pauta_encerrada' ->> 'rodada', '')::smallint,
    1
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
        'voto', v.voto,
        'escolhas', COALESCE(v.escolhas_json, '[]'::jsonb)
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
   AND v.rodada = v_pauta_foco_rodada
   AND v.bloco = pr.bloco
   AND v.apartamento = pr.apartamento
  WHERE pr.assembleia_id = v_asm_id;

  RETURN v_estado || jsonb_build_object('unidades_grid', v_unidades_grid);
END;
$$;

-- 5.3 Broadcast delta de voto inclui escolhas (Zero PII)
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
        'escolhas', COALESCE(NEW.escolhas_json, '[]'::jsonb),
        'const', NEW.is_construtora
      )
    );
  END IF;

  PERFORM public.assembleia_publicar_placar(v_asm_id, false);
  RETURN NULL;
END;
$$;

-- 5.4 assembleia_registrar_voto: suporta SIM_NAO e MULTIPLA_UNICA / MULTIPLA_VARIAS
DROP FUNCTION IF EXISTS public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.assembleia_registrar_voto(
  p_pauta_id uuid,
  p_bloco smallint,
  p_apartamento smallint,
  p_voto text DEFAULT NULL,
  p_ip_address text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_device_name text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_escolhas jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_voto_limpo text := UPPER(TRIM(COALESCE(p_voto, '')));
  v_escolhas_norm jsonb := '[]'::jsonb;
  v_idem text := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_existente public.assembleia_votos%ROWTYPE;
  v_registro public.assembleia_votos%ROWTYPE;
BEGIN
  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAUTA_INEXISTENTE', 'message', 'Pauta não encontrada.');
  END IF;

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

  IF COALESCE(v_pauta.tipo_votacao, 'SIM_NAO') = 'SIM_NAO' THEN
    IF v_voto_limpo NOT IN ('SIM', 'NAO') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'OPCAO_INVALIDA',
        'message', 'Opção de voto inválida. Escolha SIM ou NÃO.'
      );
    END IF;
    v_escolhas_norm := jsonb_build_array(v_voto_limpo);
  ELSE
    v_escolhas_norm := public.assembleia_normalizar_escolhas_pauta(
      v_pauta.opcoes_json,
      p_escolhas,
      v_pauta.tipo_votacao,
      v_pauta.max_escolhas
    );
    v_voto_limpo := 'MULTIPLA';
  END IF;

  -- Idempotência
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_existente
    FROM public.assembleia_votos
    WHERE idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'IDEMPOTENTE_JA_PROCESSADO',
        'ja_igual', true,
        'id', v_existente.id,
        'rodada', v_existente.rodada,
        'voto', v_existente.voto,
        'escolhas_json', v_existente.escolhas_json,
        'pauta_id', v_existente.pauta_id,
        'bloco', v_existente.bloco,
        'apartamento', v_existente.apartamento,
        'updated_at', v_existente.updated_at
      );
    END IF;
  END IF;

  -- Verifica se já existe voto idêntico nesta mesma rodada
  SELECT * INTO v_existente
  FROM public.assembleia_votos
  WHERE pauta_id = p_pauta_id
    AND rodada = v_pauta.rodada
    AND bloco = p_bloco
    AND apartamento = p_apartamento;

  IF FOUND
     AND v_existente.voto = v_voto_limpo
     AND COALESCE(v_existente.escolhas_json, '[]'::jsonb) = v_escolhas_norm THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'VOTO_JA_REGISTRADO',
      'ja_igual', true,
      'id', v_existente.id,
      'rodada', v_existente.rodada,
      'voto', v_existente.voto,
      'escolhas_json', v_existente.escolhas_json,
      'pauta_id', v_existente.pauta_id,
      'bloco', v_existente.bloco,
      'apartamento', v_existente.apartamento,
      'updated_at', v_existente.updated_at
    );
  END IF;

  INSERT INTO public.assembleia_votos (
    assembleia_id,
    pauta_id,
    rodada,
    bloco,
    apartamento,
    voto,
    escolhas_json,
    idempotency_key,
    ip_address,
    device_id,
    device_name
  )
  VALUES (
    v_pauta.assembleia_id,
    p_pauta_id,
    v_pauta.rodada,
    p_bloco,
    p_apartamento,
    v_voto_limpo,
    v_escolhas_norm,
    v_idem,
    NULLIF(TRIM(COALESCE(p_ip_address, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_id, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_name, '')), '')
  )
  ON CONFLICT (pauta_id, rodada, bloco, apartamento) DO UPDATE
    SET voto = EXCLUDED.voto,
        escolhas_json = EXCLUDED.escolhas_json,
        idempotency_key = COALESCE(EXCLUDED.idempotency_key, public.assembleia_votos.idempotency_key),
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
    'rodada', v_registro.rodada,
    'voto', v_registro.voto,
    'escolhas_json', v_registro.escolhas_json,
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

GRANT EXECUTE ON FUNCTION public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text, text, jsonb) TO authenticated, service_role;

-- 5.5 assembleia_encerrar_pauta: resumo compatível com SIM_NAO e Múltipla Escolha
CREATE OR REPLACE FUNCTION public.assembleia_encerrar_pauta(
  p_pauta_id uuid,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_sim integer := 0;
  v_nao integer := 0;
  v_total_multipla integer := 0;
  v_snap jsonb;
  v_msg text;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem encerrar pautas.');
  END IF;

  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Pauta não encontrada.');
  END IF;

  IF p_expected_version IS NOT NULL AND v_pauta.version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CONFLITO_VERSAO',
      'message', 'Outro administrador alterou esta pauta simultaneamente. Atualize e tente novamente.'
    );
  END IF;

  UPDATE public.assembleia_pautas
  SET status = 'encerrada',
      closed_at = now(),
      version = version + 1
  WHERE id = p_pauta_id;

  UPDATE public.assembleias
  SET timer_running = false
  WHERE id = v_pauta.assembleia_id;

  SELECT
    COUNT(*) FILTER (WHERE voto = 'SIM')::integer,
    COUNT(*) FILTER (WHERE voto = 'NAO')::integer,
    COUNT(*) FILTER (WHERE voto = 'MULTIPLA')::integer
  INTO v_sim, v_nao, v_total_multipla
  FROM public.assembleia_votos
  WHERE pauta_id = p_pauta_id AND rodada = v_pauta.rodada;

  v_snap := public.assembleia_gerar_snapshot(v_pauta.assembleia_id, 'pauta_encerrada', NULL);

  PERFORM public.assembleia_log_operacao(
    v_pauta.assembleia_id,
    p_pauta_id,
    'ENCERRAR_PAUTA',
    NULL,
    jsonb_build_object(
      'ordem', v_pauta.ordem,
      'titulo', v_pauta.titulo,
      'tipo_votacao', v_pauta.tipo_votacao,
      'rodada', v_pauta.rodada,
      'sim', COALESCE(v_sim, 0),
      'nao', COALESCE(v_nao, 0),
      'votos_multipla', COALESCE(v_total_multipla, 0),
      'snapshot_sha256', v_snap ->> 'sha256_hash'
    )
  );

  IF COALESCE(v_pauta.tipo_votacao, 'SIM_NAO') = 'SIM_NAO' THEN
    v_msg := format(
      'Pauta #%s (Rodada %s) encerrada! Votos congelados (SIM: %s × NÃO: %s).',
      v_pauta.ordem, v_pauta.rodada, COALESCE(v_sim, 0), COALESCE(v_nao, 0)
    );
  ELSE
    v_msg := format(
      'Pauta #%s (Rodada %s — Múltipla Escolha) encerrada! %s unidade(s) votaram.',
      v_pauta.ordem, v_pauta.rodada, COALESCE(v_total_multipla, 0)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'message', v_msg,
    'sha256_hash', v_snap ->> 'sha256_hash'
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
