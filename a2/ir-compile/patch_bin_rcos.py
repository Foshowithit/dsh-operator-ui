#!/usr/bin/env python3
"""Insert the ir-compile case into ~/zcode-rcos/bin/rcos (additive, idempotent)."""
import sys

PATH = "/home/chow/zcode-rcos/bin/rcos"
src = open(PATH).read()

if "ir-compile" in src:
    print("already patched")
    sys.exit(0)

REQ_ANCHOR = "const { renderDashboard } = require('../lib/render');\n"
REQ_NEW = REQ_ANCHOR + "const IRC = require('../lib/ir-compile');\n"

USAGE_ANCHOR = "  help'"
USAGE_NEW = (
    "  ir-compile --ir <plan.json> [--name <slug>] [--out <file>] [--install]',\n"
    "  '      (RCOS IR v0.1 -> Archon DAG, additive namespace rcos-ir-<name>;',\n"
    "  '       --install writes to ~/.archon/workflows/. Fails closed on agent-class',\n"
    "  '       nodes and non-run memory scopes)',\n"
    "  '  help'"
)

CASE_ANCHOR = "      default: {"
CASE_NEW = """      case 'ir-compile': {
        need(args, 'ir');
        let ir;
        try {
          ir = JSON.parse(fs.readFileSync(args.ir, 'utf8'));
        } catch (e) {
          console.error('rcos: --ir is not readable JSON: ' + e.message);
          process.exit(2);
        }
        const sourceSha = require('node:crypto').createHash('sha256')
          .update(fs.readFileSync(args.ir)).digest('hex');
        const name = args.name === undefined ? IRC.slugFromObjective(ir) : String(args.name);
        const res = IRC.compileIR(ir, { name, sourceSha256: sourceSha });
        if (!res.ok) {
          console.error('rcos: ir-compile failed (' + res.errors.length + ' error' +
            (res.errors.length === 1 ? '' : 's') + ') — IR does not compile:');
          for (const e of res.errors) console.error('  - ' + e);
          process.exit(3);
        }
        for (const w of res.warnings) console.error('warn: ' + w);
        const out = args.out === undefined || args.out === true
          ? path.join(process.cwd(), res.meta.filename)
          : String(args.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, res.yaml);
        console.log('compiled ' + res.meta.name + ' -> ' + out + ' (' + res.meta.nodeCount +
          ' nodes' + (res.meta.approvalCount ? ', ' + res.meta.approvalCount + ' approval gates' : '') +
          (res.meta.executedCapabilityCount ? ', ' + res.meta.executedCapabilityCount + ' executed capability refs' : '') + ')');
        if (args.install === true) {
          const destDir = path.join(os.homedir(), '.archon', 'workflows');
          const dest = path.join(destDir, res.meta.filename);
          fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(dest, res.yaml);
          console.log('installed (additive) -> ' + dest);
        }
        process.exit(0);
      }
      default: {"""

for anchor, new, label in [
    (REQ_ANCHOR, REQ_NEW, "require"),
    (USAGE_ANCHOR, USAGE_NEW, "usage"),
    (CASE_ANCHOR, CASE_NEW, "case"),
]:
    if src.count(anchor) != 1:
        print(f"anchor for {label} found {src.count(anchor)} times (want exactly 1) — aborting, no changes written")
        sys.exit(2)
    src = src.replace(anchor, new)

open(PATH, "w").write(src)
print("patched: require + usage + case inserted")
