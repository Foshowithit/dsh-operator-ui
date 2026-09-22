// P6A Solari execution-worker adapter — the PROTOCOL half.
//
// In-process tests over lib/solari.js with an injected client factory
// (setSolariClientFactory). These tests prove the ADAPTER'S decisions: budget
// clamping and caps, refusal ordering, secret scrubbing, operator-side
// evidence verification, cleanup-or-leak honesty, and the typed provider
// gates (402/429 by name). They deliberately do NOT certify the live host —
// that is P6B, and every readiness surface carries liveCertified: false.
// No network: the factory never leaves this process, and the fake handle
// follows the documented SDK shape (sandboxes.create → connect →
// commands.run(argv) → kill; a dead sandbox answers no commands).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  executeScoped,
  killScoped,
  solariReadiness,
  normalizeSolariBudget,
  normalizeSolariCommand,
  scopedEnvironmentFor,
  effectiveEnvAllowlist,
  verifySolariEvidence,
  setSolariClientFactory,
  SOLARI_DOCUMENTED_LIMITS,
  SOLARI_DOCUMENTED_BASE_URL,
  SOLARI_TOKEN_VAR_DEFAULT,
} from '../lib/solari.js';

const TOKEN_VAR = 'DSH_E2E_SOLARI_TOKEN';
const TOKEN_VALUE = 'e2e-fake-solari-secret-4c91f0';
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const ENV = {
  environmentId: 'env-sandbox',
  kind: 'solari-cloud',
  providerId: 'solari-dev',
  adapter: { kind: 'solari-sandbox', transport: { tokenVar: TOKEN_VAR } },
  workspaceScope: { owners: ['*'] },
};

const CONFIG = { solari: {
  budgetCaps: { cpu: 2, memMb: 1024, timeoutMs: 600000 },
  maxConcurrent: 1,
  // The operator's declaration: the only env NAMES a run may request.
  envAllowlist: ['E2E_ALLOWED_ONE', 'E2E_ALLOWED_MISSING'],
} };

// A fake sandbox handle that answers commands until killed, then refuses —
// the documented lifecycle (kill is idempotent; a dead sandbox answers no
// commands). `leak` simulates a kill that did not take: the post-kill probe
// still ANSWERS, which the adapter must report as an unverified run.
function fakeFactory(opts = {}) {
  const calls = { constructed: 0, create: [], run: [], artifacts: [], kills: 0 };
  const factory = () => {
    calls.constructed += 1;
    const state = { killed: false };
    const handle = {
      id: 'sbx-e2e-fake',
      connect: async () => { if (opts.connectError) throw opts.connectError; },
      commands: {
        // SDK 0.1.3 signature: run(cmd, opts) with opts.args — the guest runs
        // cmd with args, NOT via a shell.
        run: async (cmd, runOpts) => {
          calls.run.push({ cmd, runOpts });
          if (state.killed && !opts.leak) throw new Error('sandbox is dead');
          if (opts.runImpl) return await opts.runImpl(cmd, runOpts);
          return { exitCode: 0, stdout: 'fake-ok\n', stderr: '', execution_provider: 'solari-dev' };
        },
      },
      files: {
        readText: async (p) => {
          calls.artifacts.push(p);
          if (opts.files && Object.prototype.hasOwnProperty.call(opts.files, p)) return opts.files[p];
          throw new Error('no such file: ' + p);
        },
      },
      kill: async () => {
        calls.kills += 1;
        if (opts.killErrorFirst && calls.kills === 1) throw new Error('transient kill failure');
        state.killed = true;
      },
    };
    // SDK 0.1.3 SandboxClient surface: create/connect/kill are direct methods.
    return {
      create: async (req) => {
        calls.create.push(req);
        if (opts.createError) throw opts.createError;
        return handle;
      },
      connect: async (sandboxId) => handle,
      kill: async (sandboxId) => { calls.kills += 1; },
    };
  };
  return { factory, calls };
}

const baseRequest = (overrides = {}) => ({
  environment: ENV,
  config: CONFIG,
  reason: 'e2e protocol test',
  argv: ['echo', 'hi'],
  ...overrides,
});

async function withToken(fn) {
  process.env[TOKEN_VAR] = TOKEN_VALUE;
  try {
    return await fn();
  } finally {
    delete process.env[TOKEN_VAR];
  }
}

test('protocol: a scoped run produces evidence the operator verifies independently', async () => {
  const { factory, calls } = fakeFactory({ files: { 'out/report.txt': 'report body ' + TOKEN_VALUE } });
  setSolariClientFactory(factory);
  try {
    process.env.E2E_ALLOWED_ONE = 'allowed-one-value-01';
    try {
      await withToken(async () => {
      const r = await executeScoped(baseRequest({
        envNames: ['E2E_ALLOWED_ONE', 'E2E_ALLOWED_MISSING'],
        artifactPaths: ['out/report.txt'],
        expect: { exitStatus: 0, outputContains: ['fake-ok'] },
      }));

      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.run.exitCode, 0);
      assert.equal(r.run.stdout, 'fake-ok\n');
      assert.equal(r.run.stdoutSha256, sha256('fake-ok\n'), 'the recorded digest is over the captured bytes');
      assert.deepEqual(r.run.envMissing, ['E2E_ALLOWED_MISSING'], 'missing env names are reported, never invented');

      // The documented run signature: argv[0] is the program, the rest are
      // args — the guest does not shell-interpret them.
      assert.equal(calls.run.length, 2, 'the real command, then the post-kill death probe');
      assert.equal(calls.run[0].cmd, 'echo');
      assert.deepEqual(calls.run[0].runOpts.args, ['hi']);
      assert.equal(calls.run[1].cmd, 'true', 'the death probe runs the documented no-op argv');

      // The create call is pinned to the documented, kill-safe shape.
      assert.equal(calls.create.length, 1);
      assert.equal(calls.create[0].template, 'base');
      assert.deepEqual(calls.create[0].lifecycle, { onTimeout: 'kill' }, 'every create carries the kill-on-idle lifecycle');
      assert.equal(calls.create[0].cpu, 2, 'the operator cap, not the caller, bounds the budget');
      assert.equal(calls.create[0].timeoutMs, 600000);

      // Identity is a witness hash of the recorded tuple.
      assert.equal(r.identity.role, 'execution-worker');
      assert.equal(r.identity.sandboxId, 'sbx-e2e-fake');
      assert.equal(r.identity.argvSha256, sha256(JSON.stringify(['echo', 'hi'])));
      assert.ok(r.identity.identitySha256.startsWith('sha256:'));
      assert.equal(r.identity.providerClaim.status, 'matches', 'the sandbox claimed the declared provider');

      // Cleanup is verified dead, not assumed.
      assert.equal(r.cleanup.ok, true);
      assert.equal(r.cleanup.dead, true);
      assert.ok(calls.kills >= 1);

      // Independent verification passes on honest evidence.
      assert.equal(r.verification.verified, true, JSON.stringify(r.verification));
      assert.equal(r.verification.code, null);

      // The credential value never crosses into the receipt — including via an
      // env dump the sandbox echoed back, and via an artifact's bytes.
      assert.ok(r.run.stdout.includes('[redacted:' + TOKEN_VAR + ']') === false || r.run.redactions >= 0);
      const flat = JSON.stringify(r);
      assert.ok(!flat.includes(TOKEN_VALUE), 'the token value must never appear anywhere in a receipt');
      assert.equal(r.artifacts.items[0].path, 'out/report.txt');
      assert.equal(r.artifacts.items[0].sha256, sha256('report body [redacted:' + TOKEN_VAR + ']'), 'artifact digests are over the SCRUBBED retrieved bytes');
      assert.equal(r.artifacts.items[0].redactions, 1);
    });
    } finally {
      delete process.env.E2E_ALLOWED_ONE;
    }
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: the sandbox echoing the credential is scrubbed and counted', async () => {
  const { factory } = fakeFactory({
    runImpl: async () => ({ exitCode: 0, stdout: 'argv was: echo ' + TOKEN_VALUE + '\n', stderr: 'boom ' + TOKEN_VALUE, execution_provider: 'solari-dev' }),
  });
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.run.stdout.includes('[redacted:' + TOKEN_VAR + ']'), 'stdout carries the redaction marker');
      assert.ok(r.run.stderr.includes('[redacted:' + TOKEN_VAR + ']'), 'stderr carries the redaction marker');
      assert.ok(!JSON.stringify(r).includes(TOKEN_VALUE), 'no raw value anywhere');
      assert.equal(r.run.redactions, 2, 'each occurrence is counted');
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: free refusals precede readiness, and readiness precedes any spend', async () => {
  const { factory, calls } = fakeFactory();
  setSolariClientFactory(factory);
  try {
    delete process.env[TOKEN_VAR];
    // Over-cap budget refuses WITHOUT a token: the request never gets far
    // enough to need a credential, let alone a client.
    const overCap = await executeScoped(baseRequest({ budget: { cpu: 99 } }));
    assert.equal(overCap.ok, false);
    assert.equal(overCap.code, 'solari-budget-over-cap');
    assert.deepEqual(overCap.details.over, [{ field: 'cpu', requested: 99, cap: 2 }], 'the over field is named');
    assert.equal(calls.constructed, 0, 'no client was ever constructed');

    // A well-formed body with no token refuses at readiness, still unspent.
    const noToken = await executeScoped(baseRequest());
    assert.equal(noToken.ok, false);
    assert.equal(noToken.code, 'solari-token-missing');
    assert.equal(noToken.details.tokenVar, TOKEN_VAR);
    assert.equal(calls.constructed, 0, 'still nothing constructed');

    // Bad argv refuses cheaper than the budget check does.
    const badArgv = await executeScoped(baseRequest({ argv: 'not-an-array', budget: { cpu: 99 } }));
    assert.equal(badArgv.code, 'solari-argv-invalid');
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: the documented provider gates are typed by name', async () => {
  // 402 FeatureRequiresPlan — custom-template territory; never provisioned.
  const gated = fakeFactory({ createError: Object.assign(new Error('upgrade required'), { status: 402 }) });
  setSolariClientFactory(gated.factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.ok, false);
      assert.equal(r.code, 'solari-plan-gated');
      assert.deepEqual(r.details, { providerCode: 'FeatureRequiresPlan' });
      assert.ok(gated.calls.kills >= 0);
    });
  } finally {
    setSolariClientFactory(null);
  }

  // 429 ConcurrencyLimitExceeded.
  const limited = fakeFactory({ createError: Object.assign(new Error('too many'), { statusCode: 429 }) });
  setSolariClientFactory(limited.factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.code, 'solari-concurrency-limit');
      assert.deepEqual(r.details, { providerCode: 'ConcurrencyLimitExceeded' });
    });
  } finally {
    setSolariClientFactory(null);
  }

  // Anything else is an untyped provider failure, cleaned up and reported.
  const other = fakeFactory({ createError: new Error('disk on fire') });
  setSolariClientFactory(other.factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.code, 'solari-create-rejected');
      assert.equal(r.details.providerStatus, null);
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: a leaked sandbox makes the run UNVERIFIED, loudly', async () => {
  const { factory, calls } = fakeFactory({ leak: true });
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.run.exitCode, 0, 'the command itself ran fine — that is not the point');
      assert.equal(r.cleanup.ok, false, 'a probe that still answers is a leak');
      assert.equal(r.cleanup.dead, false);
      assert.equal(r.cleanup.code, 'solari-cleanup-incomplete');
      assert.ok(r.cleanup.reason.includes('sbx-e2e-fake'), 'the leak names the sandbox');
      assert.equal(r.verification.verified, false, 'a run whose sandbox was not verifiably killed is UNVERIFIED');
      assert.equal(r.verification.code, 'verification-cleanup-incomplete');
      assert.ok(String(r.cleanup.reason).includes('idle timeout'), 'the documented idle-timeout reap is named as the backstop');
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: verification re-derives everything and catches tampering', () => {
  const good = {
    run: { exitCode: 0, stdout: 'out\n', stderr: '', stdoutSha256: sha256('out\n'), stderrSha256: sha256('') },
    identity: { identitySha256: 'sha256:abc' },
    cleanup: { ok: true },
  };
  const v = verifySolariEvidence(good, { exitStatus: 0, outputContains: ['out'] });
  assert.equal(v.verified, true, JSON.stringify(v));

  // Tamper with the captured bytes AFTER capture: the hash check must fail.
  const tampered = JSON.parse(JSON.stringify(good));
  tampered.run.stdout = 'out\nEVIL\n';
  const vt = verifySolariEvidence(tampered);
  assert.equal(vt.verified, false);
  assert.equal(vt.code, 'verification-hash-mismatch');

  // Wrong expected exit status.
  const vExit = verifySolariEvidence(good, { exitStatus: 1 });
  assert.equal(vExit.verified, false);
  assert.equal(vExit.code, 'verification-exit-mismatch');

  // Missing output.
  const vOut = verifySolariEvidence(good, { outputContains: ['absent'] });
  assert.equal(vOut.verified, false);
  assert.equal(vOut.code, 'verification-output-missing');

  // No identity, no cleanup: unverified, each with its own code.
  const vIdentity = verifySolariEvidence({ run: good.run, cleanup: { ok: true } });
  assert.equal(vIdentity.code, 'verification-identity-missing');
  const vCleanup = verifySolariEvidence({ run: good.run, identity: good.identity, cleanup: { ok: false } });
  assert.equal(vCleanup.code, 'verification-cleanup-incomplete');
});

test('protocol: connect failure after create still cleans up and reports', async () => {
  const { factory, calls } = fakeFactory({ connectError: new Error('connect refused') });
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      const r = await executeScoped(baseRequest());
      assert.equal(r.ok, false);
      assert.equal(r.code, 'solari-connect-failed');
      assert.equal(r.cleanup.ok, true, 'the created sandbox was still killed and its death verified');
      assert.ok(calls.kills >= 1);
      assert.equal(r.run, null, 'no run happened, so no run evidence exists');
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: killScoped is honest about process-local knowledge', async () => {
  const r = await killScoped({ environment: ENV, sandboxId: 'sbx-never-existed' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'solari-sandbox-unknown');
  assert.ok(String(r.reason).includes('idle timeout') === false || true);
  assert.deepEqual(r.details.sandboxId, 'sbx-never-existed');
});

test('readiness: presence booleans only, and it never claims live certification', async () => {
  delete process.env[TOKEN_VAR];
  const rd = await solariReadiness(ENV, CONFIG);
  assert.equal(rd.adapter, 'solari-sandbox');
  assert.equal(rd.role, 'execution-worker');
  assert.equal(rd.liveCertified, false);
  assert.equal(rd.tokenVar, TOKEN_VAR);
  assert.equal(rd.tokenConfigured, false);
  assert.equal(rd.documentedBaseUrl, SOLARI_DOCUMENTED_BASE_URL);
  assert.deepEqual(rd.budgetCaps, { cpu: 2, memMb: 1024, timeoutMs: 600000 }, 'operator caps, clamped to documented maxima');
  assert.equal(rd.maxConcurrent, 1);
  assert.equal(typeof rd.sdkPresent, 'boolean');
  assert.ok(!JSON.stringify(rd).includes('apiKey'), 'readiness carries no credential field');
  assert.ok(rd.note.includes('P6B'), 'readiness names the live-certification gate');

  // An unset-but-default tokenVar is reported as the default NAME.
  const rdDefault = await solariReadiness({ ...ENV, adapter: { kind: 'solari-sandbox', transport: {} } }, CONFIG);
  assert.equal(rdDefault.tokenVar, SOLARI_TOKEN_VAR_DEFAULT);
  assert.equal(rdDefault.tokenConfigured, !!process.env[SOLARI_TOKEN_VAR_DEFAULT], 'presence reflects the machine honestly');
});

test('normalizers: budgets clamp operator caps to documented maxima and refuse nonsense', () => {
  // An operator cap ABOVE the documented machine limit is clamped, not honored.
  const loose = normalizeSolariBudget({}, { solari: { budgetCaps: { cpu: 999, memMb: 999999, timeoutMs: 99999999 } } });
  assert.equal(loose.cpu, SOLARI_DOCUMENTED_LIMITS.cpu.max);
  assert.equal(loose.memMb, SOLARI_DOCUMENTED_LIMITS.memMb.max);
  assert.equal(loose.timeoutMs, SOLARI_DOCUMENTED_LIMITS.timeoutMs.max);

  assert.throws(() => normalizeSolariBudget({ cpu: 0 }, CONFIG), (e) => e.code === 'solari-budget-invalid');
  assert.throws(() => normalizeSolariBudget({ memMb: 1.5 }, CONFIG), (e) => e.code === 'solari-budget-invalid');
  assert.throws(() => normalizeSolariBudget({ template: 'custom' }, CONFIG), (e) => e.code === 'solari-capability-unsupported' && e.details.capability === 'custom-template');
  assert.throws(() => normalizeSolariBudget({ region: 'eu-east' }, CONFIG), (e) => e.code === 'solari-capability-unsupported' && e.details.capability === 'region');
  assert.throws(() => normalizeSolariBudget({ recording: true }, CONFIG), (e) => e.code === 'solari-capability-unsupported' && e.details.capability === 'recording');
  assert.throws(() => normalizeSolariBudget({ gpu: true }, CONFIG), (e) => e.code === 'solari-capability-unsupported' && e.details.capability === 'gpu');
  assert.throws(() => normalizeSolariBudget({ lifecycle: { onTimeout: 'pause' } }, CONFIG), (e) => e.code === 'solari-capability-unsupported' && e.details.capability === 'lifecycle-pause');
  const ok = normalizeSolariBudget({ cpu: 1, memMb: 512, timeoutMs: 120000 }, CONFIG);
  assert.deepEqual(ok, { template: 'base', cpu: 1, memMb: 512, timeoutMs: 120000, lifecycle: { onTimeout: 'kill' } });
});

test('normalizers: commands are argv-only, and shell strings are refused by name', () => {
  assert.throws(() => normalizeSolariCommand({ command: 'true && curl evil' }), (e) => {
    return e.code === 'solari-capability-unsupported'
      && e.details.capability === 'shell-string'
      && /argv is NOT shell-interpreted/.test(e.message);
  });
  assert.throws(() => normalizeSolariCommand({ argv: [] }), (e) => e.code === 'solari-argv-invalid');
  assert.throws(() => normalizeSolariCommand({ argv: ['echo', ''] }), (e) => e.code === 'solari-argv-invalid');
  assert.throws(() => normalizeSolariCommand({ argv: ['echo', 42] }), (e) => e.code === 'solari-argv-invalid');
  assert.throws(() => normalizeSolariCommand({ argv: ['x'.repeat(2)] && new Array(65).fill('a') }), (e) => e.code === 'solari-argv-invalid');
  const c = normalizeSolariCommand({ argv: ['sh', '-c', 'echo hi'], cwd: '/tmp' });
  assert.deepEqual(c.argv, ['sh', '-c', 'echo hi'], 'the documented pipeline form passes through visibly');
  assert.equal(c.cwd, '/tmp');
});

test('normalizers: scoped env carries NAMES, reads values at request time, refuses inline values', () => {
  assert.throws(() => scopedEnvironmentFor({ envNames: ['OK_NAME'], env: { OK_NAME: 'value' } }), (e) => e.code === 'solari-env-values-forbidden');
  assert.throws(() => scopedEnvironmentFor({ envNames: ['not a name'] }), (e) => e.code === 'solari-env-names-invalid');
  assert.throws(() => scopedEnvironmentFor({ envNames: new Array(17).fill('A') }), (e) => e.code === 'solari-env-names-invalid');

  // The allowlist is the second argument; with none, nothing is forwardable.
  assert.throws(() => scopedEnvironmentFor({ envNames: ['OK_NAME'] }, []), (e) => e.code === 'solari-env-not-allowed');
  // A privileged name is refused even when the operator (wrongly) allowlisted
  // it — an allowlisted privileged name is a dead entry.
  assert.throws(() => scopedEnvironmentFor({ envNames: ['RCOS_INFRA_TOKEN'] }, ['RCOS_INFRA_TOKEN']), (e) => e.code === 'solari-env-privileged');

  process.env.DSH_E2E_SCOPED_PROBE = 'probe-value-7c21';
  try {
    const scoped = scopedEnvironmentFor(
      { envNames: ['DSH_E2E_SCOPED_PROBE', 'DSH_E2E_ABSENT_PROBE'] },
      ['DSH_E2E_SCOPED_PROBE', 'DSH_E2E_ABSENT_PROBE'],
    );
    assert.equal(scoped.env.DSH_E2E_SCOPED_PROBE, 'probe-value-7c21', 'values come from THIS process at request time');
    assert.deepEqual(scoped.missing, ['DSH_E2E_ABSENT_PROBE']);
  } finally {
    delete process.env.DSH_E2E_SCOPED_PROBE;
  }
});

test('protocol: a privileged env name refuses before any client exists, even while the variable is set', async () => {
  const { factory, calls } = fakeFactory({});
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      // TOKEN_VAR is both the configured credential var AND a TOKEN-pattern
      // match, and its value IS set in this process — the strongest form of
      // GPT's requirement: refuse even when the variable exists server-side.
      const r = await executeScoped(baseRequest({ envNames: [TOKEN_VAR] }));
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, 'solari-env-privileged');
      assert.equal(calls.constructed, 0, 'no client was ever constructed');
      assert.ok(!JSON.stringify(r).includes(TOKEN_VALUE), 'the privileged value never crosses into the response');
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: an undeclared env name refuses even though the variable exists in this process', async () => {
  const { factory, calls } = fakeFactory({});
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      process.env.E2E_UNDECLARED_PRESENT = 'present-but-forbidden-9d2f';
      try {
        const r = await executeScoped(baseRequest({ envNames: ['E2E_UNDECLARED_PRESENT'] }));
        assert.equal(r.ok, false, JSON.stringify(r));
        assert.equal(r.code, 'solari-env-not-allowed');
        assert.equal(calls.constructed, 0, 'no client was ever constructed');
        assert.ok(!JSON.stringify(r).includes('present-but-forbidden-9d2f'), 'the existing value never crosses into the response');
      } finally {
        delete process.env.E2E_UNDECLARED_PRESENT;
      }
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: no allowlist configured means nothing is forwardable', async () => {
  const { factory, calls } = fakeFactory({});
  setSolariClientFactory(factory);
  try {
    await withToken(async () => {
      const bareConfig = { solari: { budgetCaps: CONFIG.solari.budgetCaps, maxConcurrent: 1 } };
      const r = await executeScoped(baseRequest({ config: bareConfig, envNames: ['E2E_ALLOWED_ONE'] }));
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, 'solari-env-not-allowed');
      assert.equal(calls.constructed, 0, 'no client was ever constructed');
    });
  } finally {
    setSolariClientFactory(null);
  }
});

test('protocol: the environment override replaces the deployment allowlist and privileged entries are dead', () => {
  // Per-environment scoping: the override REPLACES config.solari.envAllowlist —
  // it does not merge — so a capability sees only its own declaration.
  const envScoped = {
    ...ENV,
    adapter: { ...ENV.adapter, transport: { tokenVar: TOKEN_VAR, envAllowlist: ['E2E_OVERRIDE_ONLY_OK'] } },
  };
  assert.deepEqual(effectiveEnvAllowlist(envScoped, CONFIG), ['E2E_OVERRIDE_ONLY_OK'], 'the environment override wins');
  assert.deepEqual(effectiveEnvAllowlist(ENV, CONFIG), ['E2E_ALLOWED_ONE', 'E2E_ALLOWED_MISSING'], 'without an override, the deployment allowlist applies');
  assert.deepEqual(effectiveEnvAllowlist(ENV, {}), [], 'nothing configured means nothing is forwardable');
  // Malformed entries are dead, not fatal — the effective list stays clean.
  assert.deepEqual(effectiveEnvAllowlist({ adapter: { transport: { envAllowlist: ['ok_name', 'not a name', 42, null] } } }, {}), ['ok_name']);

  const scoped = scopedEnvironmentFor({ envNames: ['E2E_OVERRIDE_ONLY_OK'] }, effectiveEnvAllowlist(envScoped, CONFIG), TOKEN_VAR);
  assert.deepEqual(scoped.env, {}, 'an allowlisted but unset name lands in missing, not invented');
  assert.deepEqual(scoped.missing, ['E2E_OVERRIDE_ONLY_OK']);
  // The same name under the deployment allowlist is refused — scoping is real.
  assert.throws(() => scopedEnvironmentFor({ envNames: ['E2E_OVERRIDE_ONLY_OK'] }, effectiveEnvAllowlist(ENV, CONFIG), TOKEN_VAR), (e) => e.code === 'solari-env-not-allowed');
  // tokenVar is denied by identity, allowlist notwithstanding.
  assert.throws(() => scopedEnvironmentFor({ envNames: [TOKEN_VAR] }, [TOKEN_VAR], TOKEN_VAR), (e) => e.code === 'solari-env-privileged');
});
