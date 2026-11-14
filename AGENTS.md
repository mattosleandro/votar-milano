# AGENTS.md — Assembleia Milano (`votar.portalmilano.com`)

Diretriz mestre de engenharia, arquitetura e governança operacional para construção e manutenção da plataforma web de credenciamento e votação ao vivo da **Assembleia Geral do Milano Condomínio Club (`votar.portalmilano.com`)**, operando de forma 100% isolada do portal principal (`portalmilano.com`).

---

## Diretriz Operacional Obrigatória: Método GCCD

Todo planejamento, tomada de decisão técnica, criação de PR/commit e execução de tarefas neste repositório **DEVE** ser estruturado e validado pelo método **GCCD**:

- **G — Goal (Objetivo):** Qual resultado concreto precisa ser alcançado e qual problema real da assembleia ele resolve.
- **C — Context (Contexto):** Arquitetura, identidade visual, regras de negócio condominiais, topologia de blocos/fases/módulos, estado atual do repositório e dependências relevantes.
- **C — Constraints (Restrições):** Limites técnicos, performance em 4G/5G, segurança, sigilo jurídico de identidade e de inadimplência (LGPD / Código Civil), compatibilidade com Coolify/Cloudflare Tunnel e escopo.
- **D — Done When (Critérios de Conclusão):** Condições observáveis, testáveis e verificáveis para considerar a entrega concluída (zero `// TODO`, build limpo, Realtime validado).

---

## 1. GCCD Macro do Projeto (`votar.portalmilano.com`)

### G — Goal (Objetivo)
Entregar uma aplicação web Full-Stack em tempo real, responsiva, com a identidade visual oficial do **Milano Condomínio Club**, auditável e pronta para produção no subdomínio dedicado **`votar.portalmilano.com`** para operar:
1. **Credenciamento único por apartamento (Check-in)** de moradores adimplentes, registro opcional de **unidades da Construtora** (não vendidas/não entregues) e bloqueio opcional de **unidades Inadimplentes** (sem direito a voto).
2. **Controle de instalação em 1ª e 2ª Convocação** com cálculo automático de quórum (**Maioria Absoluta** na 1ª vs **Maioria Simples** na 2ª) por escopo convocado.
3. **Votação deliberativa ao vivo** por pauta e escopo (`TODOS`, `FASE_1`, `FASE_2`, `MODULO_1..4`), com congelamento imediato ao encerrar.
4. **Transparência instantânea com sigilo absoluto** tanto no projetor **`/telao` (16:9 Dark Mode)** quanto **espelhada em tempo real na tela do celular do morador (`/`)**:
   - Unidades votantes/presentes exibem exclusivamente `Bloco + Apartamento` (e tag `CONSTRUTORA` quando aplicável), **sem Nome ou CPF**.
   - Unidades **Inadimplentes** são exibidas para todos (no celular `/` e no `/telao`) **EXCLUSIVAMENTE pela quantidade total agregada**, **JAMAIS** exibindo `Bloco` ou `Apartamento`.
5. **Gestão de Mesa e Auditoria Jurídica (`/admin`)** com exportação oficial em CSV (Lista de Presença e Auditoria de Votos com Nome Completo e CPF para conferência com a ata física).

---

### C — Context (Contexto)

#### Stack & Infraestrutura Self-Hosted
- **Aplicação:** Next.js (App Router) + TypeScript estrito + Tailwind CSS + `lucide-react` + gerador de QR Code vetorial (`https://votar.portalmilano.com`).
- **Dados & Tempo Real:** Supabase Self-Hosted (`@supabase/supabase-js`) com **Supabase Realtime (`postgres_changes` via WebSockets)** em todas as entidades de estado da assembleia.
- **Deploy & Rede:** Código no GitHub -> Build/Deploy via **Coolify** em VPS Oracle (`next.config.mjs` com `output: 'standalone'` + `Dockerfile` multi-stage) -> Exposição pública HTTPS/WSS via **Cloudflare Tunnel (`cloudflared`)** no subdomínio **`votar.portalmilano.com`** (mantendo `portalmilano.com` intacto para o portal principal do condomínio).
- **Variáveis de Ambiente Padrão:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_ADMIN_PIN` (Senha forte interna de 10 caracteres com maiúsculas, minúsculas, números e caracteres especiais; padrão gerado: `M1l@no#26A`)
  - `NEXT_PUBLIC_APP_URL` *(opcional, padrão `https://votar.portalmilano.com`)*
- **Fuso Horário Oficial Obrigatório:** `America/Campo_Grande` (`UTC-4`, Mato Grosso do Sul) em todas as operações de convocação, cronômetros e registros de auditoria.

#### Identidade Visual Oficial (`imagens/` -> `public/brand/`)
Análise dos ativos oficiais da marca **MILANO CONDOMÍNIO CLUB** fornecidos em `imagens/`:
- **Paleta Institucional Oficial (extraída dos SVGs vetoriais):**
  - **Dourado Champagne (Brand Accent):** `#CCB285`
  - **Obsidiana / Grafite Escuro (Brand Dark):** `#0C0C0D` (harmonizado com `slate-950` no Dark Mode)
  - **Branco Puro:** `#FFFFFF`
  - *(Cores semânticas de votação permanecem estritas e inconfundíveis: Verde = `SIM`, Vermelho = `NÃO`, Amarelo/Âmbar = `ABSTENÇÃO`, Cinza = `AGUARDANDO`).*
- **Uso Adequado de Cada Ativo (`public/brand/`):**
  - `Logo.svg` (vetorial `#CCB285`, monograma arquitetônico `M`): Favicon oficial (`app/icon.svg`), selo central do QR Code no `/telao`, ícone compacto mobile e indicadores de carregamento.
  - `LogoEscrita.svg` e `LogoComEscritaMilano.webp` (monograma `#CCB285` + escrita `#0C0C0D` `MILANO CONDOMÍNIO CLUB`): Cabeçalhos em superfícies claras (`/` e `/admin`).
  - `LogoComEscritaBrancaMilano.webp` (e variante SVG com texto `#FFFFFF` + ícone `#CCB285`): Cabeçalho principal de alto contraste no projetor Dark Mode (`/telao`) e banners escuros.
  - `ApenasLogoMilano.webp` e `Prancheta 1.png`: Apple Touch Icon / OpenGraph preview ao compartilhar `https://votar.portalmilano.com` no WhatsApp.

#### Regras de Negócio Críticas — Estrutura Física (544 Unidades)
- **Total:** `34` blocos (`01` a `34`) × `16` apartamentos por bloco = **`544` apartamentos**.
- **Numeração Fixa por Bloco:**
  - 1º Pavimento (Térreo): `101`, `102`, `103`, `104`
  - 2º Pavimento: `201`, `202`, `203`, `204`
  - 3º Pavimento: `301`, `302`, `303`, `304`
  - 4º Pavimento: `401`, `402`, `403`, `404`
- **Mapeamento Automático `Bloco -> Fase & Módulo` (Zero seleção manual pelo morador):**
  - **FASE 1 (16 blocos / 256 aptos):**
    - **Módulo 1:** Blocos `26` ao `34` (9 blocos / 144 aptos)
    - **Módulo 2:** Blocos `19` ao `25` (7 blocos / 112 aptos)
  - **FASE 2 (18 blocos / 288 aptos):**
    - **Módulo 3:** Blocos `01` ao `04` e `09` ao `11` (7 blocos / 112 aptos)
    - **Módulo 4:** Blocos `05` ao `08` e `12` ao `18` (11 blocos / 176 aptos)

#### Regras de Negócio Críticas — Cadastro Base, Check-in por CPF, Inadimplentes, Convocações, Telemetria e Telão Compacto
1. **Cadastro Base Completo de Todas as Unidades no `/admin` (`assembleia_unidades`):**
   - Todas as 544 unidades são gerenciadas no `/admin` (individualmente, em lote por bloco ou via importação CSV) contendo `Bloco`, `Apartamento`, `Fase/Módulo` (automáticos), `Nome Completo`, `CPF`, status de **Inadimplência (`is_inadimplente`)** e representação da **Construtora (`is_construtora`)**.
2. **Trava Obrigatória de Configuração de Quórum e Horários (`America/Campo_Grande`):**
   - A primeira ação obrigatória no `/admin` para liberar o sistema é selecionar e salvar o **Quórum/Escopo da Assembleia** (`TODOS`, `FASE_1`, `FASE_2`, `MODULO_1..4`) e os **Horários de Início da 1ª e 2ª Convocação** (sempre no fuso `America/Campo_Grande`).
   - Enquanto essa configuração não for salva/ativada, a **Tela Mobile do Morador (`/`)** informa que **"Não existe nenhuma votação ativa no momento"** e **bloqueia a digitação do CPF** para check-in.
   - Com base no que for selecionado no Quórum (`escopo_assembleia`), somente as unidades pertencentes àquele escopo têm permissão para realizar check-in.
3. **Check-in Simplificado Apenas por CPF + Telemetria de Dispositivo (`/`):**
   - Na rota `/`, o morador digita **apenas o CPF**. O sistema consulta a base cadastrada e exibe o **`Bloco`**, **`Apartamento`** e **`Fase / Módulo`** correspondentes para o morador apenas confirmar o check-in.
   - **Inadimplentes:** Caso a unidade vinculada ao CPF esteja inadimplente, o morador recebe a informação de que está bloqueado para realizar votação, devendo quitar os valores referentes ao condomínio e apresentar o comprovante ao Síndico / Mesa Diretora para liberar a votação no `/admin`. Nas telas públicas (`/` e `/telao`), exibe-se **exclusivamente a quantidade total agregada** de inadimplentes (jamais exibindo bloco/apartamento).
   - **Telemetria de Aparelho para Análise Anti-Fraude (Sem Bloqueio):** No momento do check-in e do voto, o sistema captura `IP`, `device_id` (assinatura/fingerprint do aparelho) e `device_name` (modelo/SO/navegador) para identificar e alertar no `/admin` e no CSV caso uma pessoa esteja fazendo check-in ou votando por mais de uma unidade no mesmo aparelho.
4. **Projetor `/telao` (16:9 Dark Mode) com Cronômetros e Grade Completa Ultra-Compacta (`Bxx | Axxx`):**
   - Exibe cronômetro regressivo mostrando quanto tempo falta para a **1ª Convocação** e depois para a **2ª Convocação**; após iniciada a convocação, exibe o **relógio com a hora local de Campo Grande (`America/Campo_Grande`)**.
   - Exibe **Contador Regressivo de Deliberação** controlado pelo `/admin` (`1`, **`2` [padrão]**, `3`, `5` min ou personalizado).
   - Exibe todos os blocos/unidades simultaneamente na tela em formato ultra-compacto **`Bxx | Axxx`** (ex.: `B26 | A101`), onde a cor indica em tempo real se está presente e como votou (`SIM`, `NÃO`, `ABSTENÇÃO`, `PRESENTE`, `AUSENTE`).

#### Arquitetura de Rotas
- **`/` (Morador — Mobile-First com Identidade Milano):**
  - *Check-in:* Cabeçalho com logo oficial Milano, Nome Completo validado, CPF com máscara e validação matemática, Select de Bloco (`01..34`) com badge imediato *"Identificado: Fase X • Módulo Y"*, Select de Apartamento agrupado por pavimento (**ocultando apartamentos já credenciados e ocultando o bloco inteiro quando esgotado**, só retornando mediante liberação no `/admin`), opção de recuperação de sessão com mesmo CPF e persistência em `localStorage`.
  - *Sala de Votação:* Cabeçalho da unidade + Fase/Módulo, banner da convocação/quórum + contador total de inadimplentes, tela de espera elegante ou pauta aberta com verificação de escopo (3 botões grandes `SIM` verde, `NÃO` vermelho, `ABSTENÇÃO` amarelo/cinza quando apto; bloqueio amigável quando fora do escopo), feedback imediato e espelho ao vivo do placar + votos por unidade.
- **`/telao` (Projeção 16:9 `1080p`/`4K` — Dark Mode `slate-950` / `#0C0C0D` com Dourado `#CCB285`):**
  - Logo `MILANO CONDOMÍNIO CLUB` (versão branca + dourado), QR Code grande e nítido para `https://votar.portalmilano.com` + texto grande `votar.portalmilano.com`, status da 1ª/2ª Convocação e contadores ao vivo (Presentes Total, Fase 1, Fase 2, Quórum e **Total de Inadimplentes** — apenas número).
  - Título da Pauta + Badge Gigante do Escopo + Placar em Tempo Real (`SIM`, `NÃO`, `ABSTENÇÃO`, `AGUARDANDO` com absolutos e `%` restritos ao escopo da pauta).
  - Grade Visual de Transparência (`B26 • 101` + tag `CONSTRUTORA` quando aplicável, zero PII e **zero marcação/exposição de apartamentos inadimplentes**) com alternador rápido entre *"Mostrar Apenas Unidades Presentes Aptas"* e *"Mapa Completo do Escopo"*.
- **`/admin` (Mesa Diretora e Auditoria — Protegido por `NEXT_PUBLIC_ADMIN_PIN`):**
  - Configuração ao vivo das Convocações (horários 1ª e 2ª, convocação ativa, escopo geral e monitor de quórum).
  - Gestão de Unidades e Voto em Lote da Construtora (opcional, por bloco/apartamento).
  - Gestão de Unidades Inadimplentes (opcional, seleção individual/lote por bloco e liberação rápida, sincronizando automaticamente apenas a contagem agregada para `/` e `/telao`).
  - Gestão de Pautas (criar com escopo; Abrir Votação garantindo **exclusivamente 1 pauta aberta por vez** e validando quórum na 1ª convocação; Encerrar congelando votos; Reabrir/Resetar).
  - Suporte de Mesa / Credenciamento (busca por Bloco, Apto, Nome ou CPF; Editar ou Remover/Liberar unidade equivocada).
  - Exportação Oficial CSV (Lista de Presença completa e Auditoria de Votos Geral ou por Pauta com UTF-8 BOM para Excel).

---

### C — Constraints (Restrições Inegociáveis)

1. **Sigilo Absoluto de Identidade e de Inadimplência (Hard Privacy & Anti-Exposure Rule):**
   - **JAMAIS** renderizar ou trafegar `Nome Completo` ou `CPF` de moradores nas rotas públicas (`/` e `/telao`).
   - **JAMAIS** renderizar ou trafegar `Bloco` e `Apartamento` das unidades inadimplentes nos payloads/telas públicas (`/` e `/telao`) — nem por card, nem por cor diferenciada no Mapa Completo, nem via WebSocket público. Apenas a **quantidade total numérica** de inadimplentes é pública!
2. **Integridade e Unicidade no Banco (`Postgres`):**
   - `UNIQUE(bloco, apartamento)` em `assembleia_presencas` e em `assembleia_inadimplentes`.
   - `UNIQUE(pauta_id, bloco, apartamento)` em `assembleia_votos`.
   - Trigger SQL impedindo voto de qualquer unidade registrada em `assembleia_inadimplentes` e congelando votos assim que `status = 'encerrada'`.
   - Apenas **1 pauta com `status = 'aberta'`** simultaneamente.
3. **Validação Estrita de Formulário:**
   - `Nome Completo`: mínimo nome e sobrenome ($\ge 2$ palavras), apenas letras (com acentos) e espaços; **proibido números e caracteres especiais**.
   - `CPF`: máscara `000.000.000-00`, **proibido letras e caracteres especiais**, bloqueio de dígitos repetidos e validação matemática Módulo 11.
4. **Resiliência Mobile & Realtime:**
   - Zero necessidade de F5/reload. Reconexão automática de WebSocket + ressincronização em `visibilitychange`/`online` + sessão persistida em `localStorage`.
5. **Qualidade de Produção & Deploy:**
   - `next.config.mjs` com `output: 'standalone'`.
   - Zero `// TODO`, zero mocks estáticos no lugar do Supabase, zero erros de TypeScript (`tsc --noEmit`) ou ESLint no `npm run build`.

---

### D — Done When (Critérios de Conclusão Global)

- [ ] Ativos da marca em `imagens/` integrados adequadamente em `public/brand/` e `app/icon.svg` (paleta `#CCB285` / `#0C0C0D` aplicada com alto contraste).
- [ ] `supabase/schema.sql` completo e idempotente (`assembleia_config`, `assembleia_presencas`, `assembleia_inadimplentes`, `assembleia_pautas`, `assembleia_votos`, contador agregado seguro de inadimplentes em `assembleia_config` via trigger para zero vazamento de bloco/apto no WebSocket, triggers de bloqueio de voto inadimplente/pauta encerrada e publicação `supabase_realtime`).
- [ ] Utilitários de domínio 100% tipados: mapeador `Bloco -> Fase/Módulo`, validador/máscara de CPF, validador de Nome Completo, motor de escopo e calculador de quórum (1ª vs 2ª Convocação).
- [ ] Rota `/` (Morador) completa com logo oficial, selects dinâmicos, recuperação por mesmo CPF, bloqueio privado caso unidade esteja inadimplente, votação por escopo e espelho ao vivo de convocação + total de inadimplentes + placar + votos por unidade.
- [ ] Rota `/telao` (16:9 Dark Mode) completa com logo `MILANO CONDOMÍNIO CLUB` branca/dourada, QR Code `https://votar.portalmilano.com`, status de convocação/quórum, contador total de inadimplentes (sem bloco/apto), placar ao vivo e grade de transparência em 2 modos com tag `CONSTRUTORA` e zero PII.
- [ ] Rota `/admin` protegida por PIN completa com configuração de 1ª/2ª Convocação, cadastro/voto opcional da Construtora, cadastro/liberação opcional de Inadimplentes, controle de pautas, suporte de mesa e exportações CSV oficiais.
- [ ] `Dockerfile` multi-stage + `next.config.mjs` (`output: 'standalone'`) + `/api/health` validados com `npm run build` passando com 0 erros.

---

## 2. Roadmap de Execução em Sprints GCCD

1. **Marco 1 (Fundação, Brand Assets, Build & Schema SQL):**
   - *G:* Inicializar Next.js App Router + Tailwind + copiar ativos `imagens/` para `public/brand/` e `app/icon.svg` + `supabase/schema.sql` + `Dockerfile` standalone.
   - *D:* Projeto configurado, ativos da marca prontos e `schema.sql` validado para Supabase self-hosted.
2. **Marco 2 (Núcleo de Domínio & Hook Realtime Resiliente):**
   - *G:* Implementar `lib/condominio.ts` (544 unidades, Fases/Módulos, Quórum 1ª/2ª Convocação, contadores agregados), `lib/validators.ts` (CPF Mod-11 e Nome) e provedor central de Supabase Realtime com auto-reconexão.
   - *D:* Funções puras validadas para todos os 34 blocos e sincronização WebSocket operacional.
3. **Marco 3 (Rota `/` — Experiência Mobile do Morador):**
   - *G:* Construir Check-in com logo Milano e selects reativos, recuperação de sessão (`localStorage` + CPF), validação privada de inadimplência, Sala de Votação por escopo e Espelho Mobile (Convocação + Total Inadimplentes + Placar + Votos por Unidade).
   - *D:* Fluxo completo mobile testado em viewport `360px–430px` sem vazamento de PII nem de unidades inadimplentes.
4. **Marco 4 (Rota `/telao` — Projeção 16:9 Dark Mode Milano):**
   - *G:* Construir dashboard Dark Mode com logo branca/dourada Milano, QR Code `portalmilano.com`, Convocação/Quórum, Total de Inadimplentes (apenas número), Placar ao Vivo e Grade de Transparência (2 modos + tag `CONSTRUTORA`).
   - *D:* Legibilidade validada para `1920x1080` / `4K` e atualização instantânea via WebSocket.
5. **Marco 5 (Rota `/admin` — Mesa, Construtora, Inadimplentes, Convocações e CSV):**
   - *G:* Construir painel com PIN, gestão de 1ª/2ª Convocação, gestão/voto em lote da Construtora, gestão em lote/individual de Inadimplentes, CRUD/controle de Pautas, suporte de mesa e exportação CSV oficial.
   - *D:* `npm run lint`, `tsc --noEmit` e `npm run build` (`standalone`) aprovados com 0 erros.

---

## 3. Skills Instaladas no Workspace (`.agents/skills/`)

| Skill | Quando Ativar |
| :--- | :--- |
| **`portal-milano-domain`** | **Obrigatória** para regras de negócio, 34 blocos/fases/módulos, quórum 1ª/2ª convocação, construtora, bloqueio/contagem anônima de inadimplentes, identidade visual Milano e sigilo PII no `schema.sql`. |
| **`coolify-cloudflare-deploy`** | Ao configurar `next.config.mjs` (`standalone`), `Dockerfile`, variáveis `NEXT_PUBLIC_*` no Coolify, `/api/health` e WebSockets atrás do Cloudflare Tunnel. |
| **`supabase`** | Ao implementar `@supabase/supabase-js`, canais `supabase_realtime`, RPCs e tratamento de reconexão. |
| **`supabase-postgres-best-practices`** | Ao escrever ou revisar `supabase/schema.sql`, constraints `UNIQUE`, índices parciais, triggers e políticas RLS. |
| **`nextjs-app-router-patterns`** | Ao estruturar rotas App Router (`/`, `/telao`, `/admin`, `/api/health`), boundaries Server/Client e Route Handlers. |
| **`vercel-react-best-practices`** | Ao otimizar re-renders em tempo real (grade de 544 unidades no `/telao` e espelho mobile em `/`). |
| **`tailwind-design-system`** | Ao estruturar tokens da marca (`#CCB285`, `#0C0C0D`) e tokens semânticos (`SIM`, `NÃO`, `ABSTENÇÃO`, `AGUARDANDO`, `CONSTRUTORA`). |
| **`frontend-design`** | Ao desenhar a estética refinada mobile-first (`/`), dark-mode de projeção (`/telao`) e console da mesa (`/admin`). |
| **`web-design-guidelines`** | Ao auditar contraste, acessibilidade, áreas de toque mobile ($\ge 48\text{px}$), estados de foco e feedback de formulário. |
| **`multi-stage-dockerfile`** | Ao construir e otimizar a imagem Docker multi-stage enxuta e segura para deploy no Coolify. |
