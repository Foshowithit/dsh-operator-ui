#!/usr/bin/env node
// eval/lib/write-baseline.mjs — freeze the parity baseline (GPT requirement:
// record the environment BEFORE any lane runs; both lanes must match on it).
//
// Writes eval/baseline-config.json: versions, model identity/params, profile
// identity hash, tool inventory, hardware, config hashes. Run once at
// freeze; re-run only when the frozen environment legitimately changes (and
// record that in the run log).

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH_BIN = process.argv[2] || '/Users/<redacted>/.npm/_npx/6c7f445d1bf61956/node_modules/.bin/dsh';
const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const dshVersion = execFileSync(DSH_BIN, ['--version'], { encoding: 'utf8' }).trim();
const rcosCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

// The headless profile's composed config hash (the DSH lane's identity).
let profileConfigHash = null;
let dshConfigRaw = '';
try {
  const dump = execFileSync(DSH_BIN, ['--profile', 'headless', '--dump-config'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DSH_HOME: '/tmp/opui-shakedown-dsh' } });
  dshConfigRaw = dump;
  profileConfigHash = sha256s(dump);
} catch (e) {
  profileConfigHash = 'unavailable: ' + String(e.message).slice(0, 80);
}

// Model identity from the DSH lane's own config (model name only — NEVER keys).
let model = { provider: null, id: null, params: 'unrecorded' };
try {
  const settings = await readFile('/tmp/opui-shakedown-dsh/settings.yaml', 'utf8');
  const mm = settings.match(/model:\s*(\S+)/);
  const pm = settings.match(/provider:\s*(\S+)/);
  if (mm) model.id = mm[1];
  if (pm) model.provider = pm[1];
} catch { /* lane home not yet prepared — record nulls honestly */ }

const toolInventory = { bash: true, fs: 'dsh built-ins', notes: 'recorded from the headless profile tool list; RCOS lane exposes the same base tools via its workflow runtime' };

// Preserve a previously resolved model_lane across re-freezes (the freeze
// refreshes environment facts; the owner's lane decision is not re-litigated).
let prevModelLane = null;
try { prevModelLane = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8')).model_lane || null; } catch { /* first freeze */ }

const baseline = {
  protocol: 'eval-protocol-v1',
  frozen_at: new Date().toISOString(),
  frozen_at_commit: rcosCommit,
  model_lane: prevModelLane || {
    endpoint: null,
    model_id: null,
    sampling: null,
    resolution: 'owner decision pending — fund a zen key | authorize zai coding-plan key | repair local qwen MLX',
  },
  dsh_version: dshVersion,
  dsh_bin: DSH_BIN,
  rcos_commit: rcosCommit,
  model,
  profile: 'headless',
  profile_config_hash: profileConfigHash,
  hardware: {
    platform: os.platform(), arch: os.arch(), cpus: os.cpus().length,
    mem_gb: Math.round(os.totalmem() / 1024 ** 3),
    hostname_hash: sha256s(os.hostname()).slice(0, 16),
  },
  toolInventory,
  budget: { wall_ms_per_objective: 300000, note: 'identical max budget both lanes; costs beyond wall time recorded only where actually measurable' },
  notes: 'Both lanes: same fixture workspace, same objective text, same hardware. RCOS adds its architecture (routing/teach/memory); DSH runs its normal loop. Nothing removed from DSH.',
};

await writeFile(join(root, 'eval', 'baseline-config.json'), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
console.log('baseline frozen → eval/baseline-config.json');
console.log(JSON.stringify({ dsh_version: baseline.dsh_version, model, profile_config_hash: String(profileConfigHash).slice(0, 28) }, null, 1));
