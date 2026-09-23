// dsh-operator-ui — the Solari sandbox execution adapter (P6A).
//
// ROLE BOUNDARY (the one this module exists to make honest): the solari-sandbox
// adapter implements the EXECUTION-WORKER role only. It runs scoped commands
// inside an isolated cloud sandbox over the official SDK, captures evidence,
// establishes execution identity, enforces resource limits, cleans up behind
// itself, and refuses — with typed codes — every capability the documented
// host does not support. It does NOT host an orchestrator: no Archon answers
// inside the sandbox until the separate live-integration deployment exists
// (P6C), so the conversation/dispatch protocol refuses solari environments at
// its own seam (lib/environments.js requireOrchestratorProtocol), never here.
//
// NO INVENTED ENDPOINTS. Everything this module assumes about the host comes
// from the officially documented SDK surface (@solarisdk/sandbox,
// docs.getsolari.com), verified live on 2026-09-21 and pinned below as
// constants: the documented base URL, the documented machine limits (cpu 1-16,
// memMb up to 65536), the rolling idle timeout with onTimeout pause|kill, the
// argv-not-shell run contract, the plan gates (402 FeatureRequiresPlan for
// custom templates, 429 ConcurrencyLimitExceeded), and the browsers-only rule
// for recording (RecordingRequiresDesktop). Nothing here constructs a URL.
//
// SECRETS. The credential is an env-var NAME configured on the environment
// (transport.tokenVar, default SOLARI_API_KEY). The VALUE is read from
// process.env at request time, handed only to the SDK client, scrubbed from
// any evidence text that echoes it, and never enters a config object, a
// receipt, a reason string, or a log.
//
// VERIFICATION. The sandbox's own report (exitCode/stdout/stderr) is the
// WORKER's claim. verifyEvidence is the operator-side independent check: it
// re-derives every hash from the captured bytes, requires a terminal status,
// requires the identity block, and requires completed cleanup — a leaked
// sandbox is an UNVERIFIED run, never a successful one. Capability-level
// objective evaluation stays in the existing RCOS verification machinery; this
// module replaces nothing.
//
// TESTS. The SDK is dynamically imported at request time — this build carries
// no Solari dependency and provisions no paid infrastructure. Offline protocol
// tests inject a client factory (setSolariClientFactory) shaped exactly like
// the documented SDK surface; results from that seam are PROTOCOL tests and do
// not certify the live host. Live certification is the separate P6B gate.

import { createHash } from 'node:crypto';
import { providerClaimVerdict } from './environments.js';

export const SOLARI_SDK_PACKAGE = '@solarisdk/sandbox';

// Documented, not invented: the SDK's own default endpoint (docs.getsolari.com).
export const SOLARI_DOCUMENTED_BASE_URL = 'https://api.getsolari.com';
export const SOLARI_TOKEN_VAR_DEFAULT = 'SOLARI_API_KEY';

// Documented machine limits (virtualization: Cloud Hypervisor microVMs).
export const SOLARI_DOCUMENTED_LIMITS = {
  cpu: { min: 1, max: 16, default: 2 },
  memMb: { min: 256, max: 65536, default: 2048 },
  timeoutMs: { min: 30000, max: 3600000, default: 1800000 }, // rolling idle window
};

// Operator budget caps — the spending bound. Defaults are the documented
// minimums, not the machine maxima: an operator may tighten these in config
// (config.solari.budgetCaps / config.solari.maxConcurrent) but nothing here
// will exceed the documented machine limits, and the default posture is the
// free-tier shape (one sandbox, smallest machine, shortest idle window).
const SOLARI_DEFAULT_BUDGET_CAPS = {
  cpu: 1,
  memMb: 1024,
  timeoutMs: 600000,
};
const SOLARI_DEFAULT_MAX_CONCURRENT = 1; // documented free-tier concurrency

// Capabilities the documented host supports in this build. Everything else is
// refused by name before any sandbox is created — a refusal must never cost
// money.
const SOLARI_SUPPORTED = {
  template: 'base', // custom templates sit behind the documented 402 FeatureRequiresPlan gate
  region: 'us-west', // the only documented region
  lifecycle: { onTimeout: 'kill' }, // forced: a paused sandbox is a leaked, still-billed machine
};

const TOKEN_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Privileged env names are never forwardable — control-plane credentials, API
// keys, tokens, secrets, session state. A privileged name listed in an
// allowlist is a dead entry: the deny fires first, always.
const PRIVILEGED_ENV_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION)/i;
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const refErr = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

// ------------------------------------------------------------- client factory

// Production path: the official SDK, dynamically imported at request time.
async function loadSdkClientFactory() {
  let mod = null;
  try {
    mod = await import(SOLARI_SDK_PACKAGE);
  } catch {
    throw refErr(
      'solari-sdk-missing',
      'the official SDK "' + SOLARI_SDK_PACKAGE + '" is not installed in this build — install it to reach the documented host; offline protocol tests inject a client factory instead',
      { package: SOLARI_SDK_PACKAGE },
    );
  }
  const Ctor = mod && (mod.SandboxClient || (mod.default && mod.default.SandboxClient));
  if (typeof Ctor !== 'function') {
    throw refErr('solari-sdk-shape', 'the installed "' + SOLARI_SDK_PACKAGE + '" does not export a SandboxClient constructor', { package: SOLARI_SDK_PACKAGE });
  }
  return (opts) => new Ctor(opts);
}

// Injectable seam for offline PROTOCOL tests only. Null restores the SDK path.
let clientFactoryOverride = null;
export function setSolariClientFactory(fn) {
  clientFactoryOverride = typeof fn === 'function' ? fn : null;
}

async function clientFactory() {
  if (clientFactoryOverride) return clientFactoryOverride;
  return loadSdkClientFactory();
}

// ---------------------------------------------------------------- readiness

function tokenVarOf(environment) {
  const t = (environment && environment.adapter && environment.adapter.transport) || {};
  const v = t.tokenVar === undefined || t.tokenVar === null || t.tokenVar === '' ? SOLARI_TOKEN_VAR_DEFAULT : t.tokenVar;
  return v;
}

// The value exists only inside this function's return path and the SDK client.
// Everything above it carries the NAME.
function solariApiKey(environment) {
  const tokenVar = tokenVarOf(environment);
  if (typeof tokenVar !== 'string' || !TOKEN_VAR_RE.test(tokenVar)) {
    throw refErr('solari-token-var-invalid', 'the configured tokenVar must be an env-var NAME — never a secret value', { tokenVar: String(tokenVar) });
  }
  const value = process.env[tokenVar];
  if (!value) {
    throw refErr(
      'solari-token-missing',
      'environment variable ' + tokenVar + ' is not set — the Solari credential is read from it at request time and is never stored, logged, or returned',
      { tokenVar },
    );
  }
  return { tokenVar, value };
}

// Readiness without executing anything: what a live attempt would find. Carries
// presence booleans only — never a credential value.
export async function solariReadiness(environment, config) {
  const tokenVar = tokenVarOf(environment);
  let sdkPresent = false;
  try {
    const mod = await import(SOLARI_SDK_PACKAGE);
    sdkPresent = !!(mod && (mod.SandboxClient || (mod.default && mod.default.SandboxClient)));
  } catch { sdkPresent = false; }
  return {
    adapter: 'solari-sandbox',
    role: 'execution-worker',
    tokenVar,
    tokenConfigured: !!process.env[tokenVar],
    sdkPackage: SOLARI_SDK_PACKAGE,
    sdkPresent,
    documentedBaseUrl: SOLARI_DOCUMENTED_BASE_URL,
    budgetCaps: budgetCaps(config),
    maxConcurrent: maxConcurrent(config),
    activeSandboxes: activeCount(),
    supportedCapabilities: { ...SOLARI_SUPPORTED },
    envAllowlist: (() => { const a = effectiveEnvAllowlist(environment, config); return { configured: a.length > 0, count: a.length }; })(),
    liveCertified: false,
    note: 'protocol-tested only — live certification is the P6B gate; every create sets a rolling idle timeout with onTimeout kill, so an orphaned sandbox is reaped by the documented idle window',
  };
}

// ------------------------------------------------------------------- budgets

function budgetCaps(config) {
  const raw = (config && config.solari && config.solari.budgetCaps) || {};
  const clamp = (v, lim) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return lim.default;
    return Math.min(Math.max(n, lim.min), lim.max);
  };
  const caps = {};
  for (const k of Object.keys(SOLARI_DOCUMENTED_LIMITS)) {
    const requested = raw[k];
    const lim = SOLARI_DOCUMENTED_LIMITS[k];
    // An operator may tighten a cap; a cap above the documented machine limit is
    // clamped, never honored.
    caps[k] = requested === undefined || requested === null ? Math.min(SOLARI_DEFAULT_BUDGET_CAPS[k], lim.max) : clamp(requested, lim);
  }
  return caps;
}

function maxConcurrent(config) {
  const raw = (config && config.solari && config.solari.maxConcurrent);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return SOLARI_DEFAULT_MAX_CONCURRENT;
  return n;
}

// The operator's solari.* config section (P6D), normalized with the file-wide
// discipline: a malformed field is REPORTED (errors) and dropped (value), never
// a boot failure, and the section never carries a credential — there is none to
// carry (the credential lives only in the env var named by the environment's
// transport.tokenVar). Unknown keys are reported and ignored.
export function normalizeSolari(raw) {
  const errors = [];
  if (raw === undefined || raw === null) return { value: null, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('solari must be an object (or null) — section dropped');
    return { value: null, errors };
  }
  const out = {};
  if (raw.budgetCaps !== undefined && raw.budgetCaps !== null) {
    if (typeof raw.budgetCaps !== 'object' || Array.isArray(raw.budgetCaps)) {
      errors.push('solari.budgetCaps must be an object (cpu/memMb/timeoutMs integers) — field dropped');
    } else {
      const caps = {};
      for (const k of ['cpu', 'memMb', 'timeoutMs']) {
        if (raw.budgetCaps[k] === undefined || raw.budgetCaps[k] === null) continue;
        const n = Number(raw.budgetCaps[k]);
        if (!Number.isInteger(n) || n < 1) {
          errors.push('solari.budgetCaps.' + k + ' must be a positive integer — field dropped (the documented clamp still applies downstream)');
        } else {
          caps[k] = n;
        }
      }
      if (Object.keys(caps).length) out.budgetCaps = caps;
    }
  }
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== null) {
    const n = Number(raw.maxConcurrent);
    if (!Number.isInteger(n) || n < 1) errors.push('solari.maxConcurrent must be an integer >= 1 — field dropped');
    else out.maxConcurrent = n;
  }
  if (raw.envAllowlist !== undefined && raw.envAllowlist !== null) {
    if (!Array.isArray(raw.envAllowlist)) {
      errors.push('solari.envAllowlist must be an array of env-var NAMEs — field dropped');
    } else {
      const names = [];
      raw.envAllowlist.forEach((n, i) => {
        if (typeof n === 'string' && TOKEN_VAR_RE.test(n)) names.push(n);
        else errors.push('solari.envAllowlist[' + i + '] is not an env-var NAME — entry dropped (names only, never values)');
      });
      if (names.length) out.envAllowlist = names;
    }
  }
  if (raw.workloadUser !== undefined && raw.workloadUser !== null) {
    if (typeof raw.workloadUser !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.workloadUser)) {
      errors.push('solari.workloadUser must be a user name or numeric uid ([A-Za-z0-9._-], 1-64 chars) — field dropped (non-root posture stays OFF rather than guessed)');
    } else {
      out.workloadUser = raw.workloadUser;
    }
  }
  for (const k of Object.keys(raw)) {
    if (!['budgetCaps', 'maxConcurrent', 'envAllowlist', 'workloadUser'].includes(k)) errors.push('solari.' + k + ' is an unknown key — ignored');
  }
  return { value: Object.keys(out).length ? out : null, errors };
}

// Normalize a requested budget against the caps. Every field is optional; every
// field that is over cap is named. A budget is validated BEFORE the readiness
// check's cheap failures and BEFORE any create — refusals are free.
export function normalizeSolariBudget(raw, config) {
  const caps = budgetCaps(config);
  const requested = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const over = [];
  const out = { template: SOLARI_SUPPORTED.template, cpu: caps.cpu, memMb: caps.memMb, timeoutMs: caps.timeoutMs, lifecycle: { ...SOLARI_SUPPORTED.lifecycle } };
  for (const k of Object.keys(caps)) {
    if (requested[k] === undefined || requested[k] === null) continue;
    const n = Number(requested[k]);
    if (!Number.isInteger(n) || n < SOLARI_DOCUMENTED_LIMITS[k].min) {
      throw refErr('solari-budget-invalid', 'budget.' + k + ' must be an integer >= ' + SOLARI_DOCUMENTED_LIMITS[k].min, { field: k, requested: requested[k] });
    }
    if (n > caps[k]) over.push({ field: k, requested: n, cap: caps[k] });
    else out[k] = n;
  }
  if (over.length) {
    throw refErr(
      'solari-budget-over-cap',
      'requested budget exceeds the operator caps (' + over.map((o) => o.field + ' ' + o.requested + ' > ' + o.cap).join(', ') + ') — raise the caps in config.solari.budgetCaps, deliberately, or run smaller',
      { over },
    );
  }
  if (requested.template !== undefined && requested.template !== SOLARI_SUPPORTED.template) {
    throw refErr(
      'solari-capability-unsupported',
      'template "' + String(requested.template) + '" is refused: only the documented built-in "' + SOLARI_SUPPORTED.template + '" template is supported — custom templates sit behind the documented 402 FeatureRequiresPlan paid-plan gate',
      { capability: 'custom-template', requested: String(requested.template) },
    );
  }
  if (requested.region !== undefined && requested.region !== SOLARI_SUPPORTED.region) {
    throw refErr('solari-capability-unsupported', 'region "' + String(requested.region) + '" is refused: "' + SOLARI_SUPPORTED.region + '" is the only documented region', { capability: 'region', requested: String(requested.region) });
  }
  if (requested.recording) {
    throw refErr('solari-capability-unsupported', 'recording is refused: recording/replay is documented for BROWSERS only (RecordingRequiresDesktop) — a sandbox run makes no proof tape', { capability: 'recording' });
  }
  if (requested.gpu) {
    throw refErr('solari-capability-unsupported', 'gpu is refused: no gpu option is documented for sandboxes', { capability: 'gpu' });
  }
  if (requested.lifecycle && requested.lifecycle.onTimeout && requested.lifecycle.onTimeout !== SOLARI_SUPPORTED.lifecycle.onTimeout) {
    throw refErr('solari-capability-unsupported', 'lifecycle.onTimeout "' + String(requested.lifecycle.onTimeout) + '" is refused: this adapter always creates with onTimeout kill — a paused sandbox is a leaked, still-billed machine', { capability: 'lifecycle-pause' });
  }
  return out;
}

// ------------------------------------------------------- capability checking

// argv only, exactly like the documented run contract: commands are NOT
// shell-interpreted, so a caller wanting a pipeline passes
// ['sh', '-c', '…'] explicitly and it is visible in the receipt.
export function normalizeSolariCommand(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.command === 'string') {
    throw refErr(
      'solari-capability-unsupported',
      'a raw shell `command` string is refused: the documented run contract takes argv (cmd + args) and argv is NOT shell-interpreted — the documented pipeline form is ["sh", "-c", "…"], which is what the receipt will show',
      { capability: 'shell-string', requested: body.command.slice(0, 80) },
    );
  }
  const argv = body && body.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw refErr('solari-argv-invalid', 'argv must be a non-empty array of strings — argv is not shell-interpreted', { received: Array.isArray(argv) ? argv.length : typeof argv });
  }
  if (argv.some((a) => typeof a !== 'string' || a.length === 0)) {
    throw refErr('solari-argv-invalid', 'every argv element must be a non-empty string', {});
  }
  if (argv.length > 64) {
    throw refErr('solari-argv-invalid', 'argv longer than 64 elements is refused', { received: argv.length });
  }
  const cwd = body.cwd === undefined || body.cwd === null ? null : String(body.cwd);
  return { argv: argv.slice(), cwd };
}

// Scoped environment: the caller names env-var NAMES; the values are read from
// THIS process at request time. Inline values are refused outright — a value in
// a request body is a value in a log.
// The server-controlled allowlist: an operator declares, per environment
// (adapter.transport.envAllowlist) or per deployment (config.solari.envAllowlist),
// which env-var NAMES a run may request. Neither channel ever carries values.
// Nothing configured means nothing is forwardable. Entries that are not valid
// env-var names are dead entries; privileged names are dead everywhere.
export function effectiveEnvAllowlist(environment, config) {
  const t = (environment && environment.adapter && environment.adapter.transport) || {};
  const raw = Array.isArray(t.envAllowlist)
    ? t.envAllowlist
    : (config && config.solari && Array.isArray(config.solari.envAllowlist)) ? config.solari.envAllowlist
    : [];
  return raw.filter((n) => typeof n === 'string' && TOKEN_VAR_RE.test(n));
}

export function scopedEnvironmentFor(body, allowlist, tokenVar) {
  const allowed = Array.isArray(allowlist) ? allowlist : [];
  // Inline values are forbidden outright — with or without envNames — so a
  // body can never smuggle a secret through the names-only lane.
  if (body && body.env !== undefined) {
    throw refErr('solari-env-values-forbidden', 'inline `env` values are forbidden — pass envNames (names only); values are read from this process at request time so no secret ever enters a request body or a log', { received: 'env' });
  }
  const names = body && body.envNames;
  if (names === undefined || names === null) return { env: {}, missing: [], refused: null };
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !TOKEN_VAR_RE.test(n))) {
    throw refErr('solari-env-names-invalid', 'envNames must be an array of env-var NAMES', {});
  }
  if (names.length > 16) throw refErr('solari-env-names-invalid', 'more than 16 env names is refused', { received: names.length });
  // The allowlist gate sits BEFORE anything is read from this process: a
  // privileged name refuses even when it is allowlisted (dead entry) and an
  // undeclared name refuses even when the variable exists here. Both refusals
  // are free — they precede readiness, the credential, and any spend.
  for (const n of names) {
    if ((tokenVar && n === tokenVar) || PRIVILEGED_ENV_RE.test(n)) {
      throw refErr('solari-env-privileged', 'env name ' + n + ' is privileged (control-plane credentials, keys, tokens, secrets, session state) and is never forwardable — the run receives only what the operator declared', { name: n });
    }
    if (!allowed.includes(n)) {
      throw refErr('solari-env-not-allowed', 'env name ' + n + ' is not on the server-controlled allowlist for this environment — the operator declares which variables a run may see', { name: n });
    }
  }
  const env = {};
  const missing = [];
  for (const n of names) {
    const v = process.env[n];
    if (v === undefined) missing.push(n);
    else env[n] = v;
  }
  return { env, missing, refused: null };
}

// ------------------------------------------------------------------ evidence

const REDACT_CAP = 1024 * 1024; // per-stream capture cap

// Scrub the credential out of any text that could echo it (an env dump, a
// shell that prints its argv). The receipt names the redaction; it never
// carries the value.
function scrubSecrets(text, credential) {
  if (!credential || !text || !String(text).includes(credential.value)) {
    return { text: text || '', redactions: 0 };
  }
  const marker = '[redacted:' + credential.tokenVar + ']';
  const parts = String(text).split(credential.value);
  return { text: parts.join(marker), redactions: parts.length - 1 };
}

// Operator-side verification: every assertion re-derived from the captured
// bytes and the recorded identity, never from a sandbox-reported "ok".
export function verifySolariEvidence(result, expect) {
  const checks = [];
  const add = (name, ok, code, detail) => checks.push(ok ? { name, ok: true } : { name, ok: false, code, detail: detail || null });

  const run = result.run || null;
  if (run && Number.isInteger(run.exitCode) && run.exitCode >= 0) {
    add('terminal-status', true);
  } else {
    add('terminal-status', false, 'verification-terminal-missing', 'no integer exit code was captured');
  }

  if (run && typeof run.stdout === 'string' && run.stdoutSha256 === sha256(run.stdout)) {
    add('stdout-integrity', true);
  } else {
    add('stdout-integrity', false, 'verification-hash-mismatch', 'the captured stdout does not hash to the recorded digest');
  }
  if (run && typeof run.stderr === 'string' && run.stderrSha256 === sha256(run.stderr)) {
    add('stderr-integrity', true);
  } else {
    add('stderr-integrity', false, 'verification-hash-mismatch', 'the captured stderr does not hash to the recorded digest');
  }

  if (result.identity && typeof result.identity.identitySha256 === 'string' && result.identity.identitySha256.startsWith('sha256:')) {
    add('identity-present', true);
  } else {
    add('identity-present', false, 'verification-identity-missing', 'no execution identity block was established');
  }

  if (result.cleanup && result.cleanup.ok === true) {
    add('cleanup-complete', true);
  } else {
    add('cleanup-complete', false, 'verification-cleanup-incomplete', 'the sandbox was not verifiably killed — a leaked sandbox is an unverified run');
  }

  const exp = expect && typeof expect === 'object' ? expect : null;
  if (exp && exp.exitStatus !== undefined) {
    const want = Number(exp.exitStatus);
    const got = run ? run.exitCode : null;
    add('expect-exit-status', got === want, 'verification-exit-mismatch', 'expected exit ' + want + ', observed ' + got);
  }
  if (exp && Array.isArray(exp.outputContains)) {
    for (const needle of exp.outputContains) {
      const hay = run ? (run.stdout || '') + (run.stderr || '') : '';
      add('expect-output-contains', typeof needle === 'string' && hay.includes(needle), 'verification-output-missing', 'expected output not present: ' + String(needle).slice(0, 80));
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    verified: failed.length === 0,
    checks,
    code: failed.length ? failed[0].code : null,
    reason: failed.length ? failed[0].detail : 'every integrity, identity, cleanup and expectation check passed',
  };
}

// ------------------------------------------------------- execution identity

// Same convention as the orchestrator-run identity (lib/environments.js): a
// witness hash of the tuple that was actually recorded. It is evidence that
// THIS operator recorded THIS tuple — not proof of which physical machine
// ran the bytes; the provider claim comparison below is the cross-check that
// exists for that.
// P6D: the 10-tuple is built from an IDENTITY-SHAPED record so the write path
// (solariExecutionIdentity, in this file) and the goal-side re-derivation (the
// bridge receipt verifier) cannot drift — one construction, two callers. The
// verifier receives the stored identity object straight from the receipt file.
export function solariExecutionTuple(i) {
  return [
    i.environmentId,
    i.orchestrator ? i.orchestrator.id : null,
    i.orchestrator && i.orchestrator.adapter !== undefined ? i.orchestrator.adapter : null,
    i.providerDeclared,
    i.source === undefined ? null : i.source,
    i.sandboxId === undefined ? null : i.sandboxId,
    i.argvSha256,
    i.startedAt === undefined ? null : i.startedAt,
    i.finishedAt === undefined ? null : i.finishedAt,
    i.providerClaim ? i.providerClaim.claimed : null,
  ];
}

export function solariExecutionIdentity({ environment, sandboxId, argv, source, startedAt, finishedAt, providerClaim, config }) {
  const claim = providerClaim === undefined || providerClaim === null || providerClaim === '' ? null : String(providerClaim);
  const verdict = providerClaimVerdict({ environment, claim, config });
  const argvSha = sha256(JSON.stringify(argv));
  const identity = {
    contract: 1,
    role: 'execution-worker',
    environmentId: environment.environmentId,
    kind: environment.kind,
    orchestrator: environment.orchestrator ? { ...environment.orchestrator } : { id: null, adapter: environment.adapter.kind },
    providerDeclared: environment.providerId,
    providerClaim: verdict,
    source: source || null,
    sandboxId: sandboxId || null,
    argvSha256: argvSha,
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
  };
  identity.identitySha256 = sha256(JSON.stringify(solariExecutionTuple(identity)));
  return identity;
}

// -------------------------------------------------------------------- runner

let activeRuns = 0;
const activeCount = () => activeRuns;
const liveHandles = new Map(); // sandboxId → handle, for explicit kill ops this process

// Installed SDK @solarisdk/sandbox 0.1.3: create/connect/kill are DIRECT
// SandboxClient methods (README: `const sandboxes = new SandboxClient(...);
// await sandboxes.create()`) — there is no `.sandboxes` namespace on the
// client object itself.
function assertClientShape(client) {
  const ok = client
    && typeof client.create === 'function'
    && typeof client.connect === 'function'
    && typeof client.kill === 'function';
  if (!ok) throw refErr('solari-sdk-shape', 'the client does not expose the documented create/connect/kill surface (SandboxClient 0.1.x)', {});
}

async function withTimeout(promise, ms, code, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(refErr(code, message, {})), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Best-effort death check: a killed sandbox no longer accepts commands. A probe
// that throws (or times out) is a dead sandbox; a probe that ANSWERS is a leak.
async function verifyDead(handle) {
  try {
    await withTimeout(handle.commands.run('true', {}), 3000, 'solari-dead-probe-timeout', 'death probe timed out');
    return false; // it answered — it is alive
  } catch {
    return true; // refused, errored, or timed out — the control channel is gone
  }
}

async function cleanupSandbox(handle, credential) {
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    try {
      await handle.kill(); // documented idempotent; the cookbook kills, not closes
      attempts.push({ attempt: i + 1, ok: true });
      break;
    } catch (e) {
      attempts.push({ attempt: i + 1, ok: false, error: scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 160) });
    }
  }
  const dead = await verifyDead(handle);
  const ok = dead === true;
  return {
    ok,
    dead,
    sandboxId: handle.id || null,
    attempts,
    code: ok ? null : 'solari-cleanup-incomplete',
    reason: ok
      ? 'kill() accepted and a post-kill command probe could not reach the sandbox'
      : 'kill() did not produce a dead sandbox — the post-kill command probe still answers; this run is UNVERIFIED and sandbox ' + String(handle.id) + ' is reported as leaked (the rolling idle timeout with onTimeout kill is the backstop)',
  };
}

// The scoped execution path: normalize → refuse free → readiness → budget →
// create (kill-on-idle) → connect → run(argv) → capture + scrub evidence →
// artifacts → kill + verify dead → independent verification. Every failure
// after create attempts cleanup and reports it. The credential value exists
// only between solariApiKey() and the client constructor.
export async function executeScoped(request) {
  const { environment, config, reason, expect, artifactPaths } = request;
  const body = request;

  const source = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
  if (!source) {
    return refused('solari-reason-required', 'a `reason` is required — every execution records why it happened', {});
  }

  let command;
  try {
    command = normalizeSolariCommand(body);
  } catch (e) {
    return refused(e.code, e.message, e.details);
  }

  const envAllowlist = effectiveEnvAllowlist(environment, config);
  let scoped;
  try {
    scoped = scopedEnvironmentFor(body, envAllowlist, tokenVarOf(environment));
  } catch (e) {
    return refused(e.code, e.message, e.details);
  }

  let budget;
  try {
    budget = normalizeSolariBudget(body.budget, config);
  } catch (e) {
    return refused(e.code, e.message, e.details);
  }

  const maxConc = maxConcurrent(config);
  if (activeRuns >= maxConc) {
    return refused('solari-concurrency-limit', 'already at the operator concurrency cap (' + activeRuns + '/' + maxConc + ') — the documented host 429s above the plan limit; this adapter refuses BEFORE spending', { active: activeRuns, maxConcurrent: maxConc });
  }

  // Readiness is checked AFTER the free refusals and BEFORE anything costs.
  let credential;
  try {
    credential = solariApiKey(environment);
  } catch (e) {
    return refused(e.code, e.message, e.details);
  }
  const factory = await clientFactory().catch((e) => { throw e; });

  activeRuns += 1;
  const startedAt = new Date().toISOString();
  const result = {
    ok: false,
    code: null,
    reason: null,
    run: null,
    identity: null,
    cleanup: null,
    verification: null,
    budget,
  };
  let handle = null;
  try {
    let client;
    try {
      client = await factory({ apiKey: credential.value, baseUrl: SOLARI_DOCUMENTED_BASE_URL });
      assertClientShape(client);
    } catch (e) {
      if (e && e.code) return finish(refused(e.code, e.message, e.details));
      return finish(refused('solari-sdk-shape', 'client construction failed: ' + scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 200), {}));
    }

    try {
      handle = await client.create({
        template: budget.template,
        cpu: budget.cpu,
        memMb: budget.memMb,
        timeoutMs: budget.timeoutMs,
        lifecycle: { ...budget.lifecycle },
      });
    } catch (e) {
      return finish(providerRefusal(e, credential));
    }
    if (handle && handle.id) liveHandles.set(handle.id, handle);

    try {
      await withTimeout(handle.connect(), 30000, 'solari-connect-timeout', 'connect() did not settle within 30s');
    } catch (e) {
      return finish(await failAfterCreate(e.code || 'solari-connect-failed', 'connect failed: ' + scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 200), e.details));
    }

    // P6D Finding 3 (non-root posture): when config.solari.workloadUser declares
    // the honored user switch, PROVE it lands non-root BEFORE the workload runs.
    // The probe measures the EFFECTIVE uid (`id -u`) as that user: uid 0 — or any
    // measurement that cannot prove a positive non-root uid — refuses typed and
    // the workload command is never issued. Root fallback is never taken.
    const workloadUser = config && config.solari && typeof config.solari.workloadUser === 'string' && config.solari.workloadUser !== '' ? config.solari.workloadUser : null;
    let posture = null;
    if (workloadUser) {
      let probeUid = null;
      let probeText = '';
      try {
        const probeRaw = await withTimeout(
          handle.commands.run('id', { args: ['-u'], user: workloadUser }),
          30000,
          'solari-probe-timeout',
          'the non-root posture probe did not settle within 30s',
        );
        probeText = String((probeRaw && probeRaw.stdout) || '').trim();
        probeUid = /^\d+$/.test(probeText) ? Number(probeText) : null;
      } catch (e) {
        return finish(await failAfterCreate('solari-non-root-required', 'posture probe could not measure a non-root uid (' + scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 160) + ') — root fallback is never taken', { workloadUser }));
      }
      if (probeUid === null || probeUid < 1) {
        return finish(await failAfterCreate('solari-non-root-required', 'posture probe measured uid ' + (probeText === '' ? '(empty)' : JSON.stringify(probeText.slice(0, 32))) + ' under honored user switch ' + JSON.stringify(workloadUser) + ' — the workload never runs as root', { workloadUser, uidMeasured: probeUid }));
      }
      posture = { user: workloadUser, uid: probeUid, probe: 'id -u', measuredAt: new Date().toISOString() };
    }

    const runStartedAt = new Date().toISOString();
    // The key only exists when a posture was declared, so the non-posture run
    // options stay byte-identical to every pre-P6D run.
    const runOpts = { args: command.argv.slice(1), cwd: command.cwd || undefined, env: Object.keys(scoped.env).length ? scoped.env : undefined };
    if (workloadUser) runOpts.user = workloadUser;
    let raw;
    try {
      raw = await withTimeout(
        handle.commands.run(command.argv[0], runOpts),
        SOLARI_DOCUMENTED_LIMITS.timeoutMs.max,
        'solari-run-timeout',
        'the command exceeded the documented maximum idle window without a terminal status',
      );
    } catch (e) {
      return finish(await failAfterCreate(e.code || 'solari-run-failed', 'run failed: ' + scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 200), e.details));
    }
    const finishedAt = new Date().toISOString();

    const stdout = scrubSecrets(cap(raw && raw.stdout), credential);
    const stderr = scrubSecrets(cap(raw && raw.stderr), credential);

    const artifacts = [];
    let artifactNote = null;
    if (Array.isArray(artifactPaths)) {
      if (artifactPaths.length > 10) return finish(await failAfterCreate('solari-artifacts-invalid', 'more than 10 artifact paths is refused', {}));
      for (const p of artifactPaths.slice(0, 10)) {
        if (typeof p !== 'string' || !p.trim()) continue;
        try {
          const text = await withTimeout(handle.files.readText(p), 15000, 'solari-artifact-timeout', 'artifact read timed out');
          const capped = scrubSecrets(cap(text), credential);
          artifacts.push({ path: p, sha256: sha256(capped.text), bytes: capped.text.length, truncated: cap(text).length < String(text ?? '').length, redactions: capped.redactions });
        } catch (e) {
          artifacts.push({ path: p, error: scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 160) });
        }
      }
      artifactNote = 'artifacts are captured as sha256 digests over the retrieved bytes — the digest is the evidence, not the sandbox\'s claim about the file';
    }

    result.run = {
      argv: command.argv,
      cwd: command.cwd,
      exitCode: typeof (raw && raw.exitCode) === 'number' ? raw.exitCode : null,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutSha256: sha256(stdout.text),
      stderrSha256: sha256(stderr.text),
      redactions: stdout.redactions + stderr.redactions,
      stdoutTruncated: stdout.text.length === REDACT_CAP,
      startedAt: runStartedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(runStartedAt),
      envMissing: scoped.missing,
    };
    result.identity = solariExecutionIdentity({ environment, sandboxId: handle && handle.id ? handle.id : null, argv: command.argv, source, startedAt: runStartedAt, finishedAt, providerClaim: raw && raw.execution_provider, config });
    // P6D: the measured posture travels with the run evidence (and into the
    // bridge receipt) — a claim about who executed includes who it ran AS.
    result.posture = posture;
    if (artifacts.length || artifactNote) result.artifacts = { items: artifacts, ...(artifactNote ? { note: artifactNote } : {}) };
    result.ok = true;
    result.code = null;
    result.reason = 'command ran to a terminal status inside sandbox ' + String(handle && handle.id);

    return finish(result);
  } catch (e) {
    return finish(refused((e && e.code) || 'solari-internal', scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 300), (e && e.details) || {}));
  } finally {
    if (handle && handle.id) liveHandles.delete(handle.id);
    activeRuns -= 1;
  }

  async function failAfterCreate(code, message, details) {
    const r = refused(code, message, details);
    r.cleanup = await cleanupSandbox(handle, credential);
    return r;
  }

  function finish(r) {
    // Cleanup on the success path, then the independent verification pass over
    // the captured evidence. A refusal that never ran verifies nothing: the
    // verification block exists to judge evidence, not to pad refusals.
    const done = (async () => {
      if (handle) {
        r.cleanup = r.cleanup || (await cleanupSandbox(handle, credential));
        if (r.cleanup.ok && r.run) r.reason = (r.reason ? r.reason + ' — ' : '') + 'sandbox killed and death verified';
      }
      if (r.run) {
        r.verification = verifySolariEvidence(r, expect);
      }
      return r;
    })();
    return done;
  }
}

function cap(text) {
  const s = text === undefined || text === null ? '' : String(text);
  return s.length > REDACT_CAP ? s.slice(0, REDACT_CAP) : s;
}

function refused(code, reason, details) {
  return { ok: false, code, reason, details: details || {}, run: null, identity: null, cleanup: null, verification: null, budget: null };
}

// Provider-side errors map to typed codes from the DOCUMENTED gate list — the
// adapter knows 402 FeatureRequiresPlan and 429 ConcurrencyLimitExceeded by
// name, and treats anything else as an untyped provider failure.
function providerRefusal(e, credential) {
  const status = e && (e.status || e.statusCode);
  const codeName = e && (e.code || e.errorCode);
  const msg = scrubSecrets(String((e && e.message) || e), credential).text.slice(0, 200);
  if (status === 402 || codeName === 'FeatureRequiresPlan') {
    return refused('solari-plan-gated', 'the documented host answered 402 FeatureRequiresPlan — this capability sits behind a paid plan and this build does not provision paid infrastructure', { providerCode: 'FeatureRequiresPlan' });
  }
  if (status === 429 || codeName === 'ConcurrencyLimitExceeded') {
    return refused('solari-concurrency-limit', 'the documented host answered 429 ConcurrencyLimitExceeded — the plan\'s concurrent-sandbox limit is already in use', { providerCode: 'ConcurrencyLimitExceeded' });
  }
  return refused('solari-create-rejected', 'sandbox create rejected: ' + msg, { providerStatus: status || null, providerCode: codeName || null });
}

// Explicit kill op for an active handle in THIS process. Statelessness is the
// honest position: after a restart this process cannot name the sandbox, and
// the documented rolling idle timeout with onTimeout kill is the reap.
export async function killScoped({ environment, sandboxId }) {
  if (!sandboxId || typeof sandboxId !== 'string') return refused('solari-sandbox-unknown', 'sandboxId required', {});
  const handle = liveHandles.get(sandboxId);
  if (!handle) {
    return refused('solari-sandbox-unknown', 'no live sandbox "' + sandboxId + '" in this process — after a restart the documented rolling idle timeout (onTimeout kill) is the reap', { sandboxId, tracked: [...liveHandles.keys()] });
  }
  let credential = null;
  try { credential = solariApiKey(environment); } catch { /* kill needs no credential against the local handle's control channel */ }
  const cleanup = await cleanupSandbox(handle, credential);
  liveHandles.delete(sandboxId);
  return { ok: cleanup.ok, code: cleanup.code, reason: cleanup.reason, cleanup, budget: null, run: null, identity: null, verification: null };
}
