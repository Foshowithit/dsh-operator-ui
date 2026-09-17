#!/usr/bin/env node
// eval/lib/i0-b-oneshot.mjs — the machine-B side of the I0 walkthrough.
//
// This is ORCHESTRATION, not an API surface: it reads ONE JSON command from
// stdin, executes ONE already-sealed production operation, prints ONE JSON
// response, and EXITS. There is no daemon, no listening socket, no session
// state — every consumer step in the campaign is therefore a fresh process
// that reads its durable state from disk, which is exactly the property the
// composition seal needs to demonstrate.
//
// Run over the already-established SSH channel:
//   ssh <machine B> 'DSH_HOME=... P1X_REPO=... node eval/lib/i0-b-oneshot.mjs' < command.json

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, release } from 'node:os';

const REPO = process.env.P1X_REPO || process.cwd();
const HOME = process.env.DSH_HOME;
const { resolveFederated, fetchExact } = await import(join(REPO, 'lib', 'federation.js'));
const { stagePackage, verifyImport, admitImport } = await import(join(REPO, 'lib', 'flowrouter.js'));
const { runGoal } = await import(join(REPO, 'lib', 'goal.js'));
const {
  recordProof, acknowledgeProof, listProofRecords, isQuarantined, quarantinedPublishers, verifyProofCore,
} = await import(join(REPO, 'lib', 'equivocation.js'));
const { createHash } = await import('node:crypto');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = (o) => { process.stdout.write(JSON.stringify(o)); };
const readStdin = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return JSON.parse(s || '{}');
};

// Durable consumer state readout (evidence, not an API).
async function bstate() {
  const cfgMod = await import(join(REPO, 'lib', 'config.js'));
  const cfg = (cfgMod.resolveConfig().config) || {};
  const regRaw = await readFile(cfg.registry.path).catch(() => Buffer.from('{}'));
  let taskRaw = '';
  try { taskRaw = await readFile(join(HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(taskRaw).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin') || null;
  return {
    registry_sha: sha(regRaw),
    registry_caps: (JSON.parse(regRaw.toString('utf8')).capabilities || []).length,
    taskstore_sha: sha(Buffer.from(taskRaw, 'utf8')),
    import_tasks: parsed.filter((t) => t.kind === 'import').length,
    pin: pin ? pin.pin : null,
    pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null,
    equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length,
    kinds: parsed.map((t) => t.kind).sort(),
  };
}

async function makeFixture() {
  const vals = [19, 8, 33, 4, 24, 11];
  const fixtureDir = join(HOME, 'fixtures', 'i0-' + Math.random().toString(36).slice(2, 10));
  await mkdir(join(fixtureDir, 'workspace'), { recursive: true });
  let acc = 0;
  const rows = vals.map((v, i) => { acc += v; return { row: String(i + 1), total: String(acc) }; });
  await writeFile(join(fixtureDir, 'workspace', 'values.csv'), 'value\n' + vals.join('\n') + '\n', 'utf8');
  await writeFile(join(fixtureDir, 'objective.txt'), 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.\n', 'utf8');
  await writeFile(join(fixtureDir, 'expected.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
  return { fixture_dir: fixtureDir, authors: 'B', values: vals, rows };
}

async function stageFetched(cmd) {
  const dir = join(HOME, 'i0-incoming');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const wire = Buffer.from(String(cmd.artifact_b64 || ''), 'base64');
  const obj = JSON.parse(wire.toString('utf8'));
  for (const f of obj.files) {
    const dest = join(dir, f.path);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  return stagePackage({ packageDir: dir, alias: cmd.alias, identityMaterial: cmd.identityMaterial, expectedTuple: cmd.expectedTuple });
}

async function goal(cmd) {
  if (cmd.approveTaskId) {
    const { getGoal } = await import(join(REPO, 'lib', 'goal.js'));
    const pending = await getGoal(String(cmd.approveTaskId).slice(0, 120));
    const pv = pending && pending.verdict;
    const awaiting = pv && (pv.failureCodes || []).includes('awaiting-approval');
    if (!awaiting) return { goal: null, error: 'TASK_NOT_AWAITING_APPROVAL' };
    return { goal: await runGoal({ objective: pending.objective, retryOf: pending.taskId, approved: true }) };
  }
  return { goal: await runGoal({ objective: String(cmd.objective || '') }) };
}

const cmd = await readStdin();
// the dispatch lives in a function so each case can `return` its response
const run = async () => {
  try {
    switch (cmd.op) {
      case 'actor': {
      return out({ role: cmd.role_label || 'machine_B_consumer_and_mirrors', platform: platform(), release: release(), node: process.version, run_nonce: cmd.run_nonce || null });
      }
      case 'bstate': return out(await bstate());
      case 'resolve': return out(await resolveFederated({ peers: cmd.peers, scheme: cmd.scheme, publisher_id: cmd.publisher_id, name: cmd.name, version: cmd.version }));
      case 'fetch': {
      try { return out(await fetchExact({ resolutionHandle: cmd.resolution_handle, D: cmd.D, bytesFrom: cmd.bytes_from })); }
      catch (e) { return out({ ok: false, error: e.code || 'FETCH_NOT_PERMITTED', reason: String(e.message).slice(0, 200) }); }
      }
      case 'stage-fetched': return out(await stageFetched(cmd));
      case 'make-fixture': return out(await makeFixture());
      case 'verify': return out(await verifyImport({ importTaskId: cmd.importTaskId, fixtureDir: cmd.fixtureDir }));
      case 'admit': return out(await admitImport({ importTaskId: cmd.importTaskId, alias: cmd.alias }));
      case 'goal': return out(await goal(cmd));
      case 'f1-verify': {
      try { const v = verifyProofCore(cmd.proof_core); return out({ ok: true, digest: v.proof_digest, relation: v.relation, publisher_id: v.publisher_id }); }
      catch (e) { return out({ ok: false, error: e.code || 'EQUIVOCATION_PROOF_INVALID', reason: String(e.message).slice(0, 200) }); }
      }
      case 'f1-ingest': {
      const r = await recordProof({ core: cmd.proof_core, observedVia: cmd.observed_via });
      return out({ ok: true, recorded: r.recorded, deduplicated: !!r.deduplicated, proof_digest: r.proof_digest, quarantined: await isQuarantined(r.record.publisher_id) });
      }
      case 'f1-acknowledge': {
      const r = await acknowledgeProof({ proofDigest: cmd.proof_digest, operator: cmd.operator });
      return out(r.ok ? { ok: true, still_quarantined: r.still_quarantined } : r);
      }
      case 'f1-status': {
      const pid = cmd.publisher_id || null;
      const proofs = await listProofRecords(pid || undefined);
      return out({ ok: true, quarantined: pid ? await isQuarantined(pid) : null, quarantined_publishers: await quarantinedPublishers(), proofs: proofs.map((t) => ({ proof_digest: t.proof_digest, publisher_id: t.publisher_id, relation: t.relation, acknowledged: t.acknowledged || null })) });
      }
      case 'sequence': {
        // Several sealed operations inside ONE process. This is required by
        // the sealed design, not a convenience: F0's resolution handle is
        // explicitly EPHEMERAL and in-process, so a consumer that runs as
        // short-lived processes must resolve and fetch in the same process.
        const results = [];
        let prevHandle = null;
        for (const st of cmd.steps || []) {
          if (st.op === 'resolve') {
            const r = await resolveFederated({ peers: st.peers, scheme: st.scheme, publisher_id: st.publisher_id, name: st.name, version: st.version });
            prevHandle = r.resolution_handle;
            results.push({ op: 'resolve', result: r });
          } else if (st.op === 'fetch') {
            try {
              const r = await fetchExact({ resolutionHandle: st.resolution_handle || prevHandle, D: st.D, bytesFrom: st.bytes_from });
              results.push({ op: 'fetch', result: r });
            } catch (e) { results.push({ op: 'fetch', error: e.code || 'FETCH_NOT_PERMITTED', reason: String(e.message).slice(0, 200) }); }
          } else if (st.op === 'stage-fetched') {
            const prev = results[results.length - 1];
            const artifact = st.artifact_b64 || (prev && prev.result && prev.result.bytes_b64);
            const material = st.identityMaterial || (prev && prev.result && prev.result.material);
            results.push({ op: 'stage-fetched', result: await stageFetched({ ...st, artifact_b64: artifact, identityMaterial: material }) });
          } else if (st.op === 'verify') {
            const prev = results[results.length - 1];
            const importTaskId = st.importTaskId || (prev && prev.result && prev.result.import && prev.result.import.taskId);
            results.push({ op: 'verify', result: await verifyImport({ importTaskId, fixtureDir: st.fixtureDir }) });
          } else if (st.op === 'make-fixture') {
            results.push({ op: 'make-fixture', result: await makeFixture() });
          } else if (st.op === 'kill-listener') {
            const { execFileSync } = await import('node:child_process');
            let killed = false;
            try {
              // the bracket trick: the pattern cannot match this command line
              execFileSync('bash', ['-c', `pkill -f 'flowrouter-service[.]mjs --port ${Number(st.port)}'`], { stdio: 'pipe' });
              killed = true;
            } catch { killed = false; }
            await new Promise((r) => setTimeout(r, 1200));
            results.push({ op: 'kill-listener', result: { port: st.port, killed } });
          } else {
            results.push({ op: st.op, error: 'UNSUPPORTED_STEP' });
          }
        }
        return out({ ok: true, steps: results });
      }
      default: return out({ error: 'UNKNOWN_OP', op: cmd.op });
    }
  } catch (e) {
    out({ error: e.code || 'ONE_SHOT_ERROR', reason: String(e.message).slice(0, 200) });
  }
};
await run();
