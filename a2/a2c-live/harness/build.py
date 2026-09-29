#!/usr/bin/env python3
"""Build program.live.txt from program.template.js.

Base64-embeds the four Dell payloads (find helper, live verifier, IR plan,
capability input) as single-line strings into the template, then syntax-checks
the result as a ptc async function body and validates the embedded JSON
payloads. Exits non-zero on any problem.
"""
import base64
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
A2C = HERE.parent

template = (HERE / 'program.template.js').read_text()
payloads = {
    '__B64_FIND__': (HERE / 'find.py').read_bytes(),
    '__B64_VERIFY__': (HERE / 'verify.py').read_bytes(),
    '__B64_IR__': (A2C / 'ir-plan.json').read_bytes(),
    '__B64_INPUT__': (HERE / 'capability-input.json').read_bytes(),
}

# JSON payloads must be valid before embedding
json.loads(payloads['__B64_IR__'].decode())
json.loads(payloads['__B64_INPUT__'].decode())

body = template
for ph, raw in payloads.items():
    b64 = base64.b64encode(raw).decode()  # single line, no wrapping
    if ph not in body:
        raise SystemExit(f'placeholder {ph} missing from template')
    if '\n' in b64 or ' ' in b64:
        raise SystemExit(f'placeholder {ph} encoding is not single-line')
    body = body.replace(ph, b64)

out = A2C / 'program.live.txt'
out.write_text(body)
print(f'wrote {out} ({len(body)} chars)')

# Syntax check as a ptc async function body (same wrapper the runtime uses)
probe = f'return (async () => {{\n{body}\n}})();'
node = f'new Function("tools", {json.dumps(probe)}); console.log("syntax ok");'
import subprocess
r = subprocess.run(['node', '-e', node], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stderr)
    raise SystemExit('syntax check failed')
print(r.stdout.strip())

# No unresolved placeholders
if re.search(r'__B64_[A-Z]+__', body):
    raise SystemExit('unresolved placeholder remains')
print('placeholders all resolved')
