# 06 — UI / UX

**Concept: mission control for workflows.** GitHub Actions shows everything about CI. We show what a person needs to *run a job and know how it went* — and hide the rest one click away. Calm when things are fine, precise when they're not.

---

## 1. Experience principles

| Principle | What it means on screen |
|---|---|
| **Intent first** | People pick "Deploy Payments → staging", not a YAML file in a repo. Names, descriptions and categories come from the curated catalog |
| **Calm by default** | Neutral surfaces, one accent color, status color only where status lives. No walls of badges |
| **Honest status** | "Sending to GitHub", "Confirming with GitHub", "Last confirmed 4 s ago". Never a fake "Running" |
| **Instant** | Pages arrive with data (server prefetch), navigation hits a warm cache, live events update in place — no refresh buttons |
| **Explain before submit** | The run form says "needs approval from Release", "another production deploy is running", "you can only deploy release/*" *before* the click |
| **Failure is the main event** | When a run fails, the failing step opens itself with the relevant log lines highlighted and one obvious next action |
| **Keyboard-first** | ⌘K for everything; `R` run, `.` re-run failed, `C` cancel, `J/K` move through lists |
| **Accessible** | WCAG 2.2 AA; status never by color alone; live updates announced politely |

### What we remove compared to GitHub's Actions UI

| GitHub shows | We show instead |
|---|---|
| Every workflow file in the repo | Only exposed, named workflows, grouped by category |
| Raw `workflow_dispatch` input boxes | A typed form: selects, toggles, validated fields, help text, defaults from your last run |
| Run list mixing pushes, PRs, schedules | Your requests first; "all runs" one tab away with clear filters |
| Full log of every step | A progress rail; the failing step's excerpt; full log on demand |
| No idea who really clicked (bot account) | The real person, always |
| Re-run buried in menus | One key, with the same inputs pre-filled |

---

## 2. Navigation and information architecture

```
┌──────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ CP     │  ⌘K  Search workflows, runs, workspaces…              ● Live  P │
│          ├─────────────────────────────────────────────────────────────────┤
│ ⌂ Home   │                                                                 │
│ ▤ Runs   │                         page                                    │
│ ✓ Approvals 2                                                              │
│          │                                                                 │
│ PINNED   │                                                                 │
│ ▣ Payments                                                                 │
│ ▣ Platform                                                                 │
│ + All workspaces                                                           │
│          │                                                                 │
│ ADMIN    │  (admins only)                                                  │
│ ⚙ Workspaces · Credentials · System                                         │
└──────────┴─────────────────────────────────────────────────────────────────┘
```

| Route | Screen |
|---|---|
| `/` | Home |
| `/runs` · `/runs/[id]` | My / all requests · Run view |
| `/approvals` | Approvals inbox |
| `/w` | All workspaces (Explore) |
| `/w/[slug]` | Workspace: Workflows · Runs · Approvals · (Settings for admins) |
| `/w/[slug]/run/[workflowId]` | Run composer (also opens as a sheet over any page) |
| `/w/[slug]/github-runs/[runId]/[attempt]` | Any GitHub run, even ones not started by us |
| `/admin/import` | Import repository wizard |
| `/admin/workspaces/[slug]` | Visibility, grants, credentials, workflow settings |
| `/admin/credentials` | Credential pool |
| `/admin/system` | Health: queues, buckets, webhooks, drift |
| `/me` | Profile, GitHub username, preferences |

---

## 3. Key screens

### 3.1 Home — "what needs me, what's moving"

```
 Good morning, Priya
 ─────────────────────────────────────────────────────────────────────────
 RUNNING NOW
  ◉ Deploy Payments · staging · 1.9.4      deploy ▓▓▓▓▓▓░░  3m 12s    ›
 NEEDS YOU
  ✓ Ravi wants to deploy Payments to production · 1.9.3   [Review]
 QUICK RUN
  [ Deploy Payments ▸ staging ]  [ Integration tests ▸ main ]  [ + ]
 RECENT
  ✔ Deploy Payments · staging · 1.9.3        4m 09s     yesterday 16:02
  ✖ Integration tests · main  · step "e2e"  11m 40s    yesterday 14:40  ↻
```

Quick Run chips replay your last inputs for that workflow (opens the composer pre-filled; one Enter to confirm).

### 3.2 Workspace — workflows as products

```
 Payments                                   acme/payments-service · public (viewer)
 Workflows   Runs   Approvals   Settings
 ─────────────────────────────────────────────────────────────────────────
 DEPLOY
 ┌────────────────────────────┐ ┌────────────────────────────┐
 │ Deploy Payments            │ │ Rollback Payments          │
 │ Ship a released version    │ │ Return to previous release │
 │ dev · staging · prod 🔒     │ │ prod 🔒                     │
 │ last: ✔ 1.9.3 · 1d ago      │ │ last: — never              │
 │                    Run  R  │ │                    Run     │
 └────────────────────────────┘ └────────────────────────────┘
 QUALITY
 ┌────────────────────────────┐
 │ Integration tests          │   (view-only cards show no Run button)
 └────────────────────────────┘
```

🔒 = approval required for that environment (for you).

### 3.3 Run composer — the form GitHub never had

```
 Run · Deploy Payments                                                   esc
 ─────────────────────────────────────────────────────────────────────────
 Branch or tag   [ release/1.9          ▾ ]   allowed: release/*
 Environment     ( dev )( staging )(● production 🔒)
 Version         [ 1.9.4                 ]   semver · last used 1.9.3
 Dry run         ○
 ─────────────────────────────────────────────────────────────────────────
 ⓘ Needs 1 approval from Release before it starts.
 ⓘ Another production deploy is running — yours will wait for it.
                                              Cancel   Request deploy ⌘↵
```

- Built from the workflow's input JSON Schema + admin's UI hints; fields validate as you type and against the server's dry-run (`runs.validate`) when you pause.
- Defaults: your last values for this workflow, then the workflow's defaults.
- Button text reflects the outcome ("Run", "Request deploy", "Queue run").
- An idempotency key is created when the composer opens — double submits are impossible.

### 3.4 Run view — focus mode

```
 Deploy Payments → production · 1.9.4                      Cancel  ⋯
 Priya · 10:00 · release/1.9 · approved by Meera
 ─────────────────────────────────────────────────────────────────────────
  ✔ Requested  ✔ Approved  ✔ Sent  ◉ Running  ○ Done
 ─────────────────────────────────────────────────────────────────────────
  build  ▓▓▓▓▓▓▓▓▓▓ 1m40s ✔
  deploy ▓▓▓▓▓▓░░░░ 2m10s ◉   Login ✔ · Apply manifests ◉ · Smoke test ○
  notify ░░░░░░░░░░ waiting
                                   GitHub run #9001 · confirmed 4s ago  ↗
 ─────────────────────────────────────────────────────────────────────────
 Timeline ▾          Inputs ▸          Full logs ▸
```

On failure:

```
 ✖ Failed in deploy › Smoke test                       Re-run failed  .
 ┌──────────────────────────────────────────────────────────────────────┐
 │ 212  curl https://payments.staging/health                            │
 │ 213  HTTP 503 Service Unavailable            ← first error           │
 │ 214  Error: health check failed after 5 attempts                     │
 └──────────────────────────────────────────────────────────────────────┘
   Open full log ▸     Open in GitHub ↗
```

### 3.5 Log viewer

Side panel or full screen; virtualised (handles 100k+ lines); ANSI colors; step folding; search with match count; "jump to first error"; follow mode while running; copy link to a line.

### 3.6 Approvals inbox

One card per request: who, what, where, inputs diff against the last successful run of the same workflow/environment, policy ("1 of Release"), expiry countdown, **Approve** / **Deny** with optional comment. Your own requests never show buttons.

### 3.7 Admin — import a repository

```
 Import repository                                                 1 · 2 · 3
 ─────────────────────────────────────────────────────────────────────────
 1  Find   [ payments                                  ]
           acme/payments-service      reachable by bot-a, bot-b     Select
           acme/payments-infra        reachable by bot-b            Select
 2  Credentials   ☑ bot-a (dispatch)  ☑ bot-b (dispatch)  ☐ acme App (read)
 3  Access        ( Private ) ( Public — everyone can view / run )
                  Grant: [ Release (Entra group) ▾ ] [ operator ▾ ] ☑ can approve
 ─────────────────────────────────────────────────────────────────────────
                                                         Import & sync
```

After import, a live progress panel shows workflows appearing as they're synced; the admin then toggles which to expose and edits names, descriptions, input hints, approval and concurrency rules.

### 3.8 Admin — credential pool

Buckets with remaining budget bars and reset times; credentials with status, expiry countdown, coverage per workspace; warnings ("Payments has a single dispatch-capable account"); Add / Rotate / Disable.

---

## 4. Visual language

| Element | Rule |
|---|---|
| Typography | One neutral grotesk for UI (e.g. Inter or Geist) + one monospace for logs and ids; tabular numbers for durations |
| Color | Neutral greys; one brand accent for primary actions; semantic status colors (success, danger, attention, progress, neutral) defined as tokens, tuned for light and dark |
| Density | Comfortable by default, compact option in preferences (lists, logs) |
| Shape | Subtle radii, hairline borders, no heavy shadows |
| Motion | 120–200 ms ease-out for state changes; progress bars animate continuously; nothing moves when the user prefers reduced motion |
| Icons | One outline icon set; status icons always paired with text |

### Status language

| Phase | Label | Icon | Token |
|---|---|---|---|
| pending | Requested | ○ | neutral |
| awaiting_approval | Waiting for approval | ⏸ | attention |
| waiting_for_slot | Queued behind another run | ⏳ | attention |
| dispatching | Sending to GitHub | ◌ | progress |
| verifying | Confirming with GitHub | ◌ | progress |
| dispatched | Queued on GitHub | ◌ | progress |
| running | Running | ◉ | progress |
| cancelling | Cancelling | ◉ | attention |
| succeeded | Succeeded | ✔ | success |
| failed | Failed — *reason* | ✖ | danger |
| cancelled | Cancelled | ⊘ | neutral |
| rejected | Not started — *reason* | ⊘ | danger |
| lost | Couldn't confirm with GitHub | ? | danger |

---

## 5. Frontend architecture

### 5.1 Rendering model

| Part | Rendered as |
|---|---|
| Layouts, page shells, first data | **React Server Components** — prefetch through the tRPC server-side caller, hydrate the TanStack Query cache |
| Interactive parts (composer, run view, lists, logs, palette) | Client components using tRPC + TanStack Query hooks |
| Live updates | One `live.stream` subscription in the app shell, patching the cache |

### 5.2 Folder structure (repository root — no `src/`)

```
app/                     routes only (thin): layouts, pages, route handlers
  (app)/                 signed-in area: layout with shell + live stream
    page.tsx             Home
    runs/ approvals/ w/[slug]/ me/
  (admin)/admin/         admin area (server-side role check in layout)
  api/trpc/[trpc]/ api/auth/[...all]/ api/webhooks/github/ api/logs/[jobId]/ api/health/
features/                one folder per feature: components, hooks, query keys
  home/ catalog/ composer/ run-view/ logs/ approvals/ admin-import/ admin-credentials/ …
components/
  ui/                    shadcn/ui components (Base UI), owned by us
  app-shell/ status/ …   shared app components
lib/
  trpc/                  client, server caller, query client factory
  live/                  stream manager: event → cache patch map
  state/                 small Zustand stores
shared/                  Zod schemas, DTOs, phase vocabulary, event types (used by UI and server)
```

The server side (`server/`) and the worker (`worker/`) are described in `07-code-design.md`.

### 5.3 State — what lives where

| State | Home | Why |
|---|---|---|
| Server data (workspaces, workflows, runs, approvals…) | **TanStack Query cache** (via tRPC) | Caching, dedupe, background refresh, infinite lists |
| Live changes | **Event stream → cache patches** | No polling; instant; versions prevent stale overwrites |
| Filters, tabs, selected run, log search | **URL** (nuqs) | Shareable, back/forward work, survives reload |
| Ephemeral global UI (palette open, log panel, density) | **Zustand** (tiny stores) | No provider trees, no re-render storms |
| Forms | **React Hook Form** + Zod (from contracts) | Proven, fast, works with generated fields |
| Preferences (favourites, pinned, theme) | Server (`me.preferences`) + optimistic update | Follows the user across devices |

**No Redux, no client-side database.** TanStack DB is promising but still beta; revisit at 1.0 (see `00` D2).

### 5.4 Caching policy

| Data | `staleTime` | Notes |
|---|---|---|
| Workspaces, workflows, definitions | 5 min | Changed rarely; events invalidate on change |
| Runs lists, run detail, approvals | ∞ while the live stream is connected; 15 s if disconnected | The stream keeps them fresh |
| Logs | Not cached by Query (streamed) | Completed logs cached in memory per tab |
| Refs (branches/tags) | 60 s | Searched as you type |

**Optional instant reloads:** persist the query cache to IndexedDB (TanStack Query persister), keyed by user id + build id, max age 24 h, excluding logs and admin data, wiped on sign-out. Enable after the first release if reload speed matters.

### 5.5 Event → cache patch map

| Event | Patch |
|---|---|
| `run_request.created` | Prepend to "my runs" / workspace runs lists |
| `run_request.phase_changed` / `.completed` | Update the request in detail + list caches (if `aggregateVersion` newer); move from "Running now" to "Recent" |
| `github_run.*`, `github_job.*` | Update progress rail and jobs |
| `approval.*` | Inbox and badge count; request header |
| `workflow.*`, `workspace.*` | Invalidate catalog queries |
| `workspace.grant_*`, `identity.role_changed` | Refetch `me.get`; navigate away if access was removed |

### 5.6 Optimism policy

Optimistic updates only for things that are ours and reversible (favourites, preferences, "Requested" appearing in lists the moment you submit). Never for GitHub state — the phase text tells the truth.

---

## 6. Live UX details

- **Live indicator** in the top bar: green (connected), amber (reconnecting — showing last known data), grey (offline — polling).
- **Freshness:** "confirmed N s ago" on running runs; turns amber past 2 minutes.
- **Your run finished while you were elsewhere:** in-app toast with result and a link; tab title shows `✔`/`✖`. Browser notifications: opt-in, UI-only.
- **Approvals:** sidebar badge updates live.

---

## 7. Performance budgets

| Metric | Budget |
|---|---|
| First page with data (signed in, warm server) | < 1.0 s on office network |
| Client navigation (cached) | < 100 ms |
| Input latency | < 50 ms |
| JS per route (initial) | < 180 KB gzipped |
| Log viewer | 100k lines without jank (virtualised) |

Techniques: RSC prefetch, route-level code splitting, prefetch on hover/intent, virtualised lists, streaming responses.

---

## 8. Component inventory (shadcn/ui on Base UI, in `components/ui`)

App shell · Command palette · Workflow card · Status badge (phase vocabulary) · Progress rail (jobs) · Step list · Log viewer · Run composer (schema form) · Ref picker (async combobox) · Environment segmented control · Approval card · Timeline · Grant editor (user/group picker with Entra search) · Credential health row · Budget bar · Empty states that teach ("No workflows exposed yet — Admins: expose them in Settings").

---

## 9. Quality

| Area | Approach |
|---|---|
| Accessibility | Base UI primitives; axe checks in CI; keyboard paths in Playwright; live regions for status |
| Journeys tested end-to-end | Import repo → expose workflow → grant group → user runs → approval → success; cancel while queued; re-run failed; access revoked mid-session; stream reconnect |
| Visual consistency | Playwright screenshots of key screens in light/dark |
