# 00 — Decisions and Stack

Every significant choice, why it was made, what was rejected, and what to re-check. Selection criteria, in order: **(1) stability and long-term maintenance, (2) fit for a solo developer, (3) does the job without extra infrastructure, (4) developer experience.**

Research date: October 2026. "Pin at setup" means: install the current stable minor of that major and lock it.

---

## 1. Product decisions (from our discussion)

| # | Decision | Notes |
|---|---|---|
| P1 | **A workspace is one imported GitHub repository.** | Only **app admins** import, sync and configure workspaces. |
| P2 | **Access is decided in our app, not derived from GitHub.** | A workspace is **private** (only granted users / Entra groups) or **public** (every signed-in user gets a chosen default role). |
| P3 | **Login is Microsoft Entra ID only.** | No GitHub login. Users are company identities; deprovisioning is automatic. |
| P4 | **The user's GitHub username is stored for attribution only.** | Resolved with one GitHub API call; it never grants permissions. See `02-identity-and-access.md` §3. |
| P5 | **GitHub is called through a pool of credentials.** | Several tokens / App installations; automatic failover on expiry, revocation or rate limits. See `03-github-integration.md`. |
| P6 | **All UI ↔ server communication is a typed API (tRPC).** | No Server Actions. HTTP route handlers only for webhooks, auth and health. |
| P7 | **One codebase, two processes** (web + worker), deployed to Azure App Service with Azure Database for PostgreSQL. | |
| P8 | **The core (state, rules, events) is unchanged in spirit.** | Intent vs mirror, state machine, verify-before-retry, outbox events. |
| P9 | **No manual migrations.** | Schema = `server/db/schema.ts` (drizzle-kit); guards = idempotent `drizzle/guards.sql`; BullMQ migrates its own schema. All applied automatically. |
| P10 | **BullMQ (PostgreSQL backend) for all background work.** | Queues, retries with backoff, delays, deduplication and job schedulers — inside the same PostgreSQL. |

---

## 2. The stack

| Layer | Choice | Version (Oct 2026) | Why this, for the long term |
|---|---|---|---|
| Runtime | **Node.js** | 24 LTS (move to 26 LTS once App Service offers it) | Node 24 LTS is a first-class runtime on App Service for Linux |
| Framework | **Next.js** (App Router) | 16.x (16.3 released June 2026) | One codebase for UI + API + auth; standalone output runs as a plain Node server on App Service |
| UI runtime | React | 19.x (bundled with Next 16) | — |
| Language | **TypeScript** | 6.x in the repo; TS 7's native compiler optional for fast CI type-checks | TS 7.0 has no stable programmatic API until 7.1, and Next.js's build-time type check uses that API — keep TS 6 as the project compiler until Next supports 7 |
| API layer | **tRPC v11** + **TanStack Query v5** | 11.x | Mature (since 2020), large ecosystem; v11 subscriptions run over **SSE** with resumable `tracked()` ids; first-party TanStack Query integration |
| Auth | **Better Auth** | 1.x | Self-hosted, sessions in our Postgres via its Drizzle adapter, Microsoft Entra ID provider; Auth.js is now part of Better Auth, so this is where that ecosystem's long-term investment goes |
| Background jobs | **BullMQ 6 — PostgreSQL backend** | 6.x (PostgreSQL support since 6.0, July 2026) | Same Queue/Worker/scheduler API as Redis BullMQ; jobs live in the `bullmq` schema of our database — no Redis to run. See `09-jobs-and-database-lifecycle.md` |
| ORM / schema lifecycle | **Drizzle ORM + drizzle-kit** — no hand-written migrations: `push` in development, generated migrations in production | 1.0 if GA at setup, else latest 0.x stable | SQL-transparent, no engine binary, handles our Postgres-specific needs via `sql` and custom migrations. As of mid-2026 1.0 was in release candidate while npm `latest` was still 0.x; the core team joined PlanetScale in March 2026 (strong maintenance signal) |
| Validation | **Zod 4** | 4.x | Standard Schema compatible; one schema validates tRPC input, renders forms, documents events |
| Database | **PostgreSQL 18** on **Azure Database for PostgreSQL Flexible Server** | 18 (GA on Azure, with Entra ID authentication) | `uuidv7()`, `xid8` feed, partial indexes, generated columns; passwordless auth with managed identity |
| UI components | **shadcn/ui on Base UI** + **Tailwind CSS v4** | Base UI 1.x | Base UI is shadcn/ui's default since July 2026, stable since 1.0 (Dec 2025), built by the Radix creators. shadcn components are *copied into our repo*, so there is no library lock-in |
| Client state | TanStack Query (server state) · **nuqs** (URL state) · **Zustand** (tiny UI state) | current majors | See `06-ui-ux.md` §6 |
| Forms | **React Hook Form** + Zod resolver | 7.x | The most battle-tested React form library; works with dynamic, schema-generated forms |
| Tables / lists | TanStack Table + TanStack Virtual | current majors | Headless, stable, virtualised logs and run lists |
| Motion | Motion (formerly Framer Motion) | current major | Subtle, interruptible transitions; respects reduced-motion |
| Command palette | cmdk (via shadcn `Command`) | current | Keyboard-first navigation |
| Repository | **One Next.js codebase, no monorepo tooling, no `src/` folder** | pnpm (single package) | Least moving parts for a solo developer; the worker is just another entry point in the same codebase |
| Tests | Vitest · Playwright · Testcontainers (PostgreSQL 18) | current majors | — |
| Telemetry | OpenTelemetry → **Azure Monitor** (Application Insights) | current | Next.js `instrumentation.ts` + the Azure Monitor OpenTelemetry distro |
| Secrets | **Azure Key Vault** (GitHub tokens, webhook secret, auth secrets) | — | Accessed with the App Service managed identity |

---

## 3. Key decisions explained

### D1 — tRPC instead of Server Actions, oRPC or Hono

| Option | Verdict | Reason |
|---|---|---|
| **tRPC v11** | **Chosen** | Longest track record of the typed-RPC options; SSE subscriptions with reconnect + resume; first-party TanStack Query integration; server-side caller for React Server Components; huge community = long support |
| oRPC 1.x | Strong runner-up | Built-in OpenAPI and a nicer contract-first story, 1.0 stable. Smaller maintainer base and younger ecosystem. **Revisit if we need a public OpenAPI** — tRPC's own OpenAPI package is still alpha |
| Hono RPC in a route handler | Rejected | Excellent for REST/OpenAPI; RPC typing is less ergonomic for a large internal API |
| Server Actions | Rejected (your decision) | Generated POST endpoints with build-specific ids; no subscriptions; fine for forms, weak as an API |

Consequence: every UI call is a tRPC procedure. If an external REST API is ever needed, it's a thin route-handler layer (or an oRPC/OpenAPI adapter) over the same core services.

### D2 — No client-side database (yet)

| Option | Verdict |
|---|---|
| **TanStack Query cache, updated live from SSE events** | **Chosen.** Mature, already required by tRPC, enough for "instant" UX when combined with prefetching and event-driven cache patching |
| TanStack DB | Rejected **for now**: still beta/0.x; strong idea (live queries, optimistic collections). Re-evaluate at 1.0 |
| Sync engines (Zero, Electric, Replicache) | Rejected: extra infrastructure and a second source of truth — against our "Postgres only" principle |

Optional: persist the query cache to IndexedDB for instant reloads (`06-ui-ux.md` §6.4).

### D3 — Node.js events are not the event system

`EventEmitter` is in-memory and per-process: lost on restart, invisible to the worker and to other instances, no replay. The design uses **three layers**: the Postgres `events` table (truth), Postgres `LISTEN/NOTIFY` (wake-up across processes), and an in-process emitter only to fan that wake-up out to open SSE subscriptions. Details: `05-events-and-realtime.md`.

### D4 — Token pool: tokens from different accounts, or GitHub Apps

GitHub's REST limit for personal access tokens is **per account, not per token**: all of a user's tokens (and apps acting for that user) share one 5,000 requests/hour budget. GitHub App installation tokens have their own per-installation limit. So:

- Several tokens of the **same** account → **failover only** (expiry, revocation), **no extra capacity**.
- More capacity → tokens of **different accounts** (dedicated service accounts, within your GitHub plan's terms) or **GitHub App installations**.

The schema models this with a `rate_bucket` per credential, so the picker never treats two tokens of one exhausted account as "two budgets". See `03-github-integration.md`.

### D5 — One codebase, no monorepo tools

One `package.json`, one `tsconfig.json`, one lockfile. The web app and the worker are two **entry points** of the same codebase: `next build` produces the web server; esbuild bundles `worker/main.ts` into a single file. Boundaries that packages would have given us are kept with folders plus two cheap, stable mechanisms: the `server-only` import marker (Next.js fails the build if server code leaks into a client bundle) and ESLint `no-restricted-imports` zones (e.g. `server/core` may not import `app/`, `components/` or Next.js). Turborepo/Nx would only add value with several deployable apps or teams.

### D6 — Azure App Service: two apps, one plan

`web` and `worker` are two App Service apps in the same Linux plan, deployed from the same build. The worker exposes a tiny health endpoint so App Service treats it as healthy, with **Always On** enabled. Known platform constraint: requests are cut after about 230–240 s **without data** — our SSE stream sends heartbeats, so it is unaffected. See `08-repository-and-azure.md`.

---

## 4. Assumptions to confirm

| # | Assumption | If wrong |
|---|---|---|
| A1 | The GitHub org uses **SAML SSO with Entra** (GitHub Enterprise Cloud), so Entra identity → GitHub login can be looked up automatically | Fall back to self-declared username, validated by one API call (`02` §3) |
| A2 | App admins are the members of one Entra group (`CP_ADMIN_GROUP_ID`) | Make `role` editable in the admin UI instead |
| A3 | A public workspace's default role is chosen per workspace (viewer or operator) | Fix it to viewer |
| A4 | Approvals stay (per workflow, optionally only for some environments) | Remove the approval tables and UI |
| A5 | No external automation clients in v1 | Add an API-key plugin + REST/OpenAPI layer later |

---

## 5. What to re-check before starting

1. Drizzle 1.0 GA status → choose 1.0 or the latest 0.x.
2. Whether Next.js supports TypeScript 7 as the project compiler.
3. Node 26 LTS availability on App Service.
4. A 30-minute spike: tRPC SSE subscription through App Service (verify no proxy buffering; heartbeat at 15 s).
