/** Bounded read-only artifact access. Authority is the existing host audit. */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getDshHome } from './config.js';

const DISPATCH = /^sd-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN = /^[a-f0-9]{32}$/i;
const FILE = /^(?:EVAL\.json|RECEIPT\.json|rcos-invocation-[a-z0-9-]+\.json|rcos-domain-report\.json|desktop-review\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:mp4|png|jpg|json|txt))$/;

export async function readArtifactBinding({ auditDir, dispatchId, callerSessionId, runId }) {
  if (!DISPATCH.test(dispatchId || '') || !SESSION.test(callerSessionId || '') || !RUN.test(runId || '')) throw new Error('Artifact request identity is invalid');
  const file = await open(join(auditDir, 'seat-dispatch.jsonl'), 'r');
  let records;
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    records = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await file.close(); }
  const matches = records.filter(row => row?.run_id === dispatchId);
  if (matches.length !== 1) throw new Error('Saved dispatch is absent or ambiguous');
  const row = matches[0];
  if (row.caller_session_id !== callerSessionId) throw new Error('Artifact access is limited to its originating chat');
  if (row.stage !== 'complete' || row.receipt_accepted !== true || row.seat !== 'workflow-manager'
      || row.caller_preset !== 'general-idea' || !['no-parent-root', 'lineage-clean-root'].includes(row.authority_basis)) throw new Error('No accepted Workflow Manager receipt');
  const b = row.archon_binding;
  const original = records.filter(item => item?.run_id === b?.dispatch_id);
  if (!b || !DISPATCH.test(b.dispatch_id || '') || !SESSION.test(b.seat_session_id || '') || !RUN.test(b.archon_conversation_id || '')
      || !/^rcos-ir-[a-z0-9][a-z0-9-]{0,55}$/.test(b.workflow_name || '')
      || b.caller_session_id !== callerSessionId || b.run_id !== runId || row.archon?.run_id !== runId
      || original.length !== 1 || original[0].caller_session_id !== callerSessionId || original[0].seat_session_id !== b.seat_session_id
      || original[0].archon?.run_id !== runId || JSON.stringify(original[0].archon_binding) !== JSON.stringify(b)) throw new Error('Host run binding identity does not match');
  return b;
}

let activeRead = false;
export async function readRemoteArtifact(target, request) {
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(target || '')) throw new Error('Artifact SSH target is not configured');
  if (activeRead) throw Object.assign(new Error('Another artifact is loading. Retry shortly.'), { status: 429 });
  activeRead = true;
  try {
    const source = await readFile(new URL('./run-artifacts-remote.py', import.meta.url));
    // Command contains only our shipped source. Request values travel on stdin.
    const command = "python3 -c 'import base64;exec(base64.b64decode(\"" + source.toString('base64') + "\"))'";
    return await new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, command], { stdio: ['pipe', 'pipe', 'pipe'] });
      let chunks = [], bytes = 0, stderr = '', settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Dell artifact read timed out. Retry.')); }, 30000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Artifact transport exceeded its byte limit')); } else chunks.push(chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => finish(error));
      child.stdin.on('error', error => finish(error));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return finish(new Error('Dell artifact read failed; verify SSH access and retry.'));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('Dell returned an invalid artifact response')); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  } finally { activeRead = false; }
}

export function createRunArtifactHandler({ remote = readRemoteArtifact, auditDir } = {}) {
  return async (req, res, url, config) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'GET only' });
    // Existing audits have no public principal owner. Never infer one.
    if (req.auth?.principal) return send(403, { ok: false, error: 'Run artifacts require local desktop access; public ownership is not recorded.' });
    const keys = ['dispatch_id', 'caller_session_id', 'run_id', 'file'];
    if ([...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => url.searchParams.getAll(key).length > 1)
        || (url.searchParams.has('file') && !FILE.test(url.searchParams.get('file')))) return send(400, { ok: false, error: 'Artifact request must use exact run identity and an approved file name.' });
    try {
      const binding = await readArtifactBinding({ auditDir: auditDir || join(getDshHome(), 'runs', 'seat-dispatch'), dispatchId: url.searchParams.get('dispatch_id'), callerSessionId: url.searchParams.get('caller_session_id'), runId: url.searchParams.get('run_id') });
      const result = await remote(config.artifacts?.sshTarget, { binding, file: url.searchParams.get('file') });
      return send(result.ok === true ? 200 : 409, result);
    } catch (error) { return send(error.status || 409, { ok: false, error: String(error.message || error).slice(0, 220) }); }
  };
}
