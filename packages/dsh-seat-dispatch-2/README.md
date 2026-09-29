# dsh-seat-dispatch-2

An RC.1-compatible `dispatch_seat` tool for the General/Idea seat. It creates a
fresh-root Workflow Manager seat, sends one bounded work envelope, accepts one
validated receipt, and records each dispatch or refusal in an append-only audit
log.

## Runtime target and port

This package targets the installed DSH runtime `0.2.0-rc.1`. Its `dsh-tools`,
`dsh-llm`, and `dsh-session` peers are pinned to that version so RC.1 does not
skip the bundle for the old `^0.1.0-rc.8` ranges. The `runtime-compatibility`
test calls RC.1's actual `evaluatePluginCompatibility` function.

The source port includes two RC.1 session changes:

- Transcript reads use `session.snapshotEvents()` instead of the removed
  `session.events` property.
- A plugin-authored turn uses source kind `plugin:seat-dispatch`, the session
  format accepted by RC.1.

The `createUserMessage`, `SessionId`, `defineTool`, and async
`agentPresets.mount(ctx, id)` call shapes remain compatible. The existing
`agents.create({ sessionId, meta, agentOptions, setup })` path was exercised by
the separate RC.1 scratch dispatch runs. The preset-definition mechanism did
change: RC.1 composes declarative `@deepseek-ai/dsh-agent-preset` rows and does
not scan `.agent-presets` directories.

## Composition boundary

Insert this plugin row only inside the `general-idea` preset composition, with
`callerPreset: general-idea` and `seats: [workflow-manager]`. Do not add the
dispatcher as a host-wide tool: the Workflow Manager preset must not be able to
dispatch another seat. The profile must also declare the `workflow-manager`
preset through RC.1's preset registry.

The dispatcher checks the caller's live preset and delegation lineage, admits
only configured seat ids, mounts the target preset into the new agent scope,
and accepts success only from a validated receipt submitted by that agent.
Receipt schema, one-shot behavior, and audit fields are kept from the prior
dispatcher contract.

## Verification status

The package suite uses the actual DSH 0.2.0-rc.1 libraries and loader. Run it
from this package with the runtime's module directory available:

```sh
DSH_RUNTIME_NODE_MODULES=/path/to/dsh/node_modules npm test
```

The port suite passes against the RC.1 schemas and peer-compatibility checker.
It is not yet wired into the normal Desktop profile; the General/Workflow
Manager presets and isolated profile acceptance are the next integration step.
