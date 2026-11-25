-- ============================================================================
-- MIGRATION FASE 0 — V2 MULTI-ASSEMBLEIA & PRESERVAÇÃO HISTÓRICA (19/11/2026)
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NÃO-DESTRUTIVA (zero DROP/TRUNCATE/DELETE em dados reais).
-- Preserva integralmente:
--   - public.unidades_milano (544 linhas) e trigger trg_sync_from_unidades_milano
--   - public.assembleia_unidades (544 linhas)
--   - Assembleia Geral de 19/11/2026 (170 presenças, 12 pautas, 732 votos, 1 histórico)
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. ENTIDADE DE PRIMEIRA CLASSE: public.assembleias
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assembleias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  data_assembleia date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Campo_Grande')::date),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'ativa', 'encerrada')),
  convocacao_ativa text NOT NULL DEFAULT 'AGUARDANDO'
    CHECK (convocacao_ativa IN ('AGUARDANDO', 'PRIMEIRA', 'SEGUNDA', 'ENCERRADA')),
  horario_primeira_convocacao text NOT NULL DEFAULT '19:00',
  horario_segunda_convocacao text NOT NULL DEFAULT '19:30',
  escopo_assembleia text NOT NULL DEFAULT 'TODOS'
    CHECK (escopo_assembleia IN ('TODOS', 'FASE_1', 'FASE_2', 'MODULO_1', 'MODULO_2', 'MODULO_3', 'MODULO_4')),
  descontar_inadimplentes_quorum boolean NOT NULL DEFAULT true,
  exigir_confirmacao_portaria boolean NOT NULL DEFAULT true,
  total_inadimplentes integer NOT NULL DEFAULT 0 CHECK (total_inadimplentes >= 0),
  inadimplentes_por_escopo jsonb NOT NULL DEFAULT '{"TODOS":0,"FASE_1":0,"FASE_2":0,"MODULO_1":0,"MODULO_2":0,"MODULO_3":0,"MODULO_4":0}'::jsonb,
  timer_duration_seconds integer NOT NULL DEFAULT 120 CHECK (timer_duration_seconds >= 10),
  timer_started_at timestamptz,
  timer_running boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- No máximo 1 assembleia com status = 'ativa' por vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_assembleias_unica_ativa
  ON public.assembleias ((true))
  WHERE status = 'ativa';

CREATE INDEX IF NOT EXISTS idx_assembleias_status_data
  ON public.assembleias (status, data_assembleia DESC, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. REGISTRO HISTÓRICO OFICIAL DA ASSEMBLEIA GERAL DE 19/11/2026
-- UUID determinístico para idempotência e rastreabilidade jurídica
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_id_19_11 CONSTANT uuid := 'a0000000-0000-4000-8000-202611190001';
  v_cfg public.assembleia_config%ROWTYPE;
  v_min_pres timestamptz;
  v_max_closed timestamptz;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;
  SELECT MIN(created_at) INTO v_min_pres FROM public.assembleia_presencas;
  SELECT MAX(closed_at) INTO v_max_closed FROM public.assembleia_pautas;

  INSERT INTO public.assembleias (
    id,
    titulo,
    data_assembleia,
    status,
    convocacao_ativa,
    horario_primeira_convocacao,
    horario_segunda_convocacao,
    escopo_assembleia,
    descontar_inadimplentes_quorum,
    exigir_confirmacao_portaria,
    total_inadimplentes,
    inadimplentes_por_escopo,
    timer_duration_seconds,
    timer_started_at,
    timer_running,
    version,
    created_at,
    started_at,
    closed_at,
    updated_at
  )
  VALUES (
    v_id_19_11,
    'Assembleia Geral — 19/11/2026',
    DATE '2026-11-19',
    'encerrada',
    'ENCERRADA',
    COALESCE(v_cfg.horario_primeira_convocacao, '18:00'),
    COALESCE(v_cfg.horario_segunda_convocacao, '18:30'),
    COALESCE(v_cfg.escopo_assembleia, 'TODOS'),
    COALESCE(v_cfg.descontar_inadimplentes_quorum, true),
    COALESCE(v_cfg.exigir_confirmacao_portaria, true),
    COALESCE(v_cfg.total_inadimplentes, 0),
    COALESCE(
      v_cfg.inadimplentes_por_escopo,
      '{"TODOS":0,"FASE_1":0,"FASE_2":0,"MODULO_1":0,"MODULO_2":0,"MODULO_3":0,"MODULO_4":0}'::jsonb
    ),
    COALESCE(v_cfg.timer_duration_seconds, 60),
    NULL,
    false,
    1,
    COALESCE(v_min_pres, TIMESTAMPTZ '2026-11-19 21:55:16+00'),
    COALESCE(v_min_pres, TIMESTAMPTZ '2026-11-19 21:55:16+00'),
    COALESCE(v_cfg.updated_at, v_max_closed, TIMESTAMPTZ '2026-11-21 19:05:07+00'),
    COALESCE(v_cfg.updated_at, now())
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

-- Ponte de compatibilidade na tabela singleton assembleia_config
ALTER TABLE public.assembleia_config
  ADD COLUMN IF NOT EXISTS assembleia_atual_id uuid REFERENCES public.assembleias(id);

UPDATE public.assembleia_config
SET assembleia_atual_id = 'a0000000-0000-4000-8000-202611190001'
WHERE id = 1
  AND assembleia_atual_id IS NULL;

-- Helper para resolver a assembleia ativa (ou a configurada/mais recente)
CREATE OR REPLACE FUNCTION public.assembleia_atual_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT id FROM public.assembleias WHERE status = 'ativa' LIMIT 1),
    (SELECT assembleia_atual_id FROM public.assembleia_config WHERE id = 1),
    (SELECT id FROM public.assembleias ORDER BY created_at DESC LIMIT 1)
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. BACKFILL NÃO-DESTRUTIVO DE assembleia_id NAS TABELAS EXISTENTES
-- ----------------------------------------------------------------------------

-- 3.1 assembleia_presencas (+ cpf_procurador para suporte a múltiplas unidades por procuração na Fase 1)
-- Usa DEFAULT determinístico no ADD COLUMN (instantâneo no PG 17, sem disparar triggers de UPDATE)
ALTER TABLE public.assembleia_presencas
  ADD COLUMN IF NOT EXISTS assembleia_id uuid NOT NULL DEFAULT 'a0000000-0000-4000-8000-202611190001' REFERENCES public.assembleias(id),
  ADD COLUMN IF NOT EXISTS cpf_procurador text;

ALTER TABLE public.assembleia_presencas
  ALTER COLUMN assembleia_id SET DEFAULT public.assembleia_atual_id();

ALTER TABLE public.assembleia_presencas
  DROP CONSTRAINT IF EXISTS uq_assembleia_presencas_unidade;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_assembleia_presencas_assembleia_unidade'
      AND conrelid = 'public.assembleia_presencas'::regclass
  ) THEN
    ALTER TABLE public.assembleia_presencas
      ADD CONSTRAINT uq_assembleia_presencas_assembleia_unidade
      UNIQUE (assembleia_id, bloco, apartamento);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_assembleia_presencas_assembleia_cpf
  ON public.assembleia_presencas (assembleia_id, cpf);

CREATE INDEX IF NOT EXISTS idx_assembleia_presencas_assembleia_cpf_proc
  ON public.assembleia_presencas (assembleia_id, cpf_procurador)
  WHERE cpf_procurador IS NOT NULL;

-- 3.2 assembleia_pautas
ALTER TABLE public.assembleia_pautas
  ADD COLUMN IF NOT EXISTS assembleia_id uuid NOT NULL DEFAULT 'a0000000-0000-4000-8000-202611190001' REFERENCES public.assembleias(id);

ALTER TABLE public.assembleia_pautas
  ALTER COLUMN assembleia_id SET DEFAULT public.assembleia_atual_id();

DROP INDEX IF EXISTS public.idx_assembleia_unica_pauta_aberta;
CREATE UNIQUE INDEX idx_assembleia_unica_pauta_aberta
  ON public.assembleia_pautas (assembleia_id)
  WHERE status = 'aberta';

CREATE INDEX IF NOT EXISTS idx_assembleia_pautas_assembleia_ordem
  ON public.assembleia_pautas (assembleia_id, ordem ASC, created_at ASC);

-- 3.3 assembleia_votos (preserva votos congelados de pautas encerradas sem violar trg_before_voto)
ALTER TABLE public.assembleia_votos
  ADD COLUMN IF NOT EXISTS assembleia_id uuid NOT NULL DEFAULT 'a0000000-0000-4000-8000-202611190001' REFERENCES public.assembleias(id);

ALTER TABLE public.assembleia_votos
  ALTER COLUMN assembleia_id SET DEFAULT public.assembleia_atual_id();

CREATE INDEX IF NOT EXISTS idx_assembleia_votos_assembleia_pauta
  ON public.assembleia_votos (assembleia_id, pauta_id);

-- 3.4 assembleia_inadimplentes
ALTER TABLE public.assembleia_inadimplentes
  ADD COLUMN IF NOT EXISTS assembleia_id uuid NOT NULL DEFAULT 'a0000000-0000-4000-8000-202611190001' REFERENCES public.assembleias(id);

ALTER TABLE public.assembleia_inadimplentes
  ALTER COLUMN assembleia_id SET DEFAULT public.assembleia_atual_id();

ALTER TABLE public.assembleia_inadimplentes
  DROP CONSTRAINT IF EXISTS uq_assembleia_inadimplentes_unidade;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_assembleia_inadimplentes_assembleia_unidade'
      AND conrelid = 'public.assembleia_inadimplentes'::regclass
  ) THEN
    ALTER TABLE public.assembleia_inadimplentes
      ADD CONSTRAINT uq_assembleia_inadimplentes_assembleia_unidade
      UNIQUE (assembleia_id, bloco, apartamento);
  END IF;
END;
$$;

-- 3.5 assembleia_historico (+ vínculo assembleia_id + sha256_hash + tipo_snapshot)
ALTER TABLE public.assembleia_historico
  ADD COLUMN IF NOT EXISTS assembleia_id uuid REFERENCES public.assembleias(id),
  ADD COLUMN IF NOT EXISTS sha256_hash text,
  ADD COLUMN IF NOT EXISTS tipo_snapshot text NOT NULL DEFAULT 'final'
    CHECK (tipo_snapshot IN ('periodico', 'pauta_encerrada', 'final', 'manual'));

UPDATE public.assembleia_historico
SET assembleia_id = 'a0000000-0000-4000-8000-202611190001'
WHERE assembleia_id IS NULL;

-- Calcula e grava o SHA-256 criptográfico oficial no registro histórico de 19/11/2026 (se ainda não existir)
UPDATE public.assembleia_historico
SET sha256_hash = encode(digest(convert_to(dados_snapshot::text, 'UTF8'), 'sha256'), 'hex')
WHERE sha256_hash IS NULL;

-- Garante que exista um snapshot oficial da assembleia de 19/11/2026 caso a tabela estivesse vazia
INSERT INTO public.assembleia_historico (
  assembleia_id,
  titulo,
  escopo_assembleia,
  convocacao_ativa,
  total_presentes,
  total_pautas,
  total_votos,
  tipo_snapshot,
  dados_snapshot,
  sha256_hash
)
SELECT
  a.id,
  a.titulo,
  a.escopo_assembleia,
  a.convocacao_ativa,
  (SELECT COUNT(*)::integer FROM public.assembleia_presencas pr WHERE pr.assembleia_id = a.id),
  (SELECT COUNT(*)::integer FROM public.assembleia_pautas pa WHERE pa.assembleia_id = a.id),
  (SELECT COUNT(*)::integer FROM public.assembleia_votos vo WHERE vo.assembleia_id = a.id),
  'final',
  snap.payload,
  encode(digest(convert_to(snap.payload::text, 'UTF8'), 'sha256'), 'hex')
FROM public.assembleias a
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'assembleia', to_jsonb(a),
    'presencas', COALESCE((SELECT jsonb_agg(pr ORDER BY pr.bloco, pr.apartamento) FROM public.assembleia_presencas pr WHERE pr.assembleia_id = a.id), '[]'::jsonb),
    'pautas', COALESCE((SELECT jsonb_agg(pa ORDER BY pa.ordem) FROM public.assembleia_pautas pa WHERE pa.assembleia_id = a.id), '[]'::jsonb),
    'votos', COALESCE((SELECT jsonb_agg(vo ORDER BY vo.pauta_id, vo.bloco, vo.apartamento) FROM public.assembleia_votos vo WHERE vo.assembleia_id = a.id), '[]'::jsonb)
  ) AS payload
) snap
WHERE a.id = 'a0000000-0000-4000-8000-202611190001'
  AND NOT EXISTS (
    SELECT 1 FROM public.assembleia_historico h WHERE h.assembleia_id = a.id
  );

CREATE INDEX IF NOT EXISTS idx_assembleia_historico_assembleia_created
  ON public.assembleia_historico (assembleia_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. SEGURANÇA INICIAL DA NOVA TABELA public.assembleias (Nenhuma escrita anônima)
-- (As políticas definitivas de todas as tabelas serão aplicadas na Fase 1)
-- ----------------------------------------------------------------------------
ALTER TABLE public.assembleias ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.assembleias TO authenticated;
GRANT ALL ON TABLE public.assembleias TO service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_atual_id() TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "assembleias_select_authenticated" ON public.assembleias;
CREATE POLICY "assembleias_select_authenticated"
  ON public.assembleias
  FOR SELECT
  TO authenticated
  USING (true);

NOTIFY pgrst, 'reload schema';

COMMIT;
