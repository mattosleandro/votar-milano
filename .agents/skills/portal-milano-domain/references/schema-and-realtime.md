# Blueprint SQL, Sigilo PII / Anti-Exposição de Inadimplentes e Supabase Realtime (`supabase/schema.sql`)

Este documento detalha o modelo de dados para `supabase/schema.sql` garantindo simultaneamente:
1. Compatibilidade total com os entregáveis exigidos (`assembleia_presencas`, `assembleia_pautas`, `assembleia_votos` + `assembleia_config` + `assembleia_inadimplentes`).
2. Operação usando apenas as 3 variáveis de ambiente padrão (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_ADMIN_PIN`).
3. **Sigilo real (LGPD e Código Civil)** nas rotas públicas `/` e `/telao`: zero exposição de `nome_completo` e `cpf` de moradores e **zero exposição de `bloco` e `apartamento` de unidades inadimplentes** (expondo publicamente apenas o contador total agregado!).

---

## 1. Tabelas Principais

### A) `assembleia_config` (Singleton `id = 1` — Público via Realtime)
Armazena o estado global da convocação e os **contadores agregados anônimos de inadimplentes** (atualizados automaticamente por trigger SQL):
- `id` (`integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)`)
- `convocacao_ativa` (`text NOT NULL DEFAULT 'PRIMEIRA'` — `'AGUARDANDO' | 'PRIMEIRA' | 'SEGUNDA' | 'ENCERRADA'`)
- `horario_primeira_convocacao` (`text NOT NULL DEFAULT '19:00'`)
- `horario_segunda_convocacao` (`text NOT NULL DEFAULT '19:30'`)
- `escopo_assembleia` (`text NOT NULL DEFAULT 'TODOS'` — `'TODOS' | 'FASE_1' | 'FASE_2' | 'MODULO_1' | 'MODULO_2' | 'MODULO_3' | 'MODULO_4'`)
- `descontar_inadimplentes_quorum` (`boolean NOT NULL DEFAULT true`)
- `total_inadimplentes` (`integer NOT NULL DEFAULT 0` — mantido por trigger a partir de `assembleia_inadimplentes`, sem jamais revelar `bloco` ou `apartamento`!)
- `inadimplentes_por_escopo` (`jsonb NOT NULL DEFAULT '{"TODOS":0,"FASE_1":0,"FASE_2":0,"MODULO_1":0,"MODULO_2":0,"MODULO_3":0,"MODULO_4":0}'::jsonb` — contagens puramente numéricas para cálculo exato de quórum por escopo!)
- `updated_at` (`timestamptz NOT NULL DEFAULT now()`)

### B) `assembleia_inadimplentes` (Gerenciada exclusivamente pelo `/admin`)
Registra unidades sem direito a voto cadastradas pela Mesa nos mesmos moldes da Construtora:
- `id` (`uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
- `bloco` (`smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34)`)
- `apartamento` (`smallint NOT NULL CHECK (apartamento IN (101,102,103,104,201,202,203,204,301,302,303,304,401,402,403,404))`)
- `fase` (`smallint NOT NULL CHECK (fase IN (1, 2))`)
- `modulo` (`smallint NOT NULL CHECK (modulo IN (1, 2, 3, 4))`)
- `observacao` (`text`)
- `created_at` (`timestamptz NOT NULL DEFAULT now()`)
- **Constraint Crítica:** `UNIQUE (bloco, apartamento)`
- **Triggers Automáticos em `assembleia_inadimplentes`:**
  1. Ao inserir `(bloco, apartamento)` em `assembleia_inadimplentes`, remove automaticamente eventual presença/voto em aberto daquela unidade (impedindo que alguém que entrou antes continue votando).
  2. Recalcula atomicamente `total_inadimplentes` e `inadimplentes_por_escopo` na tabela `assembleia_config`, disparando evento Realtime instantâneo para todos os celulares (`/`) e para o `/telao` **contendo apenas os números totais, zero `bloco`/`apartamento`**!
  3. **NÃO** publicar `assembleia_inadimplentes` nos listeners públicos de `/` e `/telao` (apenas `/admin` consulta/edita `assembleia_inadimplentes`).

### C) `assembleia_presencas`
Credenciamento único por apartamento apto (morador adimplente ou construtora):
- `id` (`uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
- `bloco` (`smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34)`)
- `apartamento` (`smallint NOT NULL CHECK (apartamento IN (101,102,103,104,201,202,203,204,301,302,303,304,401,402,403,404))`)
- `fase` (`smallint NOT NULL CHECK (fase IN (1, 2))`)
- `modulo` (`smallint NOT NULL CHECK (modulo IN (1, 2, 3, 4))`)
- `nome_completo` (`text NOT NULL`)
- `cpf` (`text NOT NULL`)
- `is_construtora` (`boolean NOT NULL DEFAULT false`)
- `created_at` (`timestamptz NOT NULL DEFAULT now()`)
- **Constraint Crítica:** `UNIQUE (bloco, apartamento)`
- **Trigger de Bloqueio de Inadimplente:** Impede `INSERT`/`UPDATE` em `assembleia_presencas` caso `EXISTS (SELECT 1 FROM assembleia_inadimplentes WHERE bloco = NEW.bloco AND apartamento = NEW.apartamento)`.

### D) `assembleia_pautas`
Pautas deliberativas gerenciadas pela mesa:
- `id` (`uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
- `ordem` (`serial` / `integer NOT NULL`)
- `titulo` (`text NOT NULL`)
- `descricao` (`text`)
- `escopo` (`text NOT NULL CHECK (escopo IN ('TODOS','FASE_1','FASE_2','MODULO_1','MODULO_2','MODULO_3','MODULO_4'))`)
- `status` (`text NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','aberta','encerrada'))`)
- `created_at` (`timestamptz NOT NULL DEFAULT now()`)
- `opened_at` (`timestamptz`)
- `closed_at` (`timestamptz`)
- **Índice Único Parcial Crítico:** `CREATE UNIQUE INDEX idx_unica_pauta_aberta ON assembleia_pautas ((true)) WHERE status = 'aberta';`

### E) `assembleia_votos`
Registro de votos congeláveis por unidade e pauta:
- `id` (`uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
- `pauta_id` (`uuid NOT NULL REFERENCES assembleia_pautas(id) ON DELETE CASCADE`)
- `bloco` (`smallint NOT NULL CHECK (bloco BETWEEN 1 AND 34)`)
- `apartamento` (`smallint NOT NULL CHECK (apartamento IN (101,102,103,104,201,202,203,204,301,302,303,304,401,402,403,404))`)
- `voto` (`text NOT NULL CHECK (voto IN ('SIM', 'NAO', 'ABSTENCAO'))`)
- `is_construtora` (`boolean NOT NULL DEFAULT false`)
- `updated_at` (`timestamptz NOT NULL DEFAULT now()`)
- **Constraint Crítica:** `UNIQUE (pauta_id, bloco, apartamento)`
- **Trigger Duplo de Integridade Jurídica:**
  1. Rejeita `INSERT`/`UPDATE`/`DELETE` de voto quando `assembleia_pautas.status <> 'aberta'` (exceto reset administrativo da pauta).
  2. Rejeita `INSERT`/`UPDATE` de voto se `(NEW.bloco, NEW.apartamento)` constar em `assembleia_inadimplentes` ou não constar em `assembleia_presencas`.

---

## 2. Publicação `supabase_realtime` e Resiliência

- Habilitar `REPLICA IDENTITY FULL` e adicionar `assembleia_config`, `assembleia_presencas`, `assembleia_pautas` e `assembleia_votos` à publicação `supabase_realtime`.
- Nas rotas públicas (`/` e `/telao`), projetar estritamente `id, bloco, apartamento, fase, modulo, is_construtora, created_at` de `assembleia_presencas` (nunca `nome_completo` nem `cpf`) e ler o total de inadimplentes apenas do contador agregado `assembleia_config.total_inadimplentes`!
