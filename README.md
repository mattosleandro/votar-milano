# Assembleia Geral — Milano Condomínio Club (`votar.portalmilano.com`)

Plataforma Full-Stack em tempo real para **credenciamento de presença (check-in único por unidade)**, **controle de 1ª e 2ª convocação**, **votação deliberativa ao vivo por escopo** e **auditoria jurídica oficial** da Assembleia Geral do **Milano Condomínio Club**, operando de forma 100% isolada do portal principal (`portalmilano.com`).

---

## 1. Arquitetura e Stack Tecnológica

- **Frontend & SSR:** Next.js 15 (App Router, `output: 'standalone'`) + TypeScript estrito + Tailwind CSS + `lucide-react` + `qrcode.react` + fontes self-hosted (`Plus Jakarta Sans` & `JetBrains Mono`).
- **Dados & Tempo Real:** Supabase Self-Hosted (`@supabase/supabase-js` + **Supabase Realtime WebSockets** com reconexão automática e ressincronização em `visibilitychange`/`online`).
- **Infraestrutura Self-Hosted:** Build multi-stage via **Coolify** em VPS Oracle ARM64 (`aarch64`) + exposição HTTPS/WSS via **Cloudflare Tunnel (`cloudflared`)**.

---

## 2. Rotas da Aplicação

| Rota | Público-Alvo | Funcionalidades Principais |
| :--- | :--- | :--- |
| **`/`** | Moradores (Mobile-First) | Check-in com validação de Nome Completo e CPF (Módulo 11), mapeamento automático `Bloco -> Fase/Módulo`, selects reativos (oculta unidades credenciadas e blocos esgotados), recuperação de sessão (`localStorage` + CPF), votação por escopo e **espelho em tempo real** (convocação, total de inadimplentes, placar e votos por unidade sem PII). |
| **`/telao`** | Projetor `16:9` (`1080p`/`4K`) | Dark Mode de alto contraste (`#0C0C0D` + Dourado `#CCB285`), QR Code vetorial para `https://votar.portalmilano.com`, status 1ª/2ª convocação, contadores ao vivo (Total, Fase 1, Fase 2 e **Total Agregado de Inadimplentes**), placar em tempo real e grade visual em 2 modos com tag `CONSTRUTORA` e zero PII. |
| **`/admin`** | Mesa Diretora (PIN) | Controle de 1ª e 2ª Convocação (bloqueio automático sem maioria absoluta na 1ª), gestão opcional de unidades e **voto em lote da Construtora**, bloqueio opcional de **unidades Inadimplentes** (expondo publicamente apenas o nº total), CRUD/controle de Pautas, suporte/credenciamento de mesa e exportação oficial **CSV (UTF-8 BOM para Excel)**. |
| **`/api/health`** | Coolify / Docker | Healthcheck HTTP leve (`200 OK`). |

---

## 3. Variáveis de Ambiente

Copie `.env.example` para `.env.local` (desenvolvimento) e configure no **Coolify** (marcando **Available at Buildtime** e **Available at Runtime** para variáveis `NEXT_PUBLIC_*`):

```env
NEXT_PUBLIC_SUPABASE_URL=https://api.portalmilano.com
NEXT_PUBLIC_SUPABASE_ANON_KEY=<SUA_ANON_KEY_DO_SUPABASE_SELF_HOSTED>
NEXT_PUBLIC_ADMIN_PIN=2026
NEXT_PUBLIC_APP_URL=https://votar.portalmilano.com
```

---

## 4. Banco de Dados (`supabase/schema.sql`)

O script [`supabase/schema.sql`](./supabase/schema.sql) é **100% idempotente** e utiliza exclusivamente o prefixo `assembleia_*` para coexistir com segurança junto às tabelas do portal principal:

- `public.assembleia_config` (convocação ativa, horários, escopo e contadores agregados anônimos de inadimplentes)
- `public.assembleia_inadimplentes` (bloqueio de voto gerenciado no `/admin`; **não** publicada no Realtime público)
- `public.assembleia_presencas` (`UNIQUE(bloco, apartamento)`)
- `public.assembleia_pautas` (índice único parcial garantindo no máximo `1` pauta `aberta` por vez)
- `public.assembleia_votos` (`UNIQUE(pauta_id, bloco, apartamento)` + trigger de congelamento imediato ao encerrar)

---

## 5. Comandos Locais e Deploy no Coolify + Cloudflare Tunnel

```bash
npm install
npm run typecheck   # Validação estrita TypeScript (tsc --noEmit)
npm run lint        # Validação ESLint
npm run build       # Build de produção Next.js standalone
npm run dev         # Servidor de desenvolvimento local
```

### Checklist de Publicação na VPS Oracle (`votar.portalmilano.com`)

1. **GitHub & Coolify (`http://100.83.71.103:8001`):**
   - Suba este repositório no GitHub e crie uma nova aplicação no Coolify usando **Dockerfile** na porta `3000`.
   - Conecte o container à rede Docker `milano_net` com alias `votar-milano-web` (ou aponte para a porta interna do container).
   - Cadastre as 4 variáveis `NEXT_PUBLIC_*` acima com **Build Variable** habilitado.
2. **Cloudflare Tunnel (`cloudflared`) & DNS:**
   - Adicione a regra de ingress no `cloudflared`: `votar.portalmilano.com -> http://votar-milano-web:3000`.
   - No painel DNS do Cloudflare (`portalmilano.com`), garanta que existam os dois registros **CNAME Proxied** apontando para `<SEU_TUNNEL_ID>.cfargotunnel.com`:
     - `votar` (`votar.portalmilano.com`) -> Aplicação da Assembleia
     - `api` (`api.portalmilano.com`) -> `http://supabase-envoy:8000` (necessário para que os celulares dos moradores no 4G/5G externo alcancem o REST e o WebSocket `wss://` do Supabase!).

