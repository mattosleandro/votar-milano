-- ============================================================================
-- ASSEMBLEIA GERAL — MILANO CONDOMÍNIO CLUB (votar.portalmilano.com)
-- Script SQL Completo e Idempotente para Supabase Self-Hosted (PostgreSQL 15+)
-- ============================================================================
-- Tabelas criadas (100% isoladas das tabelas do portal principal):
--   1. public.assembleia_config        (Convocações, quórum e total anônimo de inadimplentes)
--   2. public.assembleia_inadimplentes (Bloqueio de voto gerenciado no /admin; zero exposição pública de bloco/apto)
--   3. public.assembleia_presencas     (Credenciamento único por unidade: moradores e construtora)
--   4. public.assembleia_pautas        (Pautas deliberativas com garantia de apenas 1 aberta por vez)
--   5. public.assembleia_votos         (Voto único por unidade/pauta com congelamento imediato ao encerrar)
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. FUNÇÕES UTILITÁRIAS PURAS DE DOMÍNIO (34 BLOCOS / 544 UNIDADES)
-- ----------------------------------------------------------------------------
-- Fase 1 (Entrega Agora - 16 blocos / 256 unidades):
--   Módulo 1: Blocos 26 a 34 (9 blocos / 144 unidades)
--   Módulo 2: Blocos 19 a 25 (7 blocos / 112 unidades)
-- Fase 2 (Entrega Próximo Ano - 18 blocos / 288 unidades):
--   Módulo 3: Blocos 01 a 04 e 09 a 11 (7 blocos / 112 unidades)
--   Módulo 4: Blocos 05 a 08 e 12 a 18 (11 blocos / 176 unidades)

CREATE OR REPLACE FUNCTION public.assembleia_calcular_fase(p_bloco smallint)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN p_bloco BETWEEN 19 AND 34 THEN 1::smallint
    WHEN p_bloco BETWEEN 1 AND 18 THEN 2::smallint
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_calcular_modulo(p_bloco smallint)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN p_bloco BETWEEN 26 AND 34 THEN 1::smallint
    WHEN p_bloco BETWEEN 19 AND 25 THEN 2::smallint
    WHEN (p_bloco BETWEEN 1 AND 4) OR (p_bloco BETWEEN 9 AND 11) THEN 3::smallint
    WHEN (p_bloco BETWEEN 5 AND 8) OR (p_bloco BETWEEN 12 AND 18) THEN 4::smallint
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_pertence_escopo(
  p_fase smallint,
  p_modulo smallint,
  p_escopo text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE p_escopo
    WHEN 'TODOS' THEN true
    WHEN 'FASE_1' THEN p_fase = 1
    WHEN 'FASE_2' THEN p_fase = 2
    WHEN 'MODULO_1' THEN p_modulo = 1
    WHEN 'MODULO_2' THEN p_modulo = 2
    WHEN 'MODULO_3' THEN p_modulo = 3
    WHEN 'MODULO_4' THEN p_modulo = 4
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.assembleia_total_unidades_escopo(p_escopo text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE p_escopo
    WHEN 'TODOS' THEN 544
    WHEN 'FASE_1' THEN 256
    WHEN 'FASE_2' THEN 288
    WHEN 'MODULO_1' THEN 144
    WHEN 'MODULO_2' THEN 112
    WHEN 'MODULO_3' THEN 112
    WHEN 'MODULO_4' THEN 176
    ELSE 544
  END;
$$;

-- ----------------------------------------------------------------------------
-- 2. TABELAS PRINCIPAIS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.assembleia_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  assembleia_ativa boolean NOT NULL DEFAULT false,
  convocacao_ativa text NOT NULL DEFAULT 'AGUARDANDO'
    CHECK (convocacao_ativa IN ('AGUARDANDO', 'PRIMEIRA', 'SEGUNDA', 'ENCERRADA')),
  horario_primeira_convocacao text NOT NULL DEFAULT '19:00',
  horario_segunda_convocacao text NOT NULL DEFAULT '19:30',
  escopo_assembleia text NOT NULL DEFAULT 'TODOS'
    CHECK (escopo_assembleia IN ('TODOS', 'FASE_1', 'FASE_2', 'MODULO_1', 'MODULO_2', 'MODULO_3', 'MODULO_4')),
  descontar_inadimplentes_quorum boolean NOT NULL DEFAULT true,
  total_inadimplentes integer NOT NULL DEFAULT 0 CHECK (total_inadimplentes >= 0),
  inadimplentes_por_escopo jsonb NOT NULL DEFAULT '{"TODOS":0,"FASE_1":0,"FASE_2":0,"MODULO_1":0,"MODULO_2":0,"MODULO_3":0,"MODULO_4":0}'::jsonb,
  timer_duration_seconds integer NOT NULL DEFAULT 120 CHECK (timer_duration_seconds >= 10),
  timer_started_at timestamptz,
  timer_running boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.assembleia_config
  ADD COLUMN IF NOT EXISTS assembleia_ativa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exigir_confirmacao_portaria boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS timer_duration_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS timer_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS timer_running boolean NOT NULL DEFAULT false;

INSERT INTO public.assembleia_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Cadastro Base Completo de Unidades, Proprietários/Moradores, Construtora e Inadimplentes
CREATE TABLE IF NOT EXISTS public.assembleia_unidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bloco smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34),
  apartamento smallint NOT NULL CHECK (apartamento IN (
    101, 102, 103, 104,
    201, 202, 203, 204,
    301, 302, 303, 304,
    401, 402, 403, 404
  )),
  fase smallint NOT NULL CHECK (fase IN (1, 2)),
  modulo smallint NOT NULL CHECK (modulo IN (1, 2, 3, 4)),
  nome_completo text NOT NULL,
  cpf text NOT NULL,
  is_inadimplente boolean NOT NULL DEFAULT false,
  is_construtora boolean NOT NULL DEFAULT false,
  observacao text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assembleia_unidades_bloco_apto UNIQUE (bloco, apartamento)
);

CREATE INDEX IF NOT EXISTS idx_assembleia_unidades_cpf
  ON public.assembleia_unidades (cpf);

CREATE TABLE IF NOT EXISTS public.assembleia_inadimplentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bloco smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34),
  apartamento smallint NOT NULL CHECK (apartamento IN (
    101, 102, 103, 104,
    201, 202, 203, 204,
    301, 302, 303, 304,
    401, 402, 403, 404
  )),
  fase smallint NOT NULL CHECK (fase IN (1, 2)),
  modulo smallint NOT NULL CHECK (modulo IN (1, 2, 3, 4)),
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assembleia_inadimplentes_unidade UNIQUE (bloco, apartamento)
);

CREATE TABLE IF NOT EXISTS public.assembleia_presencas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bloco smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34),
  apartamento smallint NOT NULL CHECK (apartamento IN (
    101, 102, 103, 104,
    201, 202, 203, 204,
    301, 302, 303, 304,
    401, 402, 403, 404
  )),
  fase smallint NOT NULL CHECK (fase IN (1, 2)),
  modulo smallint NOT NULL CHECK (modulo IN (1, 2, 3, 4)),
  nome_completo text NOT NULL,
  cpf text NOT NULL,
  is_construtora boolean NOT NULL DEFAULT false,
  ip_address text,
  device_id text,
  device_name text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assembleia_presencas_unidade UNIQUE (bloco, apartamento)
);

ALTER TABLE public.assembleia_presencas
  ADD COLUMN IF NOT EXISTS confirmado_portaria boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS online_conectado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS com_procuracao boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS observacao_portaria text,
  ADD COLUMN IF NOT EXISTS conectado_em timestamptz,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS device_name text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE TABLE IF NOT EXISTS public.assembleia_pautas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordem integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  titulo text NOT NULL,
  descricao text,
  escopo text NOT NULL DEFAULT 'TODOS'
    CHECK (escopo IN ('TODOS', 'FASE_1', 'FASE_2', 'MODULO_1', 'MODULO_2', 'MODULO_3', 'MODULO_4')),
  status text NOT NULL DEFAULT 'aguardando'
    CHECK (status IN ('aguardando', 'aberta', 'encerrada')),
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  closed_at timestamptz
);

-- Garantia estrita no banco: no máximo 1 pauta com status = 'aberta' simultaneamente
CREATE UNIQUE INDEX IF NOT EXISTS idx_assembleia_unica_pauta_aberta
  ON public.assembleia_pautas ((true))
  WHERE status = 'aberta';

CREATE INDEX IF NOT EXISTS idx_assembleia_pautas_ordem
  ON public.assembleia_pautas (ordem ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS public.assembleia_votos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pauta_id uuid NOT NULL REFERENCES public.assembleia_pautas(id) ON DELETE CASCADE,
  bloco smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34),
  apartamento smallint NOT NULL CHECK (apartamento IN (
    101, 102, 103, 104,
    201, 202, 203, 204,
    301, 302, 303, 304,
    401, 402, 403, 404
  )),
  voto text NOT NULL CHECK (voto IN ('SIM', 'NAO', 'ABSTENCAO')),
  is_construtora boolean NOT NULL DEFAULT false,
  ip_address text,
  device_id text,
  device_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assembleia_votos_pauta_unidade UNIQUE (pauta_id, bloco, apartamento)
);

ALTER TABLE public.assembleia_votos
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS device_name text;

CREATE INDEX IF NOT EXISTS idx_assembleia_votos_pauta
  ON public.assembleia_votos (pauta_id);

CREATE INDEX IF NOT EXISTS idx_assembleia_presencas_escopo
  ON public.assembleia_presencas (fase, modulo, bloco, apartamento);

-- ----------------------------------------------------------------------------
-- 3. TRIGGERS DE INTEGRIDADE, SIGILO DE INADIMPLENTES E CONGELAMENTO DE VOTOS
-- ----------------------------------------------------------------------------

-- 3.1 Preenche fase e módulo automaticamente em assembleia_inadimplentes
CREATE OR REPLACE FUNCTION public.trg_fn_before_inadimplente()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.fase := public.assembleia_calcular_fase(NEW.bloco);
  NEW.modulo := public.assembleia_calcular_modulo(NEW.bloco);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_inadimplente ON public.assembleia_inadimplentes;
CREATE TRIGGER trg_before_inadimplente
  BEFORE INSERT OR UPDATE ON public.assembleia_inadimplentes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_inadimplente();

-- 3.2 Ao marcar uma unidade como inadimplente, revoga presença ativa e voto em pauta aberta
CREATE OR REPLACE FUNCTION public.trg_fn_after_insert_inadimplente_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.assembleia_votos v
  USING public.assembleia_pautas p
  WHERE v.pauta_id = p.id
    AND p.status = 'aberta'
    AND v.bloco = NEW.bloco
    AND v.apartamento = NEW.apartamento;

  DELETE FROM public.assembleia_presencas
  WHERE bloco = NEW.bloco
    AND apartamento = NEW.apartamento;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_insert_inadimplente_row ON public.assembleia_inadimplentes;
CREATE TRIGGER trg_after_insert_inadimplente_row
  AFTER INSERT OR UPDATE ON public.assembleia_inadimplentes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_after_insert_inadimplente_row();

-- 3.3 Sincroniza APENAS contadores agregados anônimos em assembleia_config (Zero vazamento de bloco/apto!)
CREATE OR REPLACE FUNCTION public.assembleia_recalcular_totais_inadimplentes()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_todos integer;
  v_f1 integer;
  v_f2 integer;
  v_m1 integer;
  v_m2 integer;
  v_m3 integer;
  v_m4 integer;
BEGIN
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE fase = 1)::integer,
    COUNT(*) FILTER (WHERE fase = 2)::integer,
    COUNT(*) FILTER (WHERE modulo = 1)::integer,
    COUNT(*) FILTER (WHERE modulo = 2)::integer,
    COUNT(*) FILTER (WHERE modulo = 3)::integer,
    COUNT(*) FILTER (WHERE modulo = 4)::integer
  INTO v_todos, v_f1, v_f2, v_m1, v_m2, v_m3, v_m4
  FROM public.assembleia_inadimplentes;

  UPDATE public.assembleia_config
  SET
    total_inadimplentes = COALESCE(v_todos, 0),
    inadimplentes_por_escopo = jsonb_build_object(
      'TODOS', COALESCE(v_todos, 0),
      'FASE_1', COALESCE(v_f1, 0),
      'FASE_2', COALESCE(v_f2, 0),
      'MODULO_1', COALESCE(v_m1, 0),
      'MODULO_2', COALESCE(v_m2, 0),
      'MODULO_3', COALESCE(v_m3, 0),
      'MODULO_4', COALESCE(v_m4, 0)
    ),
    updated_at = now()
  WHERE id = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_sync_totais_inadimplentes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.assembleia_recalcular_totais_inadimplentes();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_totais_inadimplentes ON public.assembleia_inadimplentes;
CREATE TRIGGER trg_sync_totais_inadimplentes
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_inadimplentes
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_fn_sync_totais_inadimplentes();

-- 3.4 Garante Fase/Módulo automáticos e impede check-in de unidade inadimplente
CREATE OR REPLACE FUNCTION public.trg_fn_before_presenca()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.fase := public.assembleia_calcular_fase(NEW.bloco);
  NEW.modulo := public.assembleia_calcular_modulo(NEW.bloco);
  NEW.cpf := regexp_replace(TRIM(NEW.cpf), '[^0-9A-Za-z_-]', '', 'g');
  NEW.nome_completo := regexp_replace(TRIM(NEW.nome_completo), '\s+', ' ', 'g');

  IF EXISTS (
    SELECT 1
    FROM public.assembleia_inadimplentes i
    WHERE i.bloco = NEW.bloco
      AND i.apartamento = NEW.apartamento
  ) THEN
    RAISE EXCEPTION 'UNIDADE_INADIMPLENTE: Unidade bloqueada para credenciamento e voto.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_presenca ON public.assembleia_presencas;
CREATE TRIGGER trg_before_presenca
  BEFORE INSERT OR UPDATE ON public.assembleia_presencas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_presenca();

-- 3.5 Valida e congela votos (impede voto em pauta fechada, unidade inadimplente, sem check-in ou fora do escopo)
CREATE OR REPLACE FUNCTION public.trg_fn_before_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_escopo text;
  v_fase smallint;
  v_modulo smallint;
  v_is_construtora boolean;
BEGIN
  SELECT status, escopo
  INTO v_status, v_escopo
  FROM public.assembleia_pautas
  WHERE id = NEW.pauta_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'PAUTA_INEXISTENTE: A pauta informada não existe.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_status <> 'aberta' THEN
    RAISE EXCEPTION 'PAUTA_ENCERRADA: A votação desta pauta não está aberta. Os votos estão congelados.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assembleia_inadimplentes i
    WHERE i.bloco = NEW.bloco
      AND i.apartamento = NEW.apartamento
  ) THEN
    RAISE EXCEPTION 'UNIDADE_INADIMPLENTE: Esta unidade não está apta a votar.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT fase, modulo, is_construtora
  INTO v_fase, v_modulo, v_is_construtora
  FROM public.assembleia_presencas
  WHERE bloco = NEW.bloco
    AND apartamento = NEW.apartamento;

  IF v_fase IS NULL THEN
    RAISE EXCEPTION 'UNIDADE_SEM_CHECKIN: A unidade precisa estar credenciada na assembleia para votar.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_fase, v_modulo, v_escopo) THEN
    RAISE EXCEPTION 'FORA_DO_ESCOPO: Esta unidade não pertence ao escopo permitido desta votação (%).', v_escopo
      USING ERRCODE = 'P0001';
  END IF;

  NEW.is_construtora := v_is_construtora;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_voto ON public.assembleia_votos;
CREATE TRIGGER trg_before_voto
  BEFORE INSERT OR UPDATE ON public.assembleia_votos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_voto();

-- Impede exclusão acidental de votos de pautas encerradas (exceto reset oficial da mesa ou exclusão da pauta)
CREATE OR REPLACE FUNCTION public.trg_fn_before_delete_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF COALESCE(current_setting('assembleia.allow_reset', true), '') = 'true'
     OR COALESCE(current_setting('assembleia.bypass_freeze', true), '') = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT status INTO v_status
  FROM public.assembleia_pautas
  WHERE id = OLD.pauta_id;

  -- Se v_status IS NULL, a própria pauta está sendo removida via ON DELETE CASCADE
  IF v_status = 'encerrada' THEN
    RAISE EXCEPTION 'VOTOS_CONGELADOS: Não é permitido excluir votos de uma pauta encerrada sem reset administrativo.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_delete_voto ON public.assembleia_votos;
CREATE TRIGGER trg_before_delete_voto
  BEFORE DELETE ON public.assembleia_votos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_delete_voto();

-- ----------------------------------------------------------------------------
-- 4. RPCs ATÔMICAS E SEGURAS (CHECK-IN / RECUPERAÇÃO CPF, ABERTURA E RESET DE PAUTA)
-- ----------------------------------------------------------------------------

-- 4.1 Check-in atômico de morador ou recuperação segura com mesmo CPF (zero vazamento de CPF/inadimplentes)
CREATE OR REPLACE FUNCTION public.assembleia_checkin_morador(
  p_bloco smallint,
  p_apartamento smallint,
  p_nome_completo text,
  p_cpf text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cpf_limpo text := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  v_nome_limpo text := regexp_replace(TRIM(COALESCE(p_nome_completo, '')), '\s+', ' ', 'g');
  v_cfg public.assembleia_config%ROWTYPE;
  v_fase smallint := public.assembleia_calcular_fase(p_bloco);
  v_modulo smallint := public.assembleia_calcular_modulo(p_bloco);
  v_existente public.assembleia_presencas%ROWTYPE;
  v_novo public.assembleia_presencas%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;

  -- 0. Verifica se a unidade pertence ao Escopo/Quórum ativo da assembleia
  IF FOUND AND NOT public.assembleia_pertence_escopo(v_fase, v_modulo, COALESCE(v_cfg.escopo_assembleia, 'TODOS')) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_ASSEMBLEIA',
      'message', format(
        'O Bloco %s (Fase %s • Módulo %s) não faz parte do escopo desta assembleia (%s).',
        lpad(p_bloco::text, 2, '0'),
        v_fase,
        v_modulo,
        COALESCE(v_cfg.escopo_assembleia, 'TODOS')
      )
    );
  END IF;

  -- 1. Verifica inadimplência de forma privada sem expor lista pública
  IF EXISTS (
    SELECT 1
    FROM public.assembleia_inadimplentes i
    WHERE i.bloco = p_bloco
      AND i.apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_PENDENTE_MESA',
      'message', 'Não foi possível concluir o credenciamento desta unidade pois consta pendência condominial. Libere a unidade na aba Inadimplentes antes de credenciar.'
    );
  END IF;

  -- 2. Verifica se a unidade já possui representante credenciado
  SELECT *
  INTO v_existente
  FROM public.assembleia_presencas
  WHERE bloco = p_bloco
    AND apartamento = p_apartamento;

  IF FOUND THEN
    IF v_existente.is_construtora THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'UNIDADE_CONSTRUTORA',
        'message', 'Esta unidade consta sob representação da Construtora. Caso já tenha recebido as chaves, procure a Mesa Diretora para liberação.'
      );
    END IF;

    IF regexp_replace(v_existente.cpf, '\D', '', 'g') = v_cpf_limpo THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'SESSAO_RECUPERADA',
        'message', 'Sessão recuperada com sucesso!',
        'presenca', jsonb_build_object(
          'id', v_existente.id,
          'bloco', v_existente.bloco,
          'apartamento', v_existente.apartamento,
          'fase', v_existente.fase,
          'modulo', v_existente.modulo,
          'nome_completo', v_existente.nome_completo,
          'is_construtora', v_existente.is_construtora,
          'created_at', v_existente.created_at
        )
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_JA_CREDENCIADA',
      'message', 'Esta unidade já possui outro representante credenciado. Se alguém selecionou seu apartamento por engano, solicite a liberação na Mesa Diretora.'
    );
  END IF;

  -- 3. Sincroniza no cadastro base de unidades (caso ainda não estivesse cadastrada)
  INSERT INTO public.assembleia_unidades (
    bloco,
    apartamento,
    fase,
    modulo,
    nome_completo,
    cpf,
    is_inadimplente,
    is_construtora
  )
  VALUES (
    p_bloco,
    p_apartamento,
    v_fase,
    v_modulo,
    v_nome_limpo,
    v_cpf_limpo,
    false,
    false
  )
  ON CONFLICT (bloco, apartamento) DO UPDATE
    SET nome_completo = EXCLUDED.nome_completo,
        cpf = EXCLUDED.cpf,
        is_construtora = false;

  -- 4. Registra nova presença
  INSERT INTO public.assembleia_presencas (
    bloco,
    apartamento,
    fase,
    modulo,
    nome_completo,
    cpf,
    is_construtora
  )
  VALUES (
    p_bloco,
    p_apartamento,
    v_fase,
    v_modulo,
    v_nome_limpo,
    v_cpf_limpo,
    false
  )
  RETURNING * INTO v_novo;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'CHECKIN_REALIZADO',
    'message', 'Presença confirmada com sucesso!',
    'presenca', jsonb_build_object(
      'id', v_novo.id,
      'bloco', v_novo.bloco,
      'apartamento', v_novo.apartamento,
      'fase', v_novo.fase,
      'modulo', v_novo.modulo,
      'nome_completo', v_novo.nome_completo,
      'is_construtora', v_novo.is_construtora,
      'created_at', v_novo.created_at
    )
  );
END;
$$;

-- 4.2 Abertura transacional de pauta (valida quórum de 1ª convocação e encerra qualquer outra aberta)
CREATE OR REPLACE FUNCTION public.assembleia_abrir_pauta(p_pauta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cfg public.assembleia_config%ROWTYPE;
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_total_fisico integer;
  v_inad_escopo integer;
  v_base_quorum integer;
  v_minimo_primeira integer;
  v_presentes_escopo integer;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;
  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Pauta não encontrada.');
  END IF;

  IF v_cfg.convocacao_ativa IN ('AGUARDANDO', 'ENCERRADA') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'message', 'A assembleia está com status "' || v_cfg.convocacao_ativa || '". Ative a 1ª ou a 2ª Convocação no topo do painel antes de abrir uma pauta.'
    );
  END IF;

  -- Verifica quórum de Maioria Absoluta quando em 1ª Convocação
  IF v_cfg.convocacao_ativa = 'PRIMEIRA' THEN
    v_total_fisico := public.assembleia_total_unidades_escopo(v_pauta.escopo);
    v_inad_escopo := COALESCE((v_cfg.inadimplentes_por_escopo ->> v_pauta.escopo)::integer, 0);

    IF v_cfg.descontar_inadimplentes_quorum THEN
      v_base_quorum := GREATEST(v_total_fisico - v_inad_escopo, 1);
    ELSE
      v_base_quorum := v_total_fisico;
    END IF;

    v_minimo_primeira := (v_base_quorum / 2) + 1;

    SELECT COUNT(*)::integer
    INTO v_presentes_escopo
    FROM public.assembleia_presencas pr
    WHERE public.assembleia_pertence_escopo(pr.fase, pr.modulo, v_pauta.escopo);

    IF v_presentes_escopo < v_minimo_primeira THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'QUORUM_INSUFICIENTE_PRIMEIRA_CONVOCACAO',
        'message', format(
          'Quórum insuficiente para 1ª Convocação (Maioria Absoluta): %s presentes de %s necessários no escopo %s. Aguarde mais presenças ou alterne para a 2ª Convocação.',
          v_presentes_escopo,
          v_minimo_primeira,
          v_pauta.escopo
        )
      );
    END IF;
  END IF;

  -- Encerra automaticamente qualquer outra pauta que estivesse aberta
  UPDATE public.assembleia_pautas
  SET status = 'encerrada',
      closed_at = now()
  WHERE status = 'aberta'
    AND id <> p_pauta_id;

  -- Abre a pauta solicitada
  UPDATE public.assembleia_pautas
  SET status = 'aberta',
      opened_at = COALESCE(opened_at, now()),
      closed_at = NULL
  WHERE id = p_pauta_id;

  -- Inicia/reseta automaticamente o cronômetro regressivo de deliberação no telão
  UPDATE public.assembleia_config
  SET timer_running = true,
      timer_started_at = now(),
      timer_duration_seconds = CASE
        WHEN COALESCE(timer_duration_seconds, 0) <= 0 THEN 120
        ELSE timer_duration_seconds
      END,
      updated_at = now()
  WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'message', 'Votação aberta e cronômetro iniciado com sucesso!');
END;
$$;

-- 4.3 Resetar (limpar votos) e opcionalmente reabrir uma pauta
CREATE OR REPLACE FUNCTION public.assembleia_resetar_pauta(
  p_pauta_id uuid,
  p_reabrir boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_open_res jsonb;
BEGIN
  PERFORM set_config('assembleia.allow_reset', 'true', true);

  DELETE FROM public.assembleia_votos
  WHERE pauta_id = p_pauta_id;

  IF p_reabrir THEN
    v_open_res := public.assembleia_abrir_pauta(p_pauta_id);
    IF NOT COALESCE((v_open_res ->> 'ok')::boolean, false) THEN
      UPDATE public.assembleia_pautas
      SET status = 'aguardando',
          opened_at = NULL,
          closed_at = NULL
      WHERE id = p_pauta_id;
      RETURN v_open_res;
    END IF;
    RETURN jsonb_build_object('ok', true, 'message', 'Votos zerados e pauta reaberta para votação!');
  ELSE
    UPDATE public.assembleia_pautas
    SET status = 'aguardando',
        opened_at = NULL,
        closed_at = NULL
    WHERE id = p_pauta_id;
    RETURN jsonb_build_object('ok', true, 'message', 'Pauta resetada para aguardando e votos zerados.');
  END IF;
END;
$$;

-- 4.4 Triggers de Sincronização do Cadastro Base (assembleia_unidades)
CREATE OR REPLACE FUNCTION public.trg_fn_before_unidade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.fase := public.assembleia_calcular_fase(NEW.bloco);
  NEW.modulo := public.assembleia_calcular_modulo(NEW.bloco);
  NEW.nome_completo := regexp_replace(TRIM(COALESCE(NEW.nome_completo, '')), '\s+', ' ', 'g');
  IF NEW.is_construtora THEN
    NEW.cpf := 'CONSTRUTORA';
    NEW.is_inadimplente := false;
    IF NEW.nome_completo = '' THEN
      NEW.nome_completo := 'CONSTRUTORA MILANO (UNIDADE NÃO ENTREGUE / NÃO VENDIDA)';
    END IF;
  ELSE
    NEW.cpf := regexp_replace(TRIM(COALESCE(NEW.cpf, '')), '\D', '', 'g');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_unidade ON public.assembleia_unidades;
CREATE TRIGGER trg_before_unidade
  BEFORE INSERT OR UPDATE ON public.assembleia_unidades
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_unidade();

CREATE OR REPLACE FUNCTION public.trg_fn_after_unidade_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('assembleia.syncing_unidades', true), '') = 'true' THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'true', true);

  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.assembleia_inadimplentes
    WHERE bloco = OLD.bloco AND apartamento = OLD.apartamento;

    IF OLD.is_construtora THEN
      DELETE FROM public.assembleia_presencas
      WHERE bloco = OLD.bloco AND apartamento = OLD.apartamento AND is_construtora = true;

      DELETE FROM public.assembleia_votos
      WHERE bloco = OLD.bloco
        AND apartamento = OLD.apartamento
        AND pauta_id IN (SELECT id FROM public.assembleia_pautas WHERE status = 'aberta');
    END IF;

    PERFORM set_config('assembleia.syncing_unidades', 'false', true);
    RETURN OLD;
  END IF;

  -- Sincroniza flag is_inadimplente com a tabela assembleia_inadimplentes
  IF NEW.is_inadimplente THEN
    INSERT INTO public.assembleia_inadimplentes (bloco, apartamento, fase, modulo, observacao)
    VALUES (NEW.bloco, NEW.apartamento, NEW.fase, NEW.modulo, NEW.observacao)
    ON CONFLICT (bloco, apartamento) DO UPDATE
      SET observacao = EXCLUDED.observacao;
  ELSE
    DELETE FROM public.assembleia_inadimplentes
    WHERE bloco = NEW.bloco AND apartamento = NEW.apartamento;
  END IF;

  -- Sincroniza unidades da construtora automaticamente com assembleia_presencas
  IF NEW.is_construtora THEN
    INSERT INTO public.assembleia_presencas (
      bloco, apartamento, fase, modulo, nome_completo, cpf, is_construtora, confirmado_portaria, online_conectado
    )
    VALUES (
      NEW.bloco, NEW.apartamento, NEW.fase, NEW.modulo, NEW.nome_completo, 'CONSTRUTORA', true, true, true
    )
    ON CONFLICT (bloco, apartamento) DO UPDATE
      SET nome_completo = EXCLUDED.nome_completo,
          cpf = 'CONSTRUTORA',
          is_construtora = true,
          confirmado_portaria = true,
          online_conectado = true;
  ELSE
    DELETE FROM public.assembleia_presencas
    WHERE bloco = NEW.bloco AND apartamento = NEW.apartamento AND is_construtora = true;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'false', true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_after_unidade_sync ON public.assembleia_unidades;
CREATE TRIGGER trg_after_unidade_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_unidades
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_after_unidade_sync();

-- Mantém assembleia_unidades.is_inadimplente atualizado quando alterado pela grade rápida de inadimplentes
CREATE OR REPLACE FUNCTION public.trg_fn_sync_inadimplente_to_unidade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('assembleia.syncing_unidades', true), '') = 'true' THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'true', true);

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    UPDATE public.assembleia_unidades
    SET is_inadimplente = true,
        observacao = COALESCE(NEW.observacao, observacao),
        updated_at = now()
    WHERE bloco = NEW.bloco AND apartamento = NEW.apartamento;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.assembleia_unidades
    SET is_inadimplente = false,
        updated_at = now()
    WHERE bloco = OLD.bloco AND apartamento = OLD.apartamento;
  END IF;

  PERFORM set_config('assembleia.syncing_unidades', 'false', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_inadimplente_to_unidade ON public.assembleia_inadimplentes;
CREATE TRIGGER trg_sync_inadimplente_to_unidade
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_inadimplentes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_sync_inadimplente_to_unidade();

-- 4.5 Consulta de CPF para Check-in em 2 Passos (Respeita Quórum Ativo, Portaria e Bloqueio de Inadimplente)
CREATE OR REPLACE FUNCTION public.assembleia_consultar_cpf(p_cpf text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cfg public.assembleia_config%ROWTYPE;
  v_cpf_limpo text := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  v_unidades jsonb;
  v_total integer := 0;
  v_inadimplentes integer := 0;
  v_no_escopo integer := 0;
  v_confirmados_portaria integer := 0;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;

  IF NOT COALESCE(v_cfg.assembleia_ativa, false) OR v_cfg.convocacao_ativa = 'ENCERRADA' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SEM_VOTACAO_ATIVA',
      'message', 'Não existe nenhuma votação ativa no momento.'
    );
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE u.is_inadimplente OR EXISTS (
        SELECT 1 FROM public.assembleia_inadimplentes i
        WHERE i.bloco = u.bloco AND i.apartamento = u.apartamento
      )
    )::integer,
    COUNT(*) FILTER (
      WHERE public.assembleia_pertence_escopo(u.fase, u.modulo, v_cfg.escopo_assembleia)
    )::integer,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.assembleia_presencas pr
        WHERE pr.bloco = u.bloco
          AND pr.apartamento = u.apartamento
          AND pr.confirmado_portaria = true
      )
    )::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'bloco', u.bloco,
          'apartamento', u.apartamento,
          'fase', u.fase,
          'modulo', u.modulo,
          'nome_completo', u.nome_completo,
          'is_inadimplente', (
            u.is_inadimplente OR EXISTS (
              SELECT 1 FROM public.assembleia_inadimplentes i
              WHERE i.bloco = u.bloco AND i.apartamento = u.apartamento
            )
          ),
          'is_construtora', u.is_construtora,
          'pertence_escopo', public.assembleia_pertence_escopo(u.fase, u.modulo, v_cfg.escopo_assembleia),
          'confirmado_portaria', EXISTS (
            SELECT 1 FROM public.assembleia_presencas pr
            WHERE pr.bloco = u.bloco
              AND pr.apartamento = u.apartamento
              AND pr.confirmado_portaria = true
          ),
          'online_conectado', EXISTS (
            SELECT 1 FROM public.assembleia_presencas pr
            WHERE pr.bloco = u.bloco
              AND pr.apartamento = u.apartamento
              AND pr.online_conectado = true
          ),
          'ja_credenciado', EXISTS (
            SELECT 1 FROM public.assembleia_presencas pr
            WHERE pr.bloco = u.bloco AND pr.apartamento = u.apartamento
          )
        )
        ORDER BY u.bloco ASC, u.apartamento ASC
      ),
      '[]'::jsonb
    )
  INTO v_total, v_inadimplentes, v_no_escopo, v_confirmados_portaria, v_unidades
  FROM public.assembleia_unidades u
  WHERE regexp_replace(u.cpf, '\D', '', 'g') = v_cpf_limpo
    AND NOT u.is_construtora;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CPF_NAO_CADASTRADO',
      'message', 'CPF não encontrado na base de unidades cadastradas. Por favor, dirija-se à Recepção / Mesa Diretora para conferência e liberação do seu cadastro.'
    );
  END IF;

  IF v_inadimplentes = v_total THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_INADIMPLENTE',
      'message', 'Unidade bloqueada para realizar votação. Para liberar o direito a voto, é necessário efetuar o pagamento dos valores referentes ao condomínio e apresentar o comprovante ao Síndico / Mesa Diretora.',
      'unidades', v_unidades
    );
  END IF;

  IF v_no_escopo = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_QUORUM',
      'message', 'Sua unidade foi localizada, porém não pertence ao quórum/escopo habilitado para esta convocação (' || v_cfg.escopo_assembleia || ').',
      'unidades', v_unidades
    );
  END IF;

  IF COALESCE(v_cfg.exigir_confirmacao_portaria, true) AND v_confirmados_portaria = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'AGUARDANDO_LIBERACAO_PORTARIA',
      'message', 'Sua unidade foi localizada, mas ainda aguarda a confirmação de presença na entrada (Portaria). Apresente seu documento ou procuração à equipe de recepção para liberar a votação.',
      'unidades', v_unidades
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'UNIDADES_LOCALIZADAS',
    'escopo_assembleia', v_cfg.escopo_assembleia,
    'exigir_confirmacao_portaria', COALESCE(v_cfg.exigir_confirmacao_portaria, true),
    'unidades', v_unidades
  );
END;
$$;

-- 4.6 Confirmação de Check-in Online pelo Morador com Telemetria de Dispositivo (IP, Device ID, Modelo)
CREATE OR REPLACE FUNCTION public.assembleia_confirmar_checkin_cpf(
  p_cpf text,
  p_bloco smallint,
  p_apartamento smallint,
  p_ip_address text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_device_name text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cfg public.assembleia_config%ROWTYPE;
  v_cpf_limpo text := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  v_unidade public.assembleia_unidades%ROWTYPE;
  v_presenca public.assembleia_presencas%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;

  IF NOT COALESCE(v_cfg.assembleia_ativa, false) OR v_cfg.convocacao_ativa = 'ENCERRADA' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SEM_VOTACAO_ATIVA',
      'message', 'Não existe nenhuma votação ativa no momento.'
    );
  END IF;

  SELECT *
  INTO v_unidade
  FROM public.assembleia_unidades
  WHERE bloco = p_bloco
    AND apartamento = p_apartamento
    AND regexp_replace(cpf, '\D', '', 'g') = v_cpf_limpo;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_NAO_VINCULADA',
      'message', 'O CPF informado não corresponde ao cadastro desta unidade. Procure a Mesa Diretora.'
    );
  END IF;

  IF v_unidade.is_inadimplente OR EXISTS (
    SELECT 1 FROM public.assembleia_inadimplentes i
    WHERE i.bloco = p_bloco AND i.apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_INADIMPLENTE',
      'message', 'Unidade bloqueada para realizar votação. Para liberar o direito a voto, é necessário efetuar o pagamento dos valores referentes ao condomínio e apresentar o comprovante ao Síndico / Mesa Diretora.'
    );
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_unidade.fase, v_unidade.modulo, v_cfg.escopo_assembleia) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_QUORUM',
      'message', 'Esta unidade não pertence ao quórum/escopo habilitado para check-in no momento (' || v_cfg.escopo_assembleia || ').'
    );
  END IF;

  IF COALESCE(v_cfg.exigir_confirmacao_portaria, true) THEN
    SELECT *
    INTO v_presenca
    FROM public.assembleia_presencas
    WHERE bloco = p_bloco
      AND apartamento = p_apartamento
      AND confirmado_portaria = true;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'AGUARDANDO_LIBERACAO_PORTARIA',
        'message', 'Apresente seu documento ou procuração na entrada da assembleia (Portaria) para liberar seu acesso à sala de votação.'
      );
    END IF;
  END IF;

  INSERT INTO public.assembleia_presencas (
    bloco,
    apartamento,
    fase,
    modulo,
    nome_completo,
    cpf,
    is_construtora,
    confirmado_portaria,
    online_conectado,
    conectado_em,
    ip_address,
    device_id,
    device_name,
    user_agent
  )
  VALUES (
    v_unidade.bloco,
    v_unidade.apartamento,
    v_unidade.fase,
    v_unidade.modulo,
    v_unidade.nome_completo,
    v_cpf_limpo,
    false,
    true,
    true,
    now(),
    p_ip_address,
    p_device_id,
    p_device_name,
    p_user_agent
  )
  ON CONFLICT (bloco, apartamento) DO UPDATE
    SET confirmado_portaria = true,
        online_conectado = true,
        conectado_em = COALESCE(public.assembleia_presencas.conectado_em, now()),
        ip_address = COALESCE(EXCLUDED.ip_address, public.assembleia_presencas.ip_address),
        device_id = COALESCE(EXCLUDED.device_id, public.assembleia_presencas.device_id),
        device_name = COALESCE(EXCLUDED.device_name, public.assembleia_presencas.device_name),
        user_agent = COALESCE(EXCLUDED.user_agent, public.assembleia_presencas.user_agent)
  RETURNING * INTO v_presenca;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'CHECKIN_REALIZADO',
    'message', 'Acesso validado e conectado com sucesso!',
    'presenca', jsonb_build_object(
      'id', v_presenca.id,
      'bloco', v_presenca.bloco,
      'apartamento', v_presenca.apartamento,
      'fase', v_presenca.fase,
      'modulo', v_presenca.modulo,
      'nome_completo', v_presenca.nome_completo,
      'is_construtora', v_presenca.is_construtora,
      'confirmado_portaria', v_presenca.confirmado_portaria,
      'online_conectado', v_presenca.online_conectado,
      'created_at', v_presenca.created_at
    )
  );
END;
$$;

-- 4.6-B Confirmação de Presença na Portaria / Recepção (Libera a unidade no telão como CONFIRMADO e habilita votação)
CREATE OR REPLACE FUNCTION public.assembleia_confirmar_portaria(
  p_bloco smallint,
  p_apartamento smallint,
  p_com_procuracao boolean DEFAULT false,
  p_observacao text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cfg public.assembleia_config%ROWTYPE;
  v_unidade public.assembleia_unidades%ROWTYPE;
  v_presenca public.assembleia_presencas%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM public.assembleia_config WHERE id = 1;

  SELECT *
  INTO v_unidade
  FROM public.assembleia_unidades
  WHERE bloco = p_bloco
    AND apartamento = p_apartamento;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_NAO_CADASTRADA',
      'message', 'Unidade não localizada no cadastro base. Cadastre o proprietário na aba Cadastro Geral antes de liberar.'
    );
  END IF;

  IF v_unidade.is_inadimplente OR EXISTS (
    SELECT 1 FROM public.assembleia_inadimplentes i
    WHERE i.bloco = p_bloco AND i.apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNIDADE_INADIMPLENTE',
      'message', 'Unidade consta como INADIMPLENTE e está bloqueada para voto. Encaminhe o morador ao Síndico / Mesa Diretora.'
    );
  END IF;

  IF FOUND AND NOT public.assembleia_pertence_escopo(v_unidade.fase, v_unidade.modulo, COALESCE(v_cfg.escopo_assembleia, 'TODOS')) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_QUORUM',
      'message', format(
        'O Bloco %s • Apto %s (Fase %s • Módulo %s) não pertence ao escopo desta assembleia (%s).',
        lpad(p_bloco::text, 2, '0'),
        p_apartamento,
        v_unidade.fase,
        v_unidade.modulo,
        COALESCE(v_cfg.escopo_assembleia, 'TODOS')
      )
    );
  END IF;

  INSERT INTO public.assembleia_presencas (
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
    observacao_portaria
  )
  VALUES (
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
    NULLIF(TRIM(COALESCE(p_observacao, '')), '')
  )
  ON CONFLICT (bloco, apartamento) DO UPDATE
    SET confirmado_portaria = true,
        com_procuracao = COALESCE(p_com_procuracao, public.assembleia_presencas.com_procuracao),
        observacao_portaria = COALESCE(
          NULLIF(TRIM(COALESCE(p_observacao, '')), ''),
          public.assembleia_presencas.observacao_portaria
        )
  RETURNING * INTO v_presenca;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'PORTARIA_CONFIRMADA',
    'message', format(
      'Entrada confirmada! Bloco %s • Apto %s (Fase %s) já está visível no telão e liberado para validar no celular.',
      lpad(v_presenca.bloco::text, 2, '0'),
      v_presenca.apartamento,
      v_presenca.fase
    ),
    'presenca', jsonb_build_object(
      'id', v_presenca.id,
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
      'created_at', v_presenca.created_at
    )
  );
END;
$$;

-- 4.7 Histórico de Assembleias Salvas e Reset Geral para Nova Assembleia
CREATE TABLE IF NOT EXISTS public.assembleia_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  escopo_assembleia text NOT NULL DEFAULT 'TODOS',
  convocacao_ativa text NOT NULL DEFAULT 'AGUARDANDO',
  total_presentes integer NOT NULL DEFAULT 0,
  total_pautas integer NOT NULL DEFAULT 0,
  total_votos integer NOT NULL DEFAULT 0,
  dados_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION public.assembleia_resetar_geral(
  p_manter_cadastro_base boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('assembleia.allow_reset', 'true', true);
  PERFORM set_config('assembleia.bypass_freeze', 'true', true);

  DELETE FROM public.assembleia_votos;
  DELETE FROM public.assembleia_pautas;
  ALTER SEQUENCE IF EXISTS public.assembleia_pautas_ordem_seq RESTART WITH 1;

  IF p_manter_cadastro_base THEN
    DELETE FROM public.assembleia_presencas WHERE NOT is_construtora;
  ELSE
    DELETE FROM public.assembleia_presencas;
    DELETE FROM public.assembleia_inadimplentes;
    DELETE FROM public.assembleia_unidades;
  END IF;

  UPDATE public.assembleia_config
  SET assembleia_ativa = false,
      convocacao_ativa = 'AGUARDANDO',
      timer_running = false,
      timer_started_at = NULL,
      timer_duration_seconds = 120,
      updated_at = now()
  WHERE id = 1;

  PERFORM public.assembleia_recalcular_totais_inadimplentes();
  PERFORM set_config('assembleia.allow_reset', 'false', true);
  PERFORM set_config('assembleia.bypass_freeze', 'false', true);

  RETURN jsonb_build_object(
    'ok', true,
    'message', 'Assembleia resetada com sucesso! Sistema pronto para iniciar uma nova assembleia.'
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. PERMISSÕES DATA API (POSTGREST) & ROW LEVEL SECURITY (RLS)
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.assembleia_config,
  public.assembleia_unidades,
  public.assembleia_inadimplentes,
  public.assembleia_presencas,
  public.assembleia_pautas,
  public.assembleia_votos,
  public.assembleia_historico
TO anon, authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.assembleia_calcular_fase(smallint),
  public.assembleia_calcular_modulo(smallint),
  public.assembleia_pertence_escopo(smallint, smallint, text),
  public.assembleia_total_unidades_escopo(text),
  public.assembleia_checkin_morador(smallint, smallint, text, text),
  public.assembleia_consultar_cpf(text),
  public.assembleia_confirmar_checkin_cpf(text, smallint, smallint, text, text, text, text),
  public.assembleia_confirmar_portaria(smallint, smallint, boolean, text),
  public.assembleia_abrir_pauta(uuid),
  public.assembleia_resetar_pauta(uuid, boolean),
  public.assembleia_resetar_geral(boolean)
TO anon, authenticated;

ALTER TABLE public.assembleia_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_unidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_inadimplentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_presencas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_pautas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_votos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_historico ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assembleia_historico_all" ON public.assembleia_historico;
CREATE POLICY "assembleia_historico_all"
  ON public.assembleia_historico
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_config_all" ON public.assembleia_config;
CREATE POLICY "assembleia_config_all"
  ON public.assembleia_config
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_unidades_all" ON public.assembleia_unidades;
CREATE POLICY "assembleia_unidades_all"
  ON public.assembleia_unidades
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_inadimplentes_all" ON public.assembleia_inadimplentes;
CREATE POLICY "assembleia_inadimplentes_all"
  ON public.assembleia_inadimplentes
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_presencas_all" ON public.assembleia_presencas;
CREATE POLICY "assembleia_presencas_all"
  ON public.assembleia_presencas
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_pautas_all" ON public.assembleia_pautas;
CREATE POLICY "assembleia_pautas_all"
  ON public.assembleia_pautas
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "assembleia_votos_all" ON public.assembleia_votos;
CREATE POLICY "assembleia_votos_all"
  ON public.assembleia_votos
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 6. REPLICA IDENTITY & PUBLICAÇÃO SUPABASE REALTIME (WEBSOCKETS)
-- ----------------------------------------------------------------------------
-- Nota de Privacidade: assembleia_inadimplentes NÃO é publicada no Realtime público;
-- apenas o total numérico agregado é transmitido via assembleia_config!

ALTER TABLE public.assembleia_config REPLICA IDENTITY FULL;
ALTER TABLE public.assembleia_presencas REPLICA IDENTITY FULL;
ALTER TABLE public.assembleia_pautas REPLICA IDENTITY FULL;
ALTER TABLE public.assembleia_votos REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'assembleia_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assembleia_config;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'assembleia_presencas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assembleia_presencas;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'assembleia_pautas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assembleia_pautas;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'assembleia_votos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assembleia_votos;
  END IF;
END;
$$;

-- Garante contadores sincronizados e recarrega schema cache do PostgREST
SELECT public.assembleia_recalcular_totais_inadimplentes();
NOTIFY pgrst, 'reload schema';

COMMIT;
