# RCOS on DeepSeek Desktop

## Status

**Working development integration. Desktop is the primary RCOS operator seat.**

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

The current development integration includes native operator surfaces,
General/Idea → Workflow Manager dispatch, bounded tool permissions,
session-bound execution activity, Canvas/artifact surfaces and receipt-gated
handoff. The standalone operator UI remains useful as a debug, portability and
public reference surface; it is not intended to replace the Desktop seat.

## Public-release boundary

The working Desktop implementation is ahead of this repository's public
`main`. The public checkout still ships and documents the older DSH web-profile
package and its locked compatibility pin.

That means two statements are both true:

1. **Desktop works in current RCOS development.**
2. **A fresh public clone does not yet reproduce the complete Desktop
   installation.**

We will call Desktop a public release only after the exact working
source/configuration is published here (or in the canonical public RCOS
repository), the install path is documented, and a clean isolated install is
re-run end to end.

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
