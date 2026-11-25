-- ============================================================================
-- MIGRATION 006 — BUCKET STORAGE PARA IMAGENS DE OPÇÕES DE MÚLTIPLA ESCOLHA
-- + PROPAGAÇÃO DE image_url NO PLACAR PÚBLICO
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NÃO-DESTRUTIVA (não altera buckets nem policies de outros apps).
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, storage, extensions;

-- ----------------------------------------------------------------------------
-- 1. BUCKET PÚBLICO DEDICADO PARA IMAGENS DAS OPÇÕES DE VOTAÇÃO
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'assembleia-opcoes',
  'assembleia-opcoes',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- Policies exclusivas para o bucket assembleia-opcoes (leitura pública; escrita apenas admin)
DROP POLICY IF EXISTS "assembleia_opcoes_select_public" ON storage.objects;
CREATE POLICY "assembleia_opcoes_select_public"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'assembleia-opcoes');

DROP POLICY IF EXISTS "assembleia_opcoes_insert_admin" ON storage.objects;
CREATE POLICY "assembleia_opcoes_insert_admin"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'assembleia-opcoes' AND public.assembleia_is_admin());

DROP POLICY IF EXISTS "assembleia_opcoes_update_admin" ON storage.objects;
CREATE POLICY "assembleia_opcoes_update_admin"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'assembleia-opcoes' AND public.assembleia_is_admin())
  WITH CHECK (bucket_id = 'assembleia-opcoes' AND public.assembleia_is_admin());

DROP POLICY IF EXISTS "assembleia_opcoes_delete_admin" ON storage.objects;
CREATE POLICY "assembleia_opcoes_delete_admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'assembleia-opcoes' AND public.assembleia_is_admin());

-- ----------------------------------------------------------------------------
-- 2. PROPAGA image_url DENTRO DE placar.opcoes_contagem EM assembleia_estado_publico
-- ----------------------------------------------------------------------------
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
          NULLIF(TRIM(COALESCE(elem ->> 'image_url', '')), '') AS opt_image_url,
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
          o.opt_image_url,
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
              'image_url', r.opt_image_url,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
