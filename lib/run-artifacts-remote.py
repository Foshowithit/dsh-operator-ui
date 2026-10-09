"""Read only approved run receipts and hash-pinned media. Never execute media."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

LIMIT = 8 * 1024 * 1024
FILE = re.compile(r"(?:EVAL\.json|RECEIPT\.json|rcos-invocation-[a-z0-9-]+\.json|desktop-review/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:mp4|png|jpg|json|txt))")
# The DOMAIN REPORT the run artifact only points at by hash. It lives in the RCOS
# invocation dir, not the run artifact dir, so it is fetched by this exact name and
# verified against the output.sha256 the run artifact already pins.
DOMAIN_REPORT = 'rcos-domain-report.json'
INVOCATION_ID = re.compile(r'^inv_\d{8}T\d{6}Z-[0-9a-f]{6}$')
SHA256_HEX = re.compile(r'^[a-f0-9]{64}$')
MIME = {'.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain'}

def read_detail(argv, timeout=15):
    # Bound allocation while reading, not after capture_output has buffered it.
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    streams = selectors.DefaultSelector()
    output = bytearray()
    sizes = {'stdout': 0, 'stderr': 0}
    deadline = time.monotonic() + timeout
    try:
        streams.register(proc.stdout, selectors.EVENT_READ, 'stdout')
        streams.register(proc.stderr, selectors.EVENT_READ, 'stderr')
        while streams.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('Archon run detail timed out')
            for key, _ in streams.select(remaining):
                chunk = os.read(key.fd, 16384)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                sizes[key.data] += len(chunk)
                if sizes[key.data] > (262144 if key.data == 'stdout' else 4096):
                    raise ValueError('Archon run detail exceeded its byte limit')
                if key.data == 'stdout':
                    output.extend(chunk)
        try:
            code = proc.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ValueError('Archon run detail timed out') from None
        if code:
            raise ValueError('Archon run detail is unavailable')
        return json.loads(output)
    finally:
        streams.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()

def read_exact(root, relative, limit):
    # Walk descriptors without following symlinks, including directory parents.
    parts = Path(relative).parts
    if not parts or any(p in ('..', '.', '') for p in parts) or Path(relative).is_absolute():
        raise ValueError('Artifact path is invalid')
    if root.resolve() != root:
        raise ValueError('Artifact root contains a symlink')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            import stat
            info = os.fstat(leaf)
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError('Artifact is not a bounded regular file')
            with os.fdopen(leaf, 'rb', closefd=False) as stream:
                data = stream.read(limit + 1)
            if len(data) > limit:
                raise ValueError('Artifact exceeded its byte limit')
            return data
        finally:
            os.close(leaf)
    finally:
        os.close(fd)

def read_domain_report(root, home):
    """Resolve the run's RCOS invocation domain report, hash-pinned by the run
    artifact itself.

    The run artifact's `rcos-invocation-<cap>.json` carries `invocation_id` and
    `output.sha256` -- a POINTER to the domain report but not its bytes. The bytes
    live in the RCOS home at invocations/<id>/output.json. This joins them, and it
    verifies the fetched bytes against the sha256 the run artifact already pins,
    so a report edited after sealing is refused rather than trusted. Read-only:
    it runs no capability and writes nothing.
    """
    carrier = None
    for name in sorted(os.listdir(root))[:100]:
        if '/' in name or not re.fullmatch(r'rcos-invocation-[a-z0-9-]+\.json', name):
            continue
        try:
            candidate = json.loads(read_exact(root, name, 262144))
        except Exception:
            continue
        if isinstance(candidate, dict) and INVOCATION_ID.fullmatch(str(candidate.get('invocation_id', ''))):
            carrier = candidate
            break
    if carrier is None:
        raise ValueError('This run carries no RCOS invocation record')
    invocation_id = carrier['invocation_id']
    output = carrier.get('output') or {}
    if output.get('path') != 'output.json' or not SHA256_HEX.fullmatch(str(output.get('sha256', ''))):
        raise ValueError('The run invocation does not pin a domain report')
    # The RCOS home is fixed by the invocation record; never taken from a request.
    rcos_home = carrier.get('rcos_home')
    if not isinstance(rcos_home, str) or not Path(rcos_home).is_absolute() or Path(rcos_home).resolve() != Path(rcos_home):
        raise ValueError('The run invocation names no canonical RCOS home')
    inv_dir = Path(rcos_home) / 'invocations' / invocation_id
    if not inv_dir.is_dir() or inv_dir.resolve() != inv_dir:
        raise ValueError('The RCOS invocation directory is unavailable')
    data = read_exact(inv_dir, 'output.json', 262144)
    digest = hashlib.sha256(data).hexdigest()
    if digest != output['sha256']:
        raise ValueError('The domain report does not match the hash the run pinned')
    report = json.loads(data)
    return {
        'name': DOMAIN_REPORT,
        'bytes': len(data),
        'sha256': digest,
        'mime': 'application/json',
        'invocation_id': invocation_id,
        'domain_status': report.get('status') if isinstance(report, dict) else None,
        'verified_against': 'run artifact output.sha256',
        '_dir': str(inv_dir),
    }


def inspect(request, home=None, detail=None):
    home = Path(home or Path.home())
    b = request['binding']
    run_id = b['run_id']
    # Archon mints BOTH forms: a bare 32-hex id on some dispatch paths and a
    # canonical UUID on others (measured: 1891 vs 2685 rows in archon.db, both
    # including rcos-ir-* runs). Accepting only one form made the cross-seat
    # read blind to the majority of runs. Accept both; nothing else.
    if not (re.fullmatch(r'[a-f0-9]{32}', run_id)
            or re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', run_id)):
        raise ValueError('Invalid run identity')
    if detail is None:
        detail = read_detail([str(home / '.local/bin/archon'), 'workflow', 'get', run_id, '--json'])
    if detail.get('id') != run_id or detail.get('conversation_id') != b['archon_conversation_id'] or detail.get('workflow_name') != b['workflow_name']:
        raise ValueError('Archon run identity changed')
    root = Path(detail['output_root']) / 'artifacts/runs' / run_id
    workspace = home / '.archon/workspaces'
    if not root.is_absolute() or not root.is_relative_to(workspace) or root.resolve() != root:
        raise ValueError('Artifact root is outside the canonical workspace')
    entries = []
    for name in sorted(os.listdir(root))[:100]:
        if '/' not in name and FILE.fullmatch(name):
            data = read_exact(root, name, 262144)
            entries.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mime': 'application/json'})
    manifest = root / 'desktop-review.json'
    if manifest.exists() or manifest.is_symlink():
        packet = json.loads(read_exact(root, 'desktop-review.json', 65536))
        if packet.get('schema') != 'dsh-run-review/1' or packet.get('parent_run_id') != run_id:
            raise ValueError('Review manifest run identity does not match')
        inv = packet.get('invocation_receipt')
        if not isinstance(inv, str) or not re.fullmatch(r'rcos-invocation-[a-z0-9-]+\.json', inv):
            raise ValueError('Review manifest invocation is invalid')
        if hashlib.sha256(read_exact(root, inv, 262144)).hexdigest() != packet.get('invocation_receipt_sha256'):
            raise ValueError('Review manifest invocation digest changed')
        rows = packet.get('files')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 16:
            raise ValueError('Review manifest file count is invalid')
        seen = set()
        for row in rows:
            name = row.get('name')
            if not isinstance(name, str) or not name.startswith('desktop-review/') or not FILE.fullmatch(name) or name in seen:
                raise ValueError('Review file name is invalid or ambiguous')
            seen.add(name)
            if type(row.get('bytes')) != int or not 0 < row['bytes'] <= LIMIT or not re.fullmatch(r'[a-f0-9]{64}', row.get('sha256', '')):
                raise ValueError('Review file size or digest is invalid')
            entries.append({'name': name, 'bytes': row['bytes'], 'sha256': row['sha256'], 'mime': MIME[Path(name).suffix]})
    domain = None
    try:
        domain = read_domain_report(root, home)
    except ValueError:
        domain = None
    if domain is not None and not any(row['name'] == DOMAIN_REPORT for row in entries):
        # '_dir' is an internal handle for re-reading; never shipped in the listing.
        entries.append({k: v for k, v in domain.items() if not k.startswith('_')})

    name = request.get('file')
    if name is None:
        return {'ok': True, 'run_id': run_id, 'files': entries, 'limit_bytes': LIMIT}
    matches = [row for row in entries if row['name'] == name]
    if len(matches) != 1:
        raise ValueError('This file is not approved for preview; review the available run files.')
    entry = matches[0]
    if name == DOMAIN_REPORT:
        if domain is None:
            raise ValueError('This run has no verifiable domain report')
        inv_dir = Path(domain['_dir'])
        data = read_exact(inv_dir, 'output.json', LIMIT)
        if hashlib.sha256(data).hexdigest() != domain['sha256']:
            raise ValueError('Artifact bytes do not match the run-pinned domain report')
        return {'ok': True, 'run_id': run_id, 'file': {k: v for k, v in domain.items() if not k.startswith('_')}, 'base64': base64.b64encode(data).decode('ascii')}
    data = read_exact(root, name, LIMIT)
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('Artifact bytes do not match the review manifest')
    return {'ok': True, 'run_id': run_id, 'file': entry, 'base64': base64.b64encode(data).decode('ascii')}

if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('Artifact request exceeded its byte limit')
        print(json.dumps(inspect(json.loads(raw))))
    except Exception as exc:
        # No subprocess output or arbitrary remote paths leak through errors.
        message = str(exc) if isinstance(exc, ValueError) else 'Dell artifact is unavailable. Verify the run files and retry.'
        print(json.dumps({'ok': False, 'error': message[:220]}))
