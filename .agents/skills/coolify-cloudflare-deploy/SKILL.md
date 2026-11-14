---
name: coolify-cloudflare-deploy
description: >-
  Guia de build, containerização e deploy de produção para o Portal Milano (portalmilano.com)
  usando Next.js App Router (output: 'standalone'), Supabase Self-Hosted (REST + Realtime WebSockets),
  Coolify em VPS própria (Docker / Nixpacks) e Cloudflare Tunnel (cloudflared). Ative ao configurar
  next.config.mjs, Dockerfile, variáveis NEXT_PUBLIC_*, healthchecks ou reconexão WebSocket.
---

# Deploy Self-Hosted — Coolify + Cloudflare Tunnel + Supabase (`portalmilano.com`)

Este skill evita as armadilhas clássicas de produção ao rodar Next.js App Router com Supabase Realtime atrás de Coolify e Cloudflare Tunnel (`cloudflared`).

---

## 1. Configuração Obrigatória do `next.config.mjs`

- Definir `output: 'standalone'` para gerar um servidor Node mínimo e autossuficiente em `.next/standalone/server.js`.
- **Qualidade Estrita de Build:** Não utilizar `ignoreBuildErrors: true` nem `ignoreDuringBuilds: true` como muleta; o código deve compilar com **zero erros de TypeScript e ESLint** (`npm run build` limpo).

---

## 2. Regra Crítica de Variáveis `NEXT_PUBLIC_*` no Coolify (Build-Time Inlining)

O Next.js substitui variáveis `process.env.NEXT_PUBLIC_*` em **tempo de build** no bundle JavaScript do cliente:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_ADMIN_PIN`

### Como garantir funcionamento no Coolify (Docker e Nixpacks):
1. No `Dockerfile` multi-stage, declarar explicitamente no estágio `builder`:
   ```dockerfile
   ARG NEXT_PUBLIC_SUPABASE_URL
   ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
   ARG NEXT_PUBLIC_ADMIN_PIN
   ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
   ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
   ENV NEXT_PUBLIC_ADMIN_PIN=$NEXT_PUBLIC_ADMIN_PIN
   ```
2. No painel do **Coolify**, marcar as 3 variáveis como **Available at Buildtime** e **Available at Runtime**.
3. No código cliente, criar validação amigável de boot (`lib/env.ts`) para alertar imediatamente em ambiente de dev/staging caso alguma variável esteja ausente, sem quebrar silenciosamente o WebSocket.

---

## 3. Checklist do Container Standalone (`Dockerfile`)

1. **Estágio `deps`:** `node:20-alpine` (ou `22-alpine`), instala `package.json` + `package-lock.json` via `npm ci`.
2. **Estágio `builder`:** recebe os `ARG NEXT_PUBLIC_*`, copia o código-fonte e executa `npm run build`.
3. **Estágio `runner`:**
   - `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`
   - Usuário não-root (`nextjs:nodejs`, UID `1001`)
   - Copia `public` -> `./public`
   - Copia `.next/standalone` -> `./`
   - Copia `.next/static` -> `./.next/static`
   - Define `ENV HOSTNAME="0.0.0.0"` e `ENV PORT=3000` (obrigatório para o proxy reverso Traefik/Caddy do Coolify e para o `cloudflared` alcançarem o container!)
   - `EXPOSE 3000` e `CMD ["node", "server.js"]`.
4. **Rota de Healthcheck (`/api/health`):** Responder `200 OK` `{ status: "ok", timestamp }` para que o Coolify monitore a saúde do container sem falsos negativos em zero-downtime deploys.

---

## 4. Cloudflare Tunnel (`cloudflared`) e Supabase Self-Hosted WebSockets

- **Subdomínio Público Dedicado da Assembleia:** `https://votar.portalmilano.com` -> apontado no Cloudflare Zero Trust Tunnel para o serviço HTTP interno do Coolify na VPS Oracle (mantendo `https://portalmilano.com` 100% isolado para o portal principal do condomínio).
- **Conexão com Supabase Self-Hosted:**
  - Como o `@supabase/supabase-js` roda no navegador dos moradores (4G/5G externo), `NEXT_PUBLIC_SUPABASE_URL` **deve** ser uma URL HTTPS pública acessível externamente (ex.: o subdomínio já exposto pelo seu Cloudflare Tunnel para o gateway Kong do Supabase na VPS Oracle), pois páginas `https://` bloqueiam conexões Mixed Content (`http://` ou `ws://`).
  - No Cloudflare Dashboard (Network), manter **WebSockets = ON** (ativo por padrão) para permitir upgrade `wss://` em `/realtime/v1/websocket`.
- **Heartbeat & Reconexão Celular (4G/5G):**
  - Configurar o cliente Supabase Realtime com `heartbeatIntervalMs: 15000` e reconexão exponencial, além de listener de `window.addEventListener('online', ...)` e `document.addEventListener('visibilitychange', ...)` para ressincronizar estado assim que o celular do morador retomar sinal ou sair do bloqueio de tela.

