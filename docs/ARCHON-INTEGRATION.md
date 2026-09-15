# Archon integration — the workflow layer of RCOS inside DSH

Goal: make Chow/Archon workflow runs a **first-class, watchable layer** of the
DSH operator UI — without parsing chat text and without duplicating Archon
state. Archon stays the single source of truth for workflow execution; this
plugin is a read-only window onto it, plus (later) gated verbs.

## Authoritative sources (verified live on the production host)

| Source | What it gives | Freshness |
|---|---|---|
| Archon HTTP API `:3090` (`/api/workflows`, `/api/workflows/runs`, `/api/workflows/runs/{id}`, `/api/runs/{id}/artifacts`) | catalog, run records (status, current step, model bindings) | seconds |
| `archon.db` (SQLite+WAL): `remote_agent_workflow_runs/_events/_node_sessions` | same, relational; for heavy queries later | seconds |
| Run artifacts `~/.archon/workspaces/.../artifacts/runs/<id>/` | `RECEIPT.json` (**ship / fix / blocked**), `EVAL.json`, `CHOW_CONTEXT.json`, reports | per node-completion |
| ESR journals (`internal-work/event-sourced-runtime`) | designed uniform event schema — **not yet populated**; adopt when it lands, don't build a rival | — |

The DSH host and Archon run on the same machine in production, so the plugin's
host half proxies the API directly (no CORS, no tunnel from the browser).

## Phases

### W1 — read-only visibility (this release)

- Host route `GET /plugins/operator-ui/archon?op=catalog|runs|run&id=…` —
  thin proxy to `$DSH_OPERATOR_UI_ARCHON` (default `http://127.0.0.1:3090`),
  5 s timeout, honest `{ok:false, unreachable:true}` degradation.
- **Workflows tab**: catalog (searchable name/description) + recent runs
  (status chips: running / completed / failed) + run detail (step index,
  message, model bindings, receipt decision when present).
- 10 s poll while the tab is mounted; manual refresh; zero persistence.
- Sandbox verification runs against `scripts/mock-archon.mjs` — a tiny fake
  Archon with the same routes (default port `13090`, deliberately NOT the real
  `:3090`, so the mock can never collide with production). Real-dev-host
  verification is a checklist, not a code change: point
  `DSH_OPERATOR_UI_ARCHON` at the mock port for sandbox, at `:3090` for the
  real host, and compare against `archon workflow runs`.

### W2 — agent verbs (gated)

- `workflow_run` / `workflow_status` / `workflow_artifacts` DSH tools
  (`defineTool`) so DSH agents get first-class workflow verbs instead of
  shelling out to `archon` CLI. Run-triggering must be behind an explicit
  config flag (`"allowRun": true` in the plugin row config) — default OFF.
- SSE push of run state changes instead of client polling (host proxies the
  Archon event stream; one upstream connection, fanned out to viewers).

### W3 — the full RCOS loop

- Node-level state per run (the `_node_sessions` tables) rendered as a step
  timeline.
- Correlation: DSH session ↔ Archon run (the conversation id is already in
  run records) — "this chat spawned these runs".
- Adopt the ESR journal envelope as the uniform event schema once populated;
  receipts (`ship/fix/blocked`) become first-class chips on Runs and Summary.

## Security / ops rules

- Read-only by default; the proxy never POSTs to Archon in W1.
- dev-host is single-writer: the plugin only ever reads Archon state and run dirs.
- Archon unreachable must always render as an honest, quiet panel — never a
  crash, never fake data.
