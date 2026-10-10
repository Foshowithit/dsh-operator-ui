# RCOS on DeepSeek Desktop

## Status

**Development preview. Desktop is the intended primary RCOS operator seat.**

RCOS is not a fork of DeepSeek Desktop and does not treat DSH as the RCOS
kernel. Desktop owns the shell, sessions and model-facing experience. RCOS
provides the governed control plane around work:

```text
General / Idea
    ↓
Workflow Manager
    ↓
typed RCOS routing / capability decision
    ↓
Archon + bounded workers/tools
    ↓
artifacts + executed evidence
    ↓
evaluation / receipt
    ↓
capability result and reuse
```

The Desktop integration is **in development**, not a public release. The
in-development integration exercises the pieces above — native operator
surfaces, General/Idea → Workflow Manager dispatch, bounded tool permissions,
session-bound execution activity, Canvas/artifact surfaces and receipt-gated
handoff — against the intended direction. These are development-preview
capabilities; they are not a published, fresh-clone-reproducible install (see
the public-release boundary below). The standalone operator UI (this
repository's shipped DSH web package) remains the current public, reproducible
install and a useful debug, portability and public reference surface; it is not
intended to replace the Desktop seat.

## Public-release boundary

The in-development Desktop implementation is ahead of this repository's
public `main`. The public checkout still ships and documents the older DSH web-profile
package and its locked compatibility pin.

That means two statements are both true:

1. **The Desktop integration is in active development as the intended primary
   RCOS seat.**
2. **A fresh public clone does not yet reproduce the complete Desktop
   installation.**

We will call Desktop a public release only after the exact working
source/configuration is published here (or in the canonical public RCOS
repository), the install path is documented, and a clean isolated install is
re-run end to end. Publication of the private canonical RCOS source is
additionally gated on a full history / privacy / licensing review — an
allowlist credential scan of the tracked tree is not that audit.

## What the public release must preserve

- RCOS remains portable across seats; Desktop is an integration, not the
  definition of RCOS.
- Authority is explicit and bounded. A UI affordance is not permission.
- Routing/capability decisions are observable rather than inferred from chat.
- Execution claims require executed evidence and receipts.
- Missing capabilities refuse honestly instead of fabricating progress.
- Existing Desktop profiles and chats must survive install, restart and
  removal.
- Version and host compatibility must be pinned by observed behavior, not
  package-version strings alone.

## Current public package

For the reproducible package that is already public today, use the web-profile
instructions in the repository README, `DEPLOY.md`, and `COMPAT.md`.
Those instructions are a compatibility fallback and public reference while the
newer Desktop package is being published; they are not the long-term product
direction.
