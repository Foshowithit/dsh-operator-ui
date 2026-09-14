# Contributing

Short version for humans and agents alike:

1. **Branch** off `main`.
2. **Set up the isolated dev environment** (see `AGENTS.md` — never use a real `~/.dsh`).
3. **Make the change.** Keep registrations additive; keep the host half read-only; keep the module dependency-free (client half is a hand-written ModuleLoader module — `require` is limited to seeded externals like `react`).
4. **Run the contract test:** `node scripts/check.js` — must pass.
5. **Verify by hand in the dev UI** (all four tabs render; your feature works; then `dsh plugin remove` → the UI reverts to stock and existing sessions are untouched).
6. **PR.** Describe what you changed and what you verified. Screenshots welcome — fixture content only.

## Adding a feature — walkthrough

The shape of every client-side feature here:

```js
// inside the module factory in lib/client.js
const MyPanel = (props) => { /* read ctx via props.__opuiCtx; render with h() */ };

const dispose = ctx.slots.inject('conversation.view', () =>
  ctx.slots.register({
    name: 'conversation.view',
    id: 'my-panel',        // unique
    order: 40,             // tab position
    label: () => 'My Panel',
    inject: () => ({ __opuiCtx: ctx }),
  }, (props) => h(MyPanel, props)));
// return a disposer from ctx.effect that undoes it
```

Rules of the road: data comes from `ctx.sessions` / `ctx.workspaces` / projections — or from a new **read-only, fixed-argv host route** in `lib/index.js` if you genuinely need host-side facts. No exceptions without discussion.
