-- ============================================================================
-- MIGRATION FASE 2 — INTEGRIDADE, AUDITORIA IMUTÁVEL (APPEND-ONLY), RODADAS
-- NÃO-DESTRUTIVAS, IDEMPOTÊNCIA, OPTIMISTIC LOCKING, ARQUIVAMENTO ATÔMICO SHA-256
-- E SNAPSHOT AUTOMÁTICO VIA pg_cron
-- Projeto: Portal Milano (votar.portalmilano.com)
-- Regra: 100% NÃO-DESTRUTIVA sobre os dados históricos de 19/11/2026.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. TABELAS APPEND-ONLY DE AUDITORIA IMUTÁVEL (REVOKE UPDATE/DELETE + TRIGGER)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assembleia_votos_auditoria (
  id bigserial PRIMARY KEY,
  assembleia_id uuid NOT NULL REFERENCES public.assembleias(id),
  pauta_id uuid NOT NULL REFERENCES public.assembleia_pautas(id) ON DELETE CASCADE,
  rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),
  bloco smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34),
  apartamento smallint NOT NULL,
  acao text NOT NULL CHECK (acao IN ('INSERT', 'UPDATE', 'DELETE')),
  voto_anterior text,
  voto_novo text,
  is_construtora boolean NOT NULL DEFAULT false,
  idempotency_key text,
  actor_role text,
  actor_sub text,
  ip_address text,
  device_id text,
  device_name text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_votos_auditoria_asm_pauta
  ON public.assembleia_votos_auditoria (assembleia_id, pauta_id, rodada, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.assembleia_operacoes (
  id bigserial PRIMARY KEY,
  assembleia_id uuid REFERENCES public.assembleias(id),
  pauta_id uuid REFERENCES public.assembleia_pautas(id) ON DELETE SET NULL,
  operacao text NOT NULL,
  actor_email text,
  actor_role text,
  actor_sub text,
  justificativa text,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operacoes_asm_recorded
  ON public.assembleia_operacoes (assembleia_id, recorded_at DESC);

-- Trigger de blindagem append-only (impede UPDATE/DELETE mesmo em nível de banco)
CREATE OR REPLACE FUNCTION public.trg_fn_bloquear_mutacao_auditoria()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDITORIA_IMUTAVEL: A tabela % é append-only; registros de auditoria não podem ser alterados ou removidos.', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_votos_auditoria ON public.assembleia_votos_auditoria;
CREATE TRIGGER trg_bloquear_mutacao_votos_auditoria
  BEFORE UPDATE OR DELETE ON public.assembleia_votos_auditoria
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_bloquear_mutacao_auditoria();

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_operacoes ON public.assembleia_operacoes;
CREATE TRIGGER trg_bloquear_mutacao_operacoes
  BEFORE UPDATE OR DELETE ON public.assembleia_operacoes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_bloquear_mutacao_auditoria();

-- Função interna para registrar operações críticas em assembleia_operacoes
CREATE OR REPLACE FUNCTION public.assembleia_log_operacao(
  p_assembleia_id uuid,
  p_pauta_id uuid,
  p_operacao text,
  p_justificativa text DEFAULT NULL,
  p_detalhes jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_role text;
  v_sub text;
BEGIN
  v_email := NULLIF(COALESCE(auth.jwt() ->> 'email', ''), '');
  v_role := COALESCE(NULLIF(public.assembleia_auth_role(), ''), NULLIF(auth.role(), ''), current_user);
  v_sub := NULLIF(COALESCE(auth.jwt() ->> 'sub', ''), '');

  INSERT INTO public.assembleia_operacoes (
    assembleia_id, pauta_id, operacao, actor_email, actor_role, actor_sub, justificativa, detalhes
  )
  VALUES (
    p_assembleia_id,
    p_pauta_id,
    p_operacao,
    v_email,
    v_role,
    v_sub,
    NULLIF(TRIM(COALESCE(p_justificativa, '')), ''),
    COALESCE(p_detalhes, '{}'::jsonb)
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. RODADAS NÃO-DESTRUTIVAS, IDEMPOTÊNCIA E OPTIMISTIC LOCKING
-- ----------------------------------------------------------------------------

-- 2.1 assembleia_pautas: rodada + version + motivo_ultima_rodada (instant metadata default no PG17)
ALTER TABLE public.assembleia_pautas
  ADD COLUMN IF NOT EXISTS rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN IF NOT EXISTS motivo_ultima_rodada text;

-- 2.2 assembleia_votos: rodada + idempotency_key (preserva 100% dos 732 votos históricos com rodada=1)
ALTER TABLE public.assembleia_votos
  ADD COLUMN IF NOT EXISTS rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Troca constraint única (pauta_id, bloco, apartamento) por (pauta_id, rodada, bloco, apartamento)
ALTER TABLE public.assembleia_votos
  DROP CONSTRAINT IF EXISTS uq_assembleia_votos_pauta_unidade;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_assembleia_votos_pauta_rodada_unidade'
      AND conrelid = 'public.assembleia_votos'::regclass
  ) THEN
    ALTER TABLE public.assembleia_votos
      ADD CONSTRAINT uq_assembleia_votos_pauta_rodada_unidade
      UNIQUE (pauta_id, rodada, bloco, apartamento);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votos_idempotency_key
  ON public.assembleia_votos (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votos_pauta_rodada
  ON public.assembleia_votos (pauta_id, rodada);

-- 2.3 Auto-incremento de version em public.assembleias (Optimistic Locking)
CREATE OR REPLACE FUNCTION public.trg_fn_bump_assembleias_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_assembleias_version ON public.assembleias;
CREATE TRIGGER trg_bump_assembleias_version
  BEFORE UPDATE ON public.assembleias
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_bump_assembleias_version();

-- 2.4 Atualiza trg_fn_before_voto para amarrar automaticamente a rodada ativa da pauta
CREATE OR REPLACE FUNCTION public.trg_fn_before_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pauta_asm_id uuid;
  v_status text;
  v_escopo text;
  v_rodada smallint;
  v_asm_status text;
  v_exigir_portaria boolean;
  v_fase smallint;
  v_modulo smallint;
  v_is_construtora boolean;
  v_confirmado_portaria boolean;
BEGIN
  SELECT assembleia_id, status, escopo, rodada
  INTO v_pauta_asm_id, v_status, v_escopo, v_rodada
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
  NEW.rodada := v_rodada;
  NEW.is_construtora := COALESCE(v_is_construtora, false);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 2.5 Proteção contra DELETE acidental em votos de assembleias/pautas encerradas ou rodadas anteriores
CREATE OR REPLACE FUNCTION public.trg_fn_before_delete_voto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_asm_status text;
  v_pauta_status text;
  v_pauta_rodada smallint;
BEGIN
  IF COALESCE(current_setting('assembleia.bypass_freeze', true), '') = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT status INTO v_asm_status FROM public.assembleias WHERE id = OLD.assembleia_id;
  IF v_asm_status = 'encerrada' THEN
    RAISE EXCEPTION 'ASSEMBLEIA_ENCERRADA: Votos de assembleias encerradas são imutáveis e não podem ser removidos.'
      USING ERRCODE = '42501';
  END IF;

  SELECT status, rodada INTO v_pauta_status, v_pauta_rodada
  FROM public.assembleia_pautas WHERE id = OLD.pauta_id;

  IF v_pauta_rodada IS NOT NULL AND OLD.rodada < v_pauta_rodada THEN
    RAISE EXCEPTION 'RODADA_HISTORICA_IMUTAVEL: Votos de rodadas anteriores são preservados para auditoria.'
      USING ERRCODE = '42501';
  END IF;

  IF v_pauta_status = 'encerrada' THEN
    RAISE EXCEPTION 'PAUTA_ENCERRADA: Votos de pautas encerradas estão congelados e não podem ser removidos.'
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_delete_voto ON public.assembleia_votos;
CREATE TRIGGER trg_before_delete_voto
  BEFORE DELETE ON public.assembleia_votos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_before_delete_voto();

-- 2.6 Trigger de Auditoria Automática em assembleia_votos -> assembleia_votos_auditoria
CREATE OR REPLACE FUNCTION public.trg_fn_audit_voto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := COALESCE(NULLIF(public.assembleia_auth_role(), ''), NULLIF(auth.role(), ''), current_user);
  v_sub text := NULLIF(COALESCE(auth.jwt() ->> 'sub', ''), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.assembleia_votos_auditoria (
      assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
      voto_anterior, voto_novo, is_construtora, idempotency_key,
      actor_role, actor_sub, ip_address, device_id, device_name
    )
    VALUES (
      NEW.assembleia_id, NEW.pauta_id, NEW.rodada, NEW.bloco, NEW.apartamento, 'INSERT',
      NULL, NEW.voto, NEW.is_construtora, NEW.idempotency_key,
      v_role, v_sub, NEW.ip_address, NEW.device_id, NEW.device_name
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.voto IS DISTINCT FROM NEW.voto OR OLD.rodada IS DISTINCT FROM NEW.rodada THEN
      INSERT INTO public.assembleia_votos_auditoria (
        assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
        voto_anterior, voto_novo, is_construtora, idempotency_key,
        actor_role, actor_sub, ip_address, device_id, device_name
      )
      VALUES (
        NEW.assembleia_id, NEW.pauta_id, NEW.rodada, NEW.bloco, NEW.apartamento, 'UPDATE',
        OLD.voto, NEW.voto, NEW.is_construtora, NEW.idempotency_key,
        v_role, v_sub, NEW.ip_address, NEW.device_id, NEW.device_name
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.assembleia_votos_auditoria (
      assembleia_id, pauta_id, rodada, bloco, apartamento, acao,
      voto_anterior, voto_novo, is_construtora, idempotency_key,
      actor_role, actor_sub, ip_address, device_id, device_name
    )
    VALUES (
      OLD.assembleia_id, OLD.pauta_id, OLD.rodada, OLD.bloco, OLD.apartamento, 'DELETE',
      OLD.voto, NULL, OLD.is_construtora, OLD.idempotency_key,
      v_role, v_sub, OLD.ip_address, OLD.device_id, OLD.device_name
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_voto ON public.assembleia_votos;
CREATE TRIGGER trg_audit_voto
  AFTER INSERT OR UPDATE OR DELETE ON public.assembleia_votos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_audit_voto();

-- 2.7 Proteção contra exclusão de snapshots finais oficiais em assembleia_historico
CREATE OR REPLACE FUNCTION public.trg_fn_proteger_historico_final()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.tipo_snapshot = 'final' THEN
    RAISE EXCEPTION 'HISTORICO_OFICIAL_IMUTAVEL: Snapshots finais oficiais com SHA-256 não podem ser excluídos.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_historico_final ON public.assembleia_historico;
CREATE TRIGGER trg_proteger_historico_final
  BEFORE DELETE ON public.assembleia_historico
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_proteger_historico_final();

-- ----------------------------------------------------------------------------
-- 3. FUNÇÃO DE SNAPSHOT COM SHA-256 + ARQUIVAMENTO ATÔMICO + pg_cron
-- ----------------------------------------------------------------------------

-- 3.1 Gera snapshot oficial completo com hash SHA-256 verificável
CREATE OR REPLACE FUNCTION public.assembleia_gerar_snapshot(
  p_assembleia_id uuid,
  p_tipo_snapshot text DEFAULT 'manual',
  p_titulo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_asm public.assembleias%ROWTYPE;
  v_presencas jsonb := '[]'::jsonb;
  v_pautas jsonb := '[]'::jsonb;
  v_votos jsonb := '[]'::jsonb;
  v_total_presencas integer := 0;
  v_total_pautas integer := 0;
  v_total_votos integer := 0;
  v_total_auditoria integer := 0;
  v_total_operacoes integer := 0;
  v_snapshot jsonb;
  v_hash text;
  v_titulo_final text;
  v_hist public.assembleia_historico%ROWTYPE;
BEGIN
  IF current_user <> 'postgres' AND NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem gerar snapshots oficiais.');
  END IF;

  SELECT * INTO v_asm FROM public.assembleias WHERE id = p_assembleia_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Assembleia não encontrada.');
  END IF;

  SELECT
    COALESCE(jsonb_agg(to_jsonb(pr) ORDER BY pr.bloco, pr.apartamento), '[]'::jsonb),
    COUNT(*)::integer
  INTO v_presencas, v_total_presencas
  FROM public.assembleia_presencas pr
  WHERE pr.assembleia_id = v_asm.id;

  SELECT
    COALESCE(jsonb_agg(to_jsonb(pa) ORDER BY pa.ordem, pa.created_at), '[]'::jsonb),
    COUNT(*)::integer
  INTO v_pautas, v_total_pautas
  FROM public.assembleia_pautas pa
  WHERE pa.assembleia_id = v_asm.id;

  SELECT
    COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.pauta_id, v.rodada, v.bloco, v.apartamento), '[]'::jsonb),
    COUNT(*)::integer
  INTO v_votos, v_total_votos
  FROM public.assembleia_votos v
  WHERE v.assembleia_id = v_asm.id;

  SELECT COUNT(*)::integer INTO v_total_auditoria
  FROM public.assembleia_votos_auditoria
  WHERE assembleia_id = v_asm.id;

  SELECT COUNT(*)::integer INTO v_total_operacoes
  FROM public.assembleia_operacoes
  WHERE assembleia_id = v_asm.id;

  v_snapshot := jsonb_build_object(
    'config', jsonb_build_object(
      'id', 1,
      'assembleia_id', v_asm.id,
      'titulo', v_asm.titulo,
      'status', v_asm.status,
      'assembleia_ativa', (v_asm.status = 'ativa' AND v_asm.convocacao_ativa <> 'ENCERRADA'),
      'exigir_confirmacao_portaria', v_asm.exigir_confirmacao_portaria,
      'convocacao_ativa', v_asm.convocacao_ativa,
      'horario_primeira_convocacao', v_asm.horario_primeira_convocacao,
      'horario_segunda_convocacao', v_asm.horario_segunda_convocacao,
      'escopo_assembleia', v_asm.escopo_assembleia,
      'descontar_inadimplentes_quorum', v_asm.descontar_inadimplentes_quorum,
      'total_inadimplentes', v_asm.total_inadimplentes,
      'inadimplentes_por_escopo', v_asm.inadimplentes_por_escopo,
      'timer_duration_seconds', v_asm.timer_duration_seconds,
      'timer_started_at', v_asm.timer_started_at,
      'timer_running', v_asm.timer_running,
      'version', v_asm.version,
      'updated_at', v_asm.updated_at
    ),
    'presencas', v_presencas,
    'pautas', v_pautas,
    'votos', v_votos,
    'auditoria_resumo', jsonb_build_object(
      'total_eventos_votos', v_total_auditoria,
      'total_operacoes_mesa', v_total_operacoes,
      'gerado_em', now()
    )
  );

  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');
  v_titulo_final := COALESCE(
    NULLIF(TRIM(COALESCE(p_titulo, '')), ''),
    CASE p_tipo_snapshot
      WHEN 'periodico' THEN v_asm.titulo || ' [Snapshot Automático ' || to_char(now() AT TIME ZONE 'America/Campo_Grande', 'HH24:MI') || ']'
      WHEN 'pauta_encerrada' THEN v_asm.titulo || ' [Pauta Encerrada ' || to_char(now() AT TIME ZONE 'America/Campo_Grande', 'HH24:MI') || ']'
      WHEN 'final' THEN v_asm.titulo || ' — Arquivamento Oficial'
      ELSE v_asm.titulo
    END
  );

  INSERT INTO public.assembleia_historico (
    assembleia_id,
    titulo,
    tipo_snapshot,
    sha256_hash,
    escopo_assembleia,
    convocacao_ativa,
    total_presentes,
    total_pautas,
    total_votos,
    dados_snapshot
  )
  VALUES (
    v_asm.id,
    v_titulo_final,
    p_tipo_snapshot,
    v_hash,
    v_asm.escopo_assembleia,
    v_asm.convocacao_ativa,
    v_total_presencas,
    v_total_pautas,
    v_total_votos,
    v_snapshot
  )
  RETURNING * INTO v_hist;

  RETURN jsonb_build_object(
    'ok', true,
    'historico_id', v_hist.id,
    'titulo', v_hist.titulo,
    'tipo_snapshot', v_hist.tipo_snapshot,
    'sha256_hash', v_hist.sha256_hash,
    'total_presentes', v_total_presencas,
    'total_pautas', v_total_pautas,
    'total_votos', v_total_votos
  );
END;
$$;

-- 3.2 RPC Atômica: Encerrar Assembleia + Congelar Pautas + Gerar Snapshot Oficial SHA-256 + Log Imutável
CREATE OR REPLACE FUNCTION public.assembleia_encerrar_e_arquivar(
  p_assembleia_id uuid,
  p_justificativa text,
  p_titulo_arquivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_asm public.assembleias%ROWTYPE;
  v_just text := TRIM(COALESCE(p_justificativa, ''));
  v_pautas_fechadas integer := 0;
  v_snap jsonb;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem encerrar e arquivar a assembleia.');
  END IF;

  IF length(v_just) < 10 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'JUSTIFICATIVA_OBRIGATORIA',
      'message', 'Informe uma justificativa formal com no mínimo 10 caracteres para encerrar e arquivar a assembleia.'
    );
  END IF;

  SELECT * INTO v_asm
  FROM public.assembleias
  WHERE id = p_assembleia_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NAO_ENCONTRADA', 'message', 'Assembleia não encontrada.');
  END IF;

  IF v_asm.status = 'encerrada' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'JA_ENCERRADA', 'message', 'Esta assembleia já está encerrada e arquivada.');
  END IF;

  -- 1. Congela qualquer pauta ainda aberta
  UPDATE public.assembleia_pautas
  SET status = 'encerrada',
      closed_at = now(),
      version = version + 1
  WHERE assembleia_id = v_asm.id
    AND status = 'aberta';
  GET DIAGNOSTICS v_pautas_fechadas = ROW_COUNT;

  -- 2. Encerra a assembleia
  UPDATE public.assembleias
  SET status = 'encerrada',
      convocacao_ativa = 'ENCERRADA',
      timer_running = false,
      closed_at = now()
  WHERE id = v_asm.id;

  -- 3. Atualiza espelho legado
  UPDATE public.assembleia_config
  SET assembleia_ativa = false,
      convocacao_ativa = 'ENCERRADA',
      timer_running = false,
      updated_at = now()
  WHERE id = 1 AND assembleia_atual_id = v_asm.id;

  -- 4. Gera snapshot oficial final com SHA-256
  v_snap := public.assembleia_gerar_snapshot(
    v_asm.id,
    'final',
    COALESCE(NULLIF(TRIM(COALESCE(p_titulo_arquivo, '')), ''), v_asm.titulo)
  );

  -- 5. Registra operação imutável na trilha de auditoria
  PERFORM public.assembleia_log_operacao(
    v_asm.id,
    NULL,
    'ENCERRAR_E_ARQUIVAR',
    v_just,
    jsonb_build_object(
      'pautas_fechadas_no_ato', v_pautas_fechadas,
      'historico_id', v_snap ->> 'historico_id',
      'sha256_hash', v_snap ->> 'sha256_hash',
      'total_presentes', (v_snap ->> 'total_presentes')::integer,
      'total_pautas', (v_snap ->> 'total_pautas')::integer,
      'total_votos', (v_snap ->> 'total_votos')::integer
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'ASSEMBLEIA_ARQUIVADA',
    'historico_id', v_snap ->> 'historico_id',
    'sha256_hash', v_snap ->> 'sha256_hash',
    'titulo', v_snap ->> 'titulo',
    'total_presentes', (v_snap ->> 'total_presentes')::integer,
    'total_pautas', (v_snap ->> 'total_pautas')::integer,
    'total_votos', (v_snap ->> 'total_votos')::integer,
    'message', format(
      'Assembleia encerrada e arquivada com sucesso! Hash SHA-256: %s',
      left(v_snap ->> 'sha256_hash', 16) || '...'
    )
  );
END;
$$;

-- 3.3 Job pg_cron a cada 5 minutos (executa snapshot periódico APENAS quando há assembleia ativa)
CREATE OR REPLACE FUNCTION public.assembleia_cron_snapshot_periodico()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ativa_id uuid;
  v_snap jsonb;
BEGIN
  SELECT id INTO v_ativa_id
  FROM public.assembleias
  WHERE status = 'ativa'
  LIMIT 1;

  IF v_ativa_id IS NULL THEN
    RETURN;
  END IF;

  v_snap := public.assembleia_gerar_snapshot(v_ativa_id, 'periodico', NULL);

  -- Mantém retenção dos últimos 24 snapshots periódicos (~2h) por assembleia (NUNCA apaga final/manual/pauta_encerrada)
  DELETE FROM public.assembleia_historico
  WHERE id IN (
    SELECT id
    FROM public.assembleia_historico
    WHERE assembleia_id = v_ativa_id
      AND tipo_snapshot = 'periodico'
    ORDER BY created_at DESC
    OFFSET 24
  );

  PERFORM public.assembleia_log_operacao(
    v_ativa_id,
    NULL,
    'SNAPSHOT_AUTOMATICO',
    'Snapshot periódico automático (pg_cron 5 min)',
    jsonb_build_object(
      'historico_id', v_snap ->> 'historico_id',
      'sha256_hash', v_snap ->> 'sha256_hash'
    )
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. ATUALIZAÇÃO DAS RPCs DE VOTAÇÃO, TELÃO E PAUTAS PARA RODADAS + AUDITORIA + LOCK
-- ----------------------------------------------------------------------------

-- 4.1 assembleia_estado_publico: filtra votos exclusivamente pela rodada vigente (v.rodada = v_pauta_foco.rodada)
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

    v_placar := jsonb_build_object(
      'pauta_id', v_pauta_foco.id,
      'rodada', v_pauta_foco.rodada,
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

-- 4.2 assembleia_telao_snapshot: filtra votos pela rodada vigente da pauta em foco
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
   AND v.rodada = v_pauta_foco_rodada
   AND v.bloco = pr.bloco
   AND v.apartamento = pr.apartamento
  WHERE pr.assembleia_id = v_asm_id;

  RETURN v_estado || jsonb_build_object('unidades_grid', v_unidades_grid);
END;
$$;

-- 4.3 assembleia_registrar_voto: suporta rodada vigente + idempotency_key (substitui assinatura de 7 args)
DROP FUNCTION IF EXISTS public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text);

CREATE OR REPLACE FUNCTION public.assembleia_registrar_voto(
  p_pauta_id uuid,
  p_bloco smallint,
  p_apartamento smallint,
  p_voto text,
  p_ip_address text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_device_name text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_voto_limpo text := UPPER(TRIM(COALESCE(p_voto, '')));
  v_idem text := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_existente public.assembleia_votos%ROWTYPE;
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

  -- Idempotência: se esta chave exata já foi gravada, devolve sucesso sem nova escrita
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

  IF FOUND AND v_existente.voto = v_voto_limpo THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'VOTO_JA_REGISTRADO',
      'ja_igual', true,
      'id', v_existente.id,
      'rodada', v_existente.rodada,
      'voto', v_existente.voto,
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
    v_idem,
    NULLIF(TRIM(COALESCE(p_ip_address, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_id, '')), ''),
    NULLIF(TRIM(COALESCE(p_device_name, '')), '')
  )
  ON CONFLICT (pauta_id, rodada, bloco, apartamento) DO UPDATE
    SET voto = EXCLUDED.voto,
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

-- 4.4 assembleia_abrir_pauta com optimistic locking e trilha de auditoria
DROP FUNCTION IF EXISTS public.assembleia_abrir_pauta(uuid);

CREATE OR REPLACE FUNCTION public.assembleia_abrir_pauta(
  p_pauta_id uuid,
  p_expected_version integer DEFAULT NULL
)
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

  SELECT * INTO v_pauta FROM public.assembleia_pautas WHERE id = p_pauta_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Pauta não encontrada.');
  END IF;

  IF p_expected_version IS NOT NULL AND v_pauta.version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CONFLITO_VERSAO',
      'message', 'Outro administrador alterou esta pauta simultaneamente. A tela foi sincronizada; tente novamente.'
    );
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
  SET status = 'encerrada', closed_at = now(), version = version + 1
  WHERE assembleia_id = v_asm.id AND status = 'aberta' AND id <> p_pauta_id;

  UPDATE public.assembleia_pautas
  SET status = 'aberta',
      opened_at = COALESCE(opened_at, now()),
      closed_at = NULL,
      version = version + 1
  WHERE id = p_pauta_id;

  UPDATE public.assembleias
  SET timer_running = true,
      timer_started_at = now(),
      timer_duration_seconds = CASE WHEN COALESCE(timer_duration_seconds, 0) <= 0 THEN 120 ELSE timer_duration_seconds END
  WHERE id = v_asm.id;

  PERFORM public.assembleia_log_operacao(
    v_asm.id,
    p_pauta_id,
    'ABRIR_PAUTA',
    NULL,
    jsonb_build_object('ordem', v_pauta.ordem, 'titulo', v_pauta.titulo, 'rodada', v_pauta.rodada, 'escopo', v_pauta.escopo)
  );

  RETURN jsonb_build_object('ok', true, 'message', format('Pauta #%s (Rodada %s) aberta e cronômetro iniciado!', v_pauta.ordem, v_pauta.rodada));
END;
$$;

-- 4.5 assembleia_encerrar_pauta: fecha pauta + para cronômetro + snapshot de auditoria + log
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
  v_snap jsonb;
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
    COUNT(*) FILTER (WHERE voto = 'NAO')::integer
  INTO v_sim, v_nao
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
      'rodada', v_pauta.rodada,
      'sim', COALESCE(v_sim, 0),
      'nao', COALESCE(v_nao, 0),
      'snapshot_sha256', v_snap ->> 'sha256_hash'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'message', format('Pauta #%s (Rodada %s) encerrada! Votos congelados (SIM: %s × NÃO: %s).', v_pauta.ordem, v_pauta.rodada, COALESCE(v_sim, 0), COALESCE(v_nao, 0)),
    'sha256_hash', v_snap ->> 'sha256_hash'
  );
END;
$$;

-- 4.6 assembleia_resetar_pauta: NÃO-DESTRUTIVO! Incrementa rodada + exige justificativa + preserva 100% dos votos anteriores!
DROP FUNCTION IF EXISTS public.assembleia_resetar_pauta(uuid, boolean);

CREATE OR REPLACE FUNCTION public.assembleia_resetar_pauta(
  p_pauta_id uuid,
  p_reabrir boolean DEFAULT false,
  p_justificativa text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_res jsonb;
  v_pauta public.assembleia_pautas%ROWTYPE;
  v_just text := TRIM(COALESCE(p_justificativa, ''));
  v_nova_rodada smallint;
  v_votos_preservados integer := 0;
BEGIN
  IF NOT public.assembleia_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Apenas administradores podem iniciar nova rodada de votação.');
  END IF;

  IF length(v_just) < 10 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'JUSTIFICATIVA_OBRIGATORIA',
      'message', 'Informe uma justificativa com pelo menos 10 caracteres explicando o motivo da nova rodada.'
    );
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

  IF EXISTS (SELECT 1 FROM public.assembleias WHERE id = v_pauta.assembleia_id AND status = 'encerrada') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Não é permitido iniciar nova rodada em uma assembleia já encerrada.');
  END IF;

  SELECT COUNT(*)::integer INTO v_votos_preservados
  FROM public.assembleia_votos
  WHERE pauta_id = p_pauta_id AND rodada = v_pauta.rodada;

  v_nova_rodada := v_pauta.rodada + 1;

  -- NENHUM VOTO É APAGADO! Apenas incrementa a rodada ativa da pauta
  UPDATE public.assembleia_pautas
  SET rodada = v_nova_rodada,
      motivo_ultima_rodada = v_just,
      status = 'aguardando',
      opened_at = NULL,
      closed_at = NULL,
      version = version + 1
  WHERE id = p_pauta_id;

  PERFORM public.assembleia_log_operacao(
    v_pauta.assembleia_id,
    p_pauta_id,
    'NOVA_RODADA_PAUTA',
    v_just,
    jsonb_build_object(
      'ordem', v_pauta.ordem,
      'titulo', v_pauta.titulo,
      'rodada_anterior', v_pauta.rodada,
      'rodada_nova', v_nova_rodada,
      'votos_preservados_rodada_anterior', v_votos_preservados,
      'reabrir', p_reabrir
    )
  );

  IF p_reabrir THEN
    v_open_res := public.assembleia_abrir_pauta(p_pauta_id, v_pauta.version + 1);
    IF NOT COALESCE((v_open_res ->> 'ok')::boolean, false) THEN
      RETURN v_open_res;
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'rodada', v_nova_rodada,
      'votos_preservados', v_votos_preservados,
      'message', format(
        'Rodada %s iniciada e aberta ao vivo! (%s voto(s) da Rodada %s preservados na auditoria).',
        v_nova_rodada, v_votos_preservados, v_pauta.rodada
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'rodada', v_nova_rodada,
    'votos_preservados', v_votos_preservados,
    'message', format(
      'Pauta avançada para Rodada %s (aguardando abertura). %s voto(s) da Rodada %s preservados intactos na auditoria.',
      v_nova_rodada, v_votos_preservados, v_pauta.rodada
    )
  );
END;
$$;

-- 4.7 Instrumentação de auditoria em confirmar_portaria, cancelar_entrada_portaria e criar_nova
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
    RETURN jsonb_build_object('ok', false, 'code', 'ACESSO_NEGADO', 'message', 'Acesso restrito a usuários autenticados da Portaria ou Mesa Diretora.');
  END IF;

  IF p_assembleia_id IS NOT NULL THEN
    SELECT * INTO v_asm FROM public.assembleias WHERE id = p_assembleia_id;
  ELSE
    SELECT * INTO v_asm FROM public.assembleias WHERE status = 'ativa' LIMIT 1;
  END IF;

  IF NOT FOUND OR v_asm.status <> 'ativa' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SEM_ASSEMBLEIA_ATIVA', 'message', 'Não existe nenhuma assembleia ativa no momento.');
  END IF;

  SELECT * INTO v_unidade
  FROM public.assembleia_unidades
  WHERE bloco = p_bloco AND apartamento = p_apartamento;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNIDADE_NAO_CADASTRADA', 'message', 'Unidade não localizada no cadastro base.');
  END IF;

  IF v_unidade.is_inadimplente OR EXISTS (
    SELECT 1 FROM public.assembleia_inadimplentes i
    WHERE i.assembleia_id = v_asm.id AND i.bloco = p_bloco AND i.apartamento = p_apartamento
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNIDADE_INADIMPLENTE', 'message', 'Unidade consta como INADIMPLENTE e está bloqueada para voto.');
  END IF;

  IF NOT public.assembleia_pertence_escopo(v_unidade.fase, v_unidade.modulo, v_asm.escopo_assembleia) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FORA_DO_ESCOPO_QUORUM',
      'message', format('Bloco %s • Apto %s fora do escopo (%s).', lpad(p_bloco::text, 2, '0'), p_apartamento, v_asm.escopo_assembleia)
    );
  END IF;

  INSERT INTO public.assembleia_presencas (
    assembleia_id, bloco, apartamento, fase, modulo, nome_completo, cpf,
    is_construtora, confirmado_portaria, online_conectado, com_procuracao,
    observacao_portaria, cpf_procurador
  )
  VALUES (
    v_asm.id, v_unidade.bloco, v_unidade.apartamento, v_unidade.fase, v_unidade.modulo,
    v_unidade.nome_completo, v_unidade.cpf, v_unidade.is_construtora, true, false,
    COALESCE(p_com_procuracao, false), NULLIF(TRIM(COALESCE(p_observacao, '')), ''),
    CASE WHEN COALESCE(p_com_procuracao, false) THEN v_cpf_proc ELSE NULL END
  )
  ON CONFLICT (assembleia_id, bloco, apartamento) DO UPDATE
    SET confirmado_portaria = true,
        com_procuracao = COALESCE(p_com_procuracao, public.assembleia_presencas.com_procuracao),
        observacao_portaria = COALESCE(NULLIF(TRIM(COALESCE(p_observacao, '')), ''), public.assembleia_presencas.observacao_portaria),
        cpf_procurador = CASE
          WHEN COALESCE(p_com_procuracao, false) THEN COALESCE(v_cpf_proc, public.assembleia_presencas.cpf_procurador)
          ELSE NULL
        END
  RETURNING * INTO v_presenca;

  PERFORM public.assembleia_log_operacao(
    v_asm.id,
    NULL,
    'CONFIRMAR_PORTARIA',
    NULLIF(TRIM(COALESCE(p_observacao, '')), ''),
    jsonb_build_object(
      'bloco', v_presenca.bloco,
      'apartamento', v_presenca.apartamento,
      'com_procuracao', v_presenca.com_procuracao,
      'tem_cpf_procurador', (v_presenca.cpf_procurador IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'PORTARIA_CONFIRMADA',
    'message', format(
      'Entrada confirmada! Bloco %s • Apto %s (Fase %s) já está visível no telão e liberado para validar no celular.',
      lpad(v_presenca.bloco::text, 2, '0'), v_presenca.apartamento, v_presenca.fase
    ),
    'presenca', jsonb_build_object(
      'id', v_presenca.id, 'assembleia_id', v_presenca.assembleia_id,
      'bloco', v_presenca.bloco, 'apartamento', v_presenca.apartamento,
      'fase', v_presenca.fase, 'modulo', v_presenca.modulo,
      'nome_completo', v_presenca.nome_completo, 'cpf', v_presenca.cpf,
      'is_construtora', v_presenca.is_construtora, 'confirmado_portaria', v_presenca.confirmado_portaria,
      'online_conectado', v_presenca.online_conectado, 'com_procuracao', v_presenca.com_procuracao,
      'observacao_portaria', v_presenca.observacao_portaria, 'cpf_procurador', v_presenca.cpf_procurador,
      'created_at', v_presenca.created_at
    )
  );
END;
$$;

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
    AND v.rodada = p.rodada
    AND v.bloco = v_pr.bloco
    AND v.apartamento = v_pr.apartamento;

  DELETE FROM public.assembleia_presencas WHERE id = p_presenca_id;

  PERFORM public.assembleia_log_operacao(
    v_pr.assembleia_id,
    NULL,
    'CANCELAR_PORTARIA',
    NULL,
    jsonb_build_object('bloco', v_pr.bloco, 'apartamento', v_pr.apartamento)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'message', format('Bloco %s • Apto %s removido da lista de presença.', lpad(v_pr.bloco::text, 2, '0'), v_pr.apartamento)
  );
END;
$$;

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
    titulo, status, convocacao_ativa, horario_primeira_convocacao,
    horario_segunda_convocacao, escopo_assembleia, started_at
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

  PERFORM public.assembleia_log_operacao(
    v_nova.id,
    NULL,
    'CRIAR_ASSEMBLEIA',
    NULL,
    jsonb_build_object('titulo', v_nova.titulo, 'escopo', v_nova.escopo_assembleia, 'ativar', p_ativar)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'assembleia', to_jsonb(v_nova),
    'message', 'Nova assembleia criada com sucesso (históricos anteriores preservados intactos)!'
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. PRIVILÉGIOS, RLS DAS NOVAS TABELAS DE AUDITORIA E GRANTS DAS NOVAS RPCs
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.assembleia_votos_auditoria, public.assembleia_operacoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.assembleia_votos_auditoria, public.assembleia_operacoes TO authenticated, service_role;
GRANT INSERT ON TABLE public.assembleia_votos_auditoria, public.assembleia_operacoes TO service_role;

ALTER TABLE public.assembleia_votos_auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembleia_operacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "votos_auditoria_select_admin" ON public.assembleia_votos_auditoria;
CREATE POLICY "votos_auditoria_select_admin" ON public.assembleia_votos_auditoria
  FOR SELECT TO authenticated
  USING (public.assembleia_is_admin());

DROP POLICY IF EXISTS "operacoes_select_admin" ON public.assembleia_operacoes;
CREATE POLICY "operacoes_select_admin" ON public.assembleia_operacoes
  FOR SELECT TO authenticated
  USING (public.assembleia_is_admin());

-- Grants das RPCs atualizadas / novas
REVOKE ALL ON FUNCTION public.assembleia_log_operacao(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assembleia_gerar_snapshot(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_cron_snapshot_periodico() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assembleia_encerrar_e_arquivar(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_abrir_pauta(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_encerrar_pauta(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assembleia_resetar_pauta(uuid, boolean, text, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.assembleia_estado_publico(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_telao_snapshot(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_registrar_voto(uuid, smallint, smallint, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_abrir_pauta(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_encerrar_pauta(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_resetar_pauta(uuid, boolean, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_encerrar_e_arquivar(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_gerar_snapshot(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assembleia_cron_snapshot_periodico() TO service_role;

-- ----------------------------------------------------------------------------
-- 6. AGENDAMENTO IDEMPOTENTE NO pg_cron (SNAPSHOT AUTOMÁTICO A CADA 5 MINUTOS)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job_id IN
      SELECT jobid FROM cron.job WHERE jobname = 'assembleia_snapshot_periodico_5min'
    LOOP
      PERFORM cron.unschedule(v_job_id);
    END LOOP;

    PERFORM cron.schedule(
      'assembleia_snapshot_periodico_5min',
      '*/5 * * * *',
      'SELECT public.assembleia_cron_snapshot_periodico();'
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
