# Solari SDK inspection — P6B preparation artifact

Scope: GPT P6A ruling, SECOND directive, clause 1 — "Install and pin the official
Solari SDK in the isolated development environment. Inspect the installed SDK's
actual method signatures and confirm that the adapter uses supported operations."

No live sandbox was created and no network call was made for this inspection.
Everything below was established by reading the installed package's TypeScript
declarations and by runtime-probing the exported classes with a dummy key
(constructors and static shape only — no requests issued).

## Package identity

| Fact | Value |
| --- | --- |
| Package | `@solarisdk/sandbox` |
| Version | **0.1.3** (pinned exact in `package.json`, no `^`) |
| Dependency | `@solarisdk/core ^0.1.3` (resolved 0.1.3) |
| License | Apache-2.0 |
| Maintainer | pinetreeresearch (npm registry) |
| Install size | 20 packages added, 0 vulnerabilities |

## Actual method surface (runtime-probed)

`SandboxClient` own enumerable/inherited methods, as printed by the probe:

```
constructor, create, createDesktop, createRaw, connect, get, list, listAll,
kill, listSnapshots, getSnapshot, deleteSnapshot, promoteSnapshot, hooks, handleConfig
```

Key signatures, from `dist/*.d.ts` of the installed copies:

- `new SandboxClient({ apiKey: string, baseUrl: string, fetch?, callTimeoutMs? })`
  — **direct methods, no `.sandboxes` namespace**. README usage confirms:
  `const sandboxes = new SandboxClient(...); await sandboxes.create();`
- `create(opts?: CreateSandboxOptions): Promise<Sandbox>` where the options are
  `{ template?, cpu?, memMb?, diskGb?, envs?, metadata?, timeoutMs?, fromSnapshot?,
  lifecycle?: { onTimeout, autoResume? }, volumes? }`.
- `connect(sandboxId): Promise<Sandbox>` (re-attach), `kill(sandboxId): Promise<void>`
  (idempotent DELETE), `get`, `list`, `listAll`.
- `Sandbox extends SessionHandle`; `sandboxId` is an alias of `id`.
- `SessionHandle.commands.run(cmd: string, opts?: CommandOptions): Promise<CommandResult>`
  with `CommandOptions = { args?: string[], cwd?, env?: Record<string,string>,
  user?, timeoutMs?, background?, onStdout?, onStderr? }` and
  `CommandResult = { exitCode, stdout, stderr }`.
  Doc text: "the guest runs `cmd` with these [args], NOT via a shell. For shell
  syntax use `run(\"sh\", { args: [\"-c\", \"…\"] })`."
- `SessionHandle.files.readText(path): Promise<string>` — used by the adapter's
  artifact fetch.
- `SessionHandle.kill(): Promise<void>` — idempotent destroy (the handle-level
  form the adapter uses post-run); `SessionHandle.close()` only closes the local
  control channel and does NOT release the remote session.
- `SessionHandle.connect()` opens the control WebSocket, idempotent.

## Typed error taxonomy (runtime-verified)

`SolariError` base; `GatewayError { status, code?, body? }`; `AuthError` (401);
`PlanError` (402, code `FeatureRequiresPlan`); `ConcurrencyLimitError` (429, code
`ConcurrencyLimitExceeded`); `NoCapacityError` (503); `ActionError`; `TimeoutError`;
`ConnectionError`; `mapGatewayError` maps raw HTTP errors onto these.

Probe output against the installed classes:

```
PlanError is GatewayError subclass: true
ConcurrencyLimitError status: 429
PlanError status: 402
```

The adapter's `providerRefusal` reads `e.status || e.statusCode` and
`e.code || e.errorCode` — both work against the real typed errors **unchanged**:
402/FeatureRequiresPlan → `solari-plan-gated`, 429/ConcurrencyLimitExceeded →
`solari-concurrency-limit`, anything else → untyped refusal (scrubbed).

## Reconciliation performed (adapter assumptions vs. installed reality)

| # | Adapter assumption (pre-P6B) | Installed SDK 0.1.3 reality | Change made |
| --- | --- | --- | --- |
| 1 | `client.sandboxes.create(...)` namespace | Direct `client.create(...)` — no `.sandboxes` property on the client | create/kill now call direct methods; `assertClientShape` checks `create`/`connect`/`kill` functions on the client itself |
| 2 | `handle.commands.run(argvArray, …)` array-first | Documented `(cmd: string, { args })` form | run uses `commands.run(command.argv[0], { args: command.argv.slice(1), cwd, env })`; argv-only contract preserved (SDK passes args to the program, never a shell) |
| 3 | Post-kill liveness probe shape | Probes must go through `commands.run` | Death probe is `handle.commands.run('true', {})` — the documented no-op argv |

## Adapter assumptions confirmed correct (no change)

- `create({ template, cpu, memMb, timeoutMs, lifecycle: { onTimeout: 'kill' } })`
  matches `CreateSandboxOptions`/`SandboxLifecycle` exactly.
- Client construction `{ apiKey: credential.value, baseUrl: SOLARI_DOCUMENTED_BASE_URL }`
  matches `SandboxClientOptions` (key stays server-side; base URL is the
  documented endpoint constant, not account-specific).
- `connect(sandboxId)` re-attach, `files.readText` artifact fetch, `kill()`
  idempotency, 402/429 status mapping (above).
- **No provider/execution-identity field exists anywhere in the SDK response
  types** (`CreateSandboxResponse`, `SandboxView`). A live run therefore
  records `providerClaim: null` and `providerClaimVerdict` reports
  `{ status: 'not-claimed', ok: true, … }` — the honest outcome; nothing is
  asserted, so nothing can be violated. Claim matching stays exercised at the
  protocol level by the existing tests.

## What this artifact does NOT cover

- Any live execution (P6B gate is HOLD pending Adam's authorized account,
  server-side credential configuration, and explicit spending cap).
- The portable RCOS kernel subset manifest, runtime inventory, secret scan,
  exact commands, and verification procedure — separate prep artifact, next.
