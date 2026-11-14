---
name: portal-milano-domain
description: >-
  Regras de negócio oficiais, identidade visual Milano Condomínio Club, matemática de quórum,
  fuso horário de Campo Grande (America/Campo_Grande), cadastro prévio de condôminos (assembleia_unidades),
  check-in apenas por CPF com confirmação de Bloco/Apto/Fase e telemetria de dispositivo, representação
  da construtora, bloqueio e contagem agregada anônima de inadimplentes, e projeção compacta Bxx | Axxx
  da Assembleia Geral do Condomínio Milano (votar.portalmilano.com). Ative SEMPRE antes de implementar,
  revisar ou testar utilitários de domínio, schema SQL do Supabase, fluxos de check-in (/),
  projeção (/telao) ou painel da mesa (/admin).
---

# Domínio Oficial — Assembleia Geral Milano Condomínio Club (`votar.portalmilano.com`)

Este runbook define a fonte única da verdade (Single Source of Truth) para todas as regras de negócio e identidade visual da Assembleia Geral do **Milano Condomínio Club**. Nenhuma tela ou query pode divergir destas especificações.

---

## 0. Identidade Visual Oficial (`imagens/` -> `public/brand/`)

Extraída diretamente dos arquivos vetoriais oficiais (`Logo.svg` e `LogoEscrita.svg`):
- **Nome Oficial:** `MILANO CONDOMÍNIO CLUB`
- **Cores Institucionais:**
  - **Brand Gold (Champagne):** `#CCB285`
  - **Brand Dark (Obsidian):** `#0C0C0D`
  - **Brand Light:** `#FFFFFF`
- **Aplicação dos Ativos:**
  - `imagens/Logo.svg` -> `app/icon.svg` e `public/brand/logo-mark.svg` (favicon vetorial, selo central do QR Code no `/telao`, ícone compacto em badges/headers).
  - `imagens/LogoEscrita.svg` e `imagens/LogoComEscritaMilano.webp` -> `public/brand/` (logotipo completo para fundos claros em `/` e `/admin`).
  - `imagens/LogoComEscritaBrancaMilano.webp` (e componente SVG `<MilanoLogo variant="dark" />` usando `#CCB285` + `#FFFFFF`) -> cabeçalho principal de alto contraste no Dark Mode do `/telao` e headers escuros.
  - `imagens/ApenasLogoMilano.webp` e `imagens/Prancheta 1.png` -> `app/apple-icon.png` / OpenGraph para compartilhamento no WhatsApp.
- **Regra de Harmonia Semântica:** Usar `#CCB285` para identidade institucional, bordas nobres, títulos/destaques de marca e selos neutros; **nunca** confundir o dourado `#CCB285` com o amarelo/âmbar vivo (`amber-400`/`amber-500`) reservado exclusivamente ao voto `ABSTENÇÃO`.

---

## 1. Topologia Física do Condomínio (544 Unidades)

- **Blocos:** `34` blocos numerados de `1` a `34` (exibidos com zero à esquerda: `01` a `34`).
- **Apartamentos por Bloco:** `16` apartamentos fixos e idênticos em todos os 34 blocos (`34 × 16 = 544` unidades):
  - **1º Pavimento (Térreo):** `101`, `102`, `103`, `104`
  - **2º Pavimento:** `201`, `202`, `203`, `204`
  - **3º Pavimento:** `301`, `302`, `303`, `304`
  - **4º Pavimento:** `401`, `402`, `403`, `404`

### Mapeamento Determinístico: `Bloco -> Fase & Módulo`

O morador **jamais** escolhe Fase ou Módulo manualmente. Tudo deriva exclusivamente do número inteiro do `bloco` (`1..34`):

| Fase | Módulo | Blocos Incluídos | Qtde Blocos | Qtde Unidades |
| :--- | :--- | :--- | :---: | :---: |
| **Fase 1** | **Módulo 1** | `26` ao `34` | 9 | 144 |
| **Fase 1** | **Módulo 2** | `19` ao `25` | 7 | 112 |
| *Subtotal Fase 1* | *Módulos 1 e 2* | *`19` ao `34`* | *16* | *256* |
| **Fase 2** | **Módulo 3** | `01` ao `04` e `09` ao `11` | 7 | 112 |
| **Fase 2** | **Módulo 4** | `05` ao `08` e `12` ao `18` | 11 | 176 |
| *Subtotal Fase 2* | *Módulos 3 e 4* | *`01` ao `18`* | *18* | *288* |
| **TOTAL GERAL** | **Módulos 1 a 4** | **`01` ao `34`** | **34** | **544** |

### Regra de Pertencimento por Escopo (`EscopoVotacao`)

Valores válidos de escopo: `'TODOS' | 'FASE_1' | 'FASE_2' | 'MODULO_1' | 'MODULO_2' | 'MODULO_3' | 'MODULO_4'`.
Total físico de unidades (`N_escopo`): `TODOS=544`, `FASE_1=256`, `FASE_2=288`, `MODULO_1=144`, `MODULO_2=112`, `MODULO_3=112`, `MODULO_4=176`.

---

## 2. Senha Interna, Fuso Horário Oficial (`America/Campo_Grande`), Convocações e Trava de Ativação

1. **Segurança da Mesa Diretora (`/admin`):**
   - Protegido por **Senha Interna Forte de 10 caracteres** (`NEXT_PUBLIC_ADMIN_PIN`, padrão gerado: **`M1l@no#26A`** — letras maiúsculas, minúsculas, números e caracteres especiais).
2. **Fuso Horário Oficial (`America/Campo_Grande` — `UTC-4`):**
   - Todos os horários de convocação, relógio do `/telao`, cronômetros regressivos e carimbos de auditoria CSV utilizam estritamente `America/Campo_Grande`.
3. **Passo 1 Obrigatório para Liberar Check-in (`assembleia_ativa`):**
   - Antes de permitir qualquer check-in na tela do morador (`/`), a Mesa Diretora deve selecionar e salvar no `/admin`:
     - **Quórum / Escopo Convocado** (`escopo_assembleia`: `TODOS`, `FASE_1`, `FASE_2`, `MODULO_1..4`)
     - **Horário de início da 1ª Convocação** e **Horário de início da 2ª Convocação**
   - Enquanto `assembleia_ativa = false`, a rota `/` exibe *"Não existe nenhuma votação ativa no momento."* e mantém o campo de digitação de CPF **bloqueado (`disabled`)**.
   - Quando `assembleia_ativa = true`, apenas unidades pertencentes ao `escopo_assembleia` selecionado podem realizar check-in.
4. **Fórmula Matemática de Quórum para Abertura de Votação:**
   - **1ª Convocação (`PRIMEIRA`) — Maioria Absoluta:** Exige $P \ge \lfloor N / 2 \rfloor + 1$.
   - **2ª Convocação (`SEGUNDA`) — Maioria Simples:** Permite abrir votação com qualquer número de presentes ($P \ge 1$).

---

## 3. Base Geral de Condôminos (`assembleia_unidades`), Check-in Apenas por CPF e Telemetria

1. **Cadastro Geral no `/admin` (`assembleia_unidades`):**
   - Armazena todas as unidades com `bloco`, `apartamento`, `fase`, `modulo`, `nome_completo`, `cpf`, `is_inadimplente` e `is_construtora` (individual ou importação CSV em lote).
   - Triggers SQL mantêm `assembleia_inadimplentes` e `assembleia_presencas` (para unidades da Construtora) sincronizados automaticamente.
2. **Check-in Mobile em 2 Passos Apenas por CPF (`/`):**
   - **Passo 1:** O morador digita **exclusivamente seu CPF** (`assembleia_consultar_cpf`).
   - **Passo 2:** O sistema exibe o `Bloco`, `Apartamento` e `Fase / Módulo` vinculados para o morador **Confirmar Presença** (`assembleia_confirmar_checkin_cpf`).
3. **Telemetria de Dispositivo (Apenas Análise/Auditoria — Sem Bloqueio):**
   - Captura `ip_address`, `device_id` (fingerprint do aparelho/navegador), `device_name` e `user_agent` no check-in e no voto.
   - O painel `/admin` e os relatórios CSV destacam alertas caso múltiplas unidades façam check-in ou votem a partir do mesmo aparelho físico (`⚠️ Mesmo Aparelho`), sem bloquear o morador.

---

## 4. Unidades Inadimplentes (Aviso de Regularização + Total Público Agregado)

- **Regra Condominial (Art. 1.335, III CC):** Inadimplentes **não podem votar**.
- **Aviso Privado ao Morador Inadimplente (`/`):**
  - Quando um morador cuja unidade está marcada como inadimplente digita seu CPF no check-in, recebe a mensagem clara de que a unidade encontra-se **bloqueada para realizar votação**, orientando-o a **quitar os valores pendentes referentes ao condomínio e apresentar o comprovante ao Síndico / Mesa Diretora** para liberação imediata no `/admin`.
- **Visibilidade Pública Obrigatória (`/` e `/telao`):**
  - Exibe-se para todos **APENAS a quantidade total agregada de unidades inadimplentes (`total_inadimplentes`)**, **JAMAIS** exibindo `Bloco` ou `Apartamento` dos inadimplentes nas telas públicas.

---

## 5. Projetor `/telao` (16:9 Dark Mode): Cronômetros e Matriz `Bxx | Axxx`

1. **Cronômetro de Convocação & Relógio Local (Campo Grande - MS):**
   - Enquanto `convocacao_ativa === 'AGUARDANDO'`, exibe o cronômetro regressivo mostrando quanto tempo falta para iniciar a 1ª Convocação e, depois, a 2ª Convocação.
   - Assim que a convocação é iniciada (`PRIMEIRA` ou `SEGUNDA`), exibe apenas o **Relógio Local de Campo Grande (`HH:mm:ss`)**.
2. **Contador Regressivo de Deliberação (Padrão `2 min`):**
   - Configurável no `/admin` (`1`, `2` [padrão], `3`, `5` min ou personalizado, com Iniciar/Pausar/Resetar) e exibido decrementando ao vivo no `/telao`.
3. **Todos os 34 Blocos (`544` Unidades) na Mesma Tela (`Bxx | Axxx`):**
   - Matriz ultra-compacta de `16 colunas × N blocos` onde cada célula exibe **`Bxx | Axxx`** (ex.: `B26 | A101`) e a cor de fundo indica presença e voto em tempo real (`SIM` verde, `NÃO` vermelho, `ABSTENÇÃO` amarelo/âmbar, `PRESENTE` azul celeste, `AUSENTE` grafite escuro).
