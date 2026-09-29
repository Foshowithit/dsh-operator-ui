#!/usr/bin/env python3
"""Build program.a2d.txt from program.template.js.

Base64-embeds the two Dell probe inputs (P1 minimal; P2 the byte-exact
canonical 235-byte input.json of invocation inv_20260929T142355Z-d8b6fb,
sha256 e3ab8b7bafdc…f36394) as single-line strings, syntax-checks the result
as a ptc async function body, and refuses to leave any placeholder
unresolved. Exits non-zero on any problem.
"""
import base64
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
A2D_BOOT = pathlib.Path('/Users/adam26/dsh-a0-boot/a2d')

P2_SHA256 = 'e3ab8b7bafdc2b3594b599e09d8d8ca6fc815059f55ede1cfde77450cbf36394'

template = (HERE / 'program.template.js').read_text()
p1_bytes = (HERE / 'p1-input.json').read_bytes()
p2_bytes = (HERE / 'p2-input.json').read_bytes()

# canonical-byte gate: the P2 payload must be exactly the calibrated input
p2_sha = hashlib.sha256(p2_bytes).hexdigest()
if p2_sha != P2_SHA256:
    raise SystemExit(f'p2-input.json sha256 {p2_sha} != canonical {P2_SHA256}')
if len(p2_bytes) != 235:
    raise SystemExit(f'p2-input.json is {len(p2_bytes)} bytes, expected 235')

json.loads(p1_bytes.decode())
json.loads(p2_bytes.decode())

payloads = {
    '__B64_P1__': p1_bytes,
    '__B64_P2__': p2_bytes,
}
body = template
for ph, raw in payloads.items():
    b64 = base64.b64encode(raw).decode()  # single line, no wrapping
    if ph not in body:
        raise SystemExit(f'placeholder {ph} missing from template')
    if '\n' in b64 or ' ' in b64:
        raise SystemExit(f'placeholder {ph} encoding is not single-line')
    body = body.replace(ph, b64)

out = A2D_BOOT / 'program.a2d.txt'
out.write_text(body)
print(f'wrote {out} ({len(body)} chars)')

# Syntax check as a ptc async function body (same wrapper the runtime uses)
probe = f'return (async () => {{\n{body}\n}})();'
node = f'new Function("tools", {json.dumps(probe)}); console.log("syntax ok");'
r = subprocess.run(['node', '-e', node], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stderr)
    raise SystemExit('syntax check failed')
print(r.stdout.strip())

# No unresolved placeholders
if re.search(r'__B64_[A-Z]+__', body):
    raise SystemExit('unresolved placeholder remains')
print('placeholders all resolved; p2 payload canonical sha verified')
