# Execution source store contract (C1)

`createExecutionSourceStore()` is a pure in-memory identity and lifetime boundary
for already-projected `dispatch_seat` and `job_list` observations. It does not
discover calls, read DSH state, authorize access, prove a source, or create
PanelDoc bindings. Only a future host adapter can establish authorization and
must pass an authorized host context. Matching checks here reduce accidental
mixing; they are not proof of permission.

The host context is exactly `{workspaceId, sessionId, callId, toolName}`. All
four values must be nonblank strings of at most 512 characters; `toolName` is
`dispatch_seat` or `job_list`. A missing workspace makes the selection
unavailable. The store never synthesizes one for standalone sessions. Selection
tokens are opaque, unique in-memory generation objects; every call to `select`
issues a new generation, including reselecting the same context. Invalid
selection and `select(null)` clear context and data. Late results from an old
generation are rejected.

`accept(token, observation)` accepts only the selected four-field identity and
the envelope keys `kind`, `phase`, `observedAt`, `values`, with optional
`reportedRun` and `reason`. `kind` is `dsh-call-snapshot`; `phase` is `pending`,
`settled`, or `unavailable`. `observedAt` is null or a nonnegative safe integer
within the JavaScript Date range in Unix milliseconds. The store never fills in
time. Text fields are capped at 10,000 characters and remain exact strings or
null. These are local display/input bounds, not upstream DSH limits.

The normalized stored observation omits its repeated identity fields because
the exact validated identity is already stored at `snapshot.context`. It holds
only `{kind, phase, observedAt, values}` and, when valid, `reportedRun`.
`reason` is copied to the snapshot's top-level `reason`.

For `dispatch_seat`, `values` may contain only `seat`, `objective`, `state`,
`verdict`, `summary`, `stage`, `auditLog`, `auditError`, `archonRunId`, and
`archonStatus`. State is `awaiting-result`, `unavailable`, `failed`, `blocked`,
or `completed`. Pending is only `awaiting-result` and may include `seat` and
`objective`; unavailable must be `unavailable` and cannot retain verdict,
stage, Archon IDs/status, audit log, or reported-run claims. Settled data cannot
claim `awaiting-result`. `completed` requires stage `complete` and verdict
`ship` or `fix`; `blocked` requires verdict `blocked`; `failed` cannot carry a
seat-reported verdict. On a failed `resolve`, `create`, or `error` stage the
dispatcher wrapper's top-level verdict may be `blocked`, but the projector's
`values.verdict` comes from the required empty receipt and is null.
Any WM `unavailable` state requires phase `unavailable`; `settled` is reserved
for a recognized structured result. `reportedRun` is optional and permitted only for settled WM data; when
present it must contain exactly two nonblank IDs, `runId` and `seatSessionId`.
The `none` sentinel is not an identity. These are seat-reported values, not
independently verified claims.

For `job_list`, `values` may contain only `state`, `summary`, and `jobCount`.
Pending is `awaiting-result`; a settled `snapshot` requires a safe nonnegative
integer `jobCount`; settled `failed` and `unavailable` states carry no count.
Unavailable data cannot claim a count, and job state `unavailable` requires
phase `unavailable`. Settled is reserved for recognized structured results,
including a structured job snapshot or failure. Job observations never contain
`reportedRun`; a job snapshot is not a workflow run or a live worker stream.

The current snapshot shape is `{context, availability, observation, reason}`.
Before an observation, availability is `unknown` and reason explains the empty
selection or pending observation. Accepted availability follows its phase.
Snapshots and all nested data are copied and frozen. `getSnapshot()` preserves
reference identity until a selection, accepted observation, or disposal changes
state. Listener exceptions are isolated. Unsubscribe removes that listener;
`dispose()` clears data, notifies current listeners once, then prevents reuse.
There is no persistence or implicit live state.

This store keeps DSH identity separate from reported dispatcher identity. It
does not export `BindingSources`, mint `run:` or `artifact:` references, bind a
DSH call ID to an Archon run, or change PanelDoc grammar. A later adapter must
perform authorization before it supplies any selected context or observation.
