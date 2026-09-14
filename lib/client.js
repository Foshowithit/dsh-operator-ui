// dsh-operator-ui — client half: the Runs tab.
//
// Hand-written static client module in DSH's served ModuleLoader format
// (identical in shape to the shipped bundles): window.__ModuleLoader__.load
// with require limited to the seeded externals (react).
//
// Everything rendered here is authoritative Host state, delivered by the
// services the web profile already mounts — nothing is polled, duplicated,
// or inferred:
//   - ctx.sessions.list          → every session row: status, title, cwd,
//                                  preset, updated, projectionValues
//                                  (contextPressure / tokenUsage), jobs
//   - ctx.sessions.binding(id)   → per-session face: live queue (queued /
//                                  steering), running tool calls, prompt /
//                                  updateQueue / cancel verbs
// The tab registers into the additive `conversation.view` list seat beside
// Conversation and Trajectory; removing the plugin row removes every effect
// (style tag, slot entry) with it.

window.__ModuleLoader__.load({
  id: 'dsh-operator-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    // ---------------------------------------------------------------- helpers

    const EmptyLive = Object.freeze({
      queue: [], runningCalls: [], pending: [], running: false,
    });
    const EmptyLiveStore = {
      getSnapshot: () => EmptyLive,
      subscribe: () => () => {},
    };

    const relTime = (ts, now) => {
      if (!ts) return '';
      const s = Math.max(0, Math.round((now - ts) / 1000));
      if (s < 45) return s + 's';
      const m = Math.round(s / 60);
      if (m < 60) return m + 'm';
      const h = Math.round(m / 60);
      if (h < 48) return h + 'h';
      return Math.round(h / 24) + 'd';
    };

    const fmtTokens = (n) => {
      if (n == null) return '';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
      return String(n);
    };

    const basename = (p) => {
      if (!p) return '';
      const parts = String(p).split('/');
      return parts[parts.length - 1] || p;
    };

    const pressure = (row) => {
      const cp = row.projectionValues && row.projectionValues.contextPressure;
      if (!cp) return null;
      const used = cp.projectedTokens != null ? cp.projectedTokens : cp.pressureTokens;
      const win = cp.contextWindow;
      if (used == null) return null;
      return { used, win: win || null, pct: win ? Math.min(100, Math.round((used / win) * 100)) : null };
    };

    const usageTotal = (row) => {
      const u = row.projectionValues && row.projectionValues.tokenUsage;
      if (!u) return null;
      return (u.uncachedInputTokens || 0) + (u.cacheReadTokens || 0) +
        (u.cacheWriteTokens || 0) + (u.outputTokens || 0);
    };

    const rowStatus = (row) => {
      if (row.pendingInteraction) return 'attention';
      if (row.running) return 'running';
      if (row.completed) return 'done';
      if (row.blank) return 'blank';
      return 'idle';
    };

    const STATUS_RANK = { attention: 0, running: 1, done: 2, idle: 3, blank: 4 };

    // SessionSummary rows carry `id` on the standard feed; stay tolerant of
    // the wire spelling (`sessionId`) so shape drift degrades, not crashes.
    const rowId = (row) => row.id ?? row.sessionId;
    const parentId = (row) => row.parentId ?? row.parentSessionId;

    const displayTitle = (row) =>
      row.displayTitle || row.title || basename(row.cwd) || rowId(row);

    // ---------------------------------------------------------------- styles

    const CSS = `
.opui-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-static-neutral-800,#24292f);background:transparent}
body[data-ds-dark-theme] .opui-root{color:var(--dsw-static-neutral-100,#e6edf3)}
.opui-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-static-neutral-100,#d8dee4);flex:none}
body[data-ds-dark-theme] .opui-head{border-bottom-color:var(--dsw-static-neutral-700,#30363d)}
.opui-head h2{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em}
.opui-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-static-neutral-100,#d8dee4);color:inherit}
.opui-chip b{font-weight:600}
.opui-chip.att{border-color:var(--dsw-static-amber-500,#d97706);color:var(--dsw-static-amber-600,#b45309)}
.opui-chip.run{border-color:var(--dsw-static-blue-500,#4c6ef5);color:var(--dsw-static-blue-600,#3b5bdb)}
.opui-spacer{flex:1}
.opui-hint{font-size:11px;opacity:.65}
.opui-body{display:flex;flex:1;min-height:0}
.opui-tablewrap{flex:1.6;min-width:0;overflow:auto}
.opui-table{width:100%;border-collapse:collapse}
.opui-table th{position:sticky;top:0;background:var(--dsw-static-neutral-50,#f6f8fa);font-size:11px;font-weight:500;text-align:left;padding:6px 10px;border-bottom:1px solid var(--dsw-static-neutral-100,#d8dee4);z-index:1}
body[data-ds-dark-theme] .opui-table th{background:var(--dsw-static-neutral-800,#161b22);border-bottom-color:var(--dsw-static-neutral-700,#30363d)}
.opui-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-static-neutral-100,#eef1f4);vertical-align:middle;white-space:nowrap}
body[data-ds-dark-theme] .opui-table td{border-bottom-color:var(--dsw-static-neutral-800,#21262d)}
.opui-row{cursor:pointer}
.opui-row:hover td{background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-row:hover td{background:var(--dsw-static-neutral-800,#161b22)}
.opui-row.sel td{background:var(--dsw-static-blue-50,#edf2ff)}
body[data-ds-dark-theme] .opui-row.sel td{background:rgba(76,110,245,.12)}
.opui-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.opui-dot.attention{background:var(--dsw-static-amber-500,#d97706);box-shadow:0 0 0 3px rgba(217,119,6,.18)}
.opui-dot.running{background:var(--dsw-static-blue-500,#4c6ef5);box-shadow:0 0 0 3px rgba(76,110,245,.18);animation:opui-pulse 1.6s ease-in-out infinite}
.opui-dot.done{background:var(--dsw-static-green-500,#2f9e44)}
.opui-dot.blank{background:var(--dsw-static-neutral-300,#c4ccd4)}
.opui-dot.idle{background:var(--dsw-static-neutral-400,#8b949e)}
@keyframes opui-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.opui-title{font-weight:500;max-width:340px;overflow:hidden;text-overflow:ellipsis}
.opui-sub{font-size:11px;opacity:.62;max-width:340px;overflow:hidden;text-overflow:ellipsis}
.opui-badge{display:inline-block;min-width:18px;text-align:center;padding:1px 5px;border-radius:8px;font-size:10.5px;background:var(--dsw-static-neutral-100,#e7ebef)}
body[data-ds-dark-theme] .opui-badge{background:var(--dsw-static-neutral-700,#30363d)}
.opui-badge.live{background:var(--dsw-static-blue-100,#dbe4ff);color:var(--dsw-static-blue-700,#3b5bdb)}
.opui-meter{display:flex;align-items:center;gap:6px}
.opui-bar{width:64px;height:5px;border-radius:3px;background:var(--dsw-static-neutral-100,#e7ebef);overflow:hidden}
body[data-ds-dark-theme] .opui-bar{background:var(--dsw-static-neutral-700,#30363d)}
.opui-bar i{display:block;height:100%;background:var(--dsw-static-blue-500,#4c6ef5)}
.opui-bar.warn i{background:var(--dsw-static-amber-500,#d97706)}
.opui-bar.crit i{background:var(--dsw-static-red-500,#e03131)}
.opui-pct{font-size:11px;min-width:34px;opacity:.8}
.opui-num{font-size:11px;opacity:.75}
.opui-empty{padding:40px 16px;text-align:center;opacity:.6}
.opui-detail{flex:1;min-width:280px;max-width:420px;border-left:1px solid var(--dsw-static-neutral-100,#d8dee4);overflow:auto;padding:14px 16px}
body[data-ds-dark-theme] .opui-detail{border-left-color:var(--dsw-static-neutral-700,#30363d)}
.opui-detail h3{margin:0 0 2px;font-size:14px;font-weight:600;word-break:break-word}
.opui-detail .opui-sub{margin-bottom:10px;max-width:none}
.opui-sec{margin:14px 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;opacity:.6}
.opui-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px}
.opui-kv span:first-child{opacity:.62}
.opui-actions{display:flex;gap:8px;margin:10px 0 4px}
.opui-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);background:transparent;color:inherit;cursor:pointer}
.opui-btn:hover{background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-btn:hover{background:var(--dsw-static-neutral-800,#161b22)}
.opui-btn.primary{border-color:var(--dsw-static-blue-500,#4c6ef5);color:var(--dsw-static-blue-600,#3b5bdb)}
.opui-btn.danger{border-color:var(--dsw-static-red-400,#f03e3e);color:var(--dsw-static-red-600,#c92a2a)}
.opui-item{display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:12px;border-bottom:1px dashed var(--dsw-static-neutral-100,#eef1f4)}
.opui-item .opui-kind{font-size:10.5px;font-weight:600;letter-spacing:.03em;border-radius:4px;padding:1px 5px;flex:none}
.opui-kind.q{background:var(--dsw-static-blue-100,#dbe4ff);color:var(--dsw-static-blue-700,#3b5bdb)}
.opui-kind.s{background:var(--dsw-static-amber-100,#fff3bf);color:var(--dsw-static-amber-700,#a86600)}
.opui-kind.t{background:var(--dsw-static-neutral-100,#e7ebef);opacity:.9}
.opui-kind.j{background:var(--dsw-static-green-100,#d3f9d8);color:var(--dsw-static-green-700,#2b8a3e)}
.opui-item .opui-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opui-item .opui-meta{font-size:11px;opacity:.6;flex:none}
.opui-none{font-size:12px;opacity:.5;padding:4px 0}
.opui-pal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:900;display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
.opui-pal{width:min(560px,92vw);background:var(--dsw-static-neutral-50,#ffffff);border:1px solid var(--dsw-static-neutral-200,#c9d1d9);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column}
body[data-ds-dark-theme] .opui-pal{background:var(--dsw-static-neutral-800,#161b22);border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-pal input{font:inherit;font-size:14px;padding:13px 16px;border:none;outline:none;background:transparent;color:inherit;border-bottom:1px solid var(--dsw-static-neutral-100,#d8dee4)}
body[data-ds-dark-theme] .opui-pal input{border-bottom-color:var(--dsw-static-neutral-700,#30363d)}
.opui-pal-list{max-height:46vh;overflow:auto;padding:6px}
.opui-pal-item{display:flex;align-items:baseline;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px}
.opui-pal-item .opui-pal-kind{font-size:10.5px;font-weight:600;letter-spacing:.04em;flex:none;width:58px;opacity:.55;text-transform:uppercase}
.opui-pal-item .opui-pal-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opui-pal-item .opui-pal-hint{font-size:11px;opacity:.5;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.opui-pal-item.act{background:var(--dsw-static-blue-50,#edf2ff)}
body[data-ds-dark-theme] .opui-pal-item.act{background:rgba(76,110,245,.16)}
.opui-pal-empty{padding:18px;text-align:center;font-size:12px;opacity:.55}
.opui-pal-foot{display:flex;gap:12px;padding:7px 12px;border-top:1px solid var(--dsw-static-neutral-100,#d8dee4);font-size:10.5px;opacity:.55}
body[data-ds-dark-theme] .opui-pal-foot{border-top-color:var(--dsw-static-neutral-700,#30363d)}
.opui-git-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-static-neutral-100,#d8dee4);flex:none;flex-wrap:wrap}
body[data-ds-dark-theme] .opui-git-head{border-bottom-color:var(--dsw-static-neutral-700,#30363d)}
.opui-git-branch{font-weight:600;font-size:13px}
.opui-git-meta{font-size:11px;opacity:.65}
.opui-git-body{flex:1;min-height:0;overflow:auto;padding:10px 16px;font-size:13px;color:var(--dsw-static-neutral-800,#24292f)}
body[data-ds-dark-theme] .opui-git-body{color:var(--dsw-static-neutral-100,#e6edf3)}
.opui-git-sec{margin:12px 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;opacity:.6}
.opui-git-file{display:flex;align-items:baseline;gap:8px;padding:3px 6px;border-radius:6px;font-size:12px;cursor:default}
.opui-git-file.diffable{cursor:pointer}
.opui-git-file.diffable:hover{background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-git-file.diffable:hover{background:var(--dsw-static-neutral-800,#161b22)}
.opui-git-file.open{background:var(--dsw-static-blue-50,#edf2ff)}
body[data-ds-dark-theme] .opui-git-file.open{background:rgba(76,110,245,.12)}
.opui-git-xy{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;font-weight:700;width:22px;flex:none;opacity:.85}
.opui-git-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opui-git-note{font-size:11px;opacity:.55}
.opui-git-diff{margin:6px 0 10px;padding:10px;border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:8px;background:var(--dsw-static-neutral-50,#f6f8fa);overflow:auto;max-height:340px}
body[data-ds-dark-theme] .opui-git-diff{background:var(--dsw-static-neutral-900,#0d1117);border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-git-diff pre{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.opui-git-log{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;opacity:.85;padding:2px 6px}
.opui-git-empty{padding:24px 0;text-align:center;opacity:.6}
.opui-git-err{padding:16px;color:var(--dsw-static-red-600,#c92a2a);font-size:12px}
.opui-filter{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);background:transparent;color:inherit;width:170px;outline:none}
.opui-filter:focus{border-color:var(--dsw-static-blue-500,#4c6ef5)}
.opui-git-filter{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);background:transparent;color:inherit;width:200px;outline:none;margin-right:8px}
body[data-ds-dark-theme] .opui-git-filter{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-git-filter:focus{border-color:var(--dsw-static-blue-500,#4c6ef5)}
`;

    let styleEl = null;

    // ------------------------------------------------------------- components

    const useTick = (ms) => {
      const [, force] = useState(0);
      useEffect(() => {
        const t = setInterval(() => force((n) => n + 1), ms);
        return () => clearInterval(t);
      }, [ms]);
    };

    const Meter = ({ p }) => {
      if (!p) return h('span', { className: 'opui-num' }, '—');
      const cls = p.pct == null ? '' : p.pct >= 95 ? ' crit' : p.pct >= 80 ? ' warn' : '';
      return h('div', { className: 'opui-meter' },
        h('div', { className: 'opui-bar' + cls },
          h('i', { style: { width: (p.pct == null ? 0 : Math.min(100, p.pct)) + '%' } })),
        h('span', { className: 'opui-pct' },
          p.pct == null ? fmtTokens(p.used) : p.pct + '%'));
    };

    const Row = ({ row, jobs, queueCount, selected, onSelect, now }) => {
      const st = rowStatus(row);
      const p = pressure(row);
      const tok = usageTotal(row);
      return h('tr', {
        className: 'opui-row' + (selected ? ' sel' : ''),
        onClick: () => onSelect(rowId(row)),
      },
        h('td', null, h('span', { className: 'opui-dot ' + st, title: st })),
        h('td', null,
          h('div', { className: 'opui-title' }, displayTitle(row),
            row.agentPreset ? ' ' : null,
            row.agentPreset ? h('span', { className: 'opui-badge' }, row.agentPreset) : null),
          h('div', { className: 'opui-sub' },
            (row.origin === 'subagent' ? 'subagent · ' : '') + (row.cwd || ''))),
        h('td', { className: 'opui-num' }, relTime(row.updatedAt, now)),
        h('td', null, h(Meter, { p })),
        h('td', { className: 'opui-num' }, tok == null ? '—' : fmtTokens(tok)),
        h('td', null,
          jobs && jobs.length ? h('span', { className: 'opui-badge live', title: 'background jobs' }, jobs.length) : null,
          queueCount ? h('span', { className: 'opui-badge', style: { marginLeft: jobs && jobs.length ? 4 : 0 }, title: 'queued / steering' }, queueCount) : null));
    };

    const Detail = ({ ctx, row, jobs, live, binding, onClose }) => {
      const p = pressure(row);
      const tok = usageTotal(row);
      const liveQueue = (live && live.queue) || [];
      const runningCalls = (live && live.runningCalls) || [];
      const jobList = jobs || [];
      const session = binding && binding.session;
      const open = (e) => { e.stopPropagation(); ctx.sessions.open(rowId(row)); };
      const cancel = (e) => {
        e.stopPropagation();
        if (session) session.cancel().catch(() => {});
      };
      return h('div', { className: 'opui-detail' },
        h('h3', null, displayTitle(row)),
        h('div', { className: 'opui-sub' }, row.cwd || rowId(row)),
        h('div', { className: 'opui-actions' },
          h('button', { className: 'opui-btn primary', onClick: open }, 'Open'),
          live && live.running && session
            ? h('button', { className: 'opui-btn danger', onClick: cancel }, 'Cancel turn') : null,
          onClose ? h('button', { className: 'opui-btn', onClick: (e) => { e.stopPropagation(); onClose(); } }, 'Close') : null),
        h('div', { className: 'opui-sec' }, 'Session'),
        kv('Status', rowStatus(row)),
        row.agentPreset ? kv('Preset', row.agentPreset) : null,
        kv('Updated', relTime(row.updatedAt, Date.now()) + ' ago'),
        p ? kv('Context', fmtTokens(p.used) + (p.win ? ' / ' + fmtTokens(p.win) : '') + (p.pct != null ? ' (' + p.pct + '%)' : '')) : null,
        tok != null ? kv('Tokens (session)', fmtTokens(tok)) : null,
        h('div', { className: 'opui-sec' }, 'Inbox'),
        liveQueue.length === 0
          ? (binding
            ? h('div', { className: 'opui-none' }, 'No pending input')
            : h('div', { className: 'opui-none' }, 'Live inbox detail attaches when this session is opened'))
          : liveQueue.map((q, i) => h('div', { key: i, className: 'opui-item' },
            h('span', { className: 'opui-kind ' + (q.placement === 'steering' ? 's' : 'q') },
              q.placement === 'steering' ? 'steer' : 'queued'),
            h('span', { className: 'opui-txt' }, q.preview || '(message)'),
            q.placement === 'queued' && session
              ? h('button', {
                className: 'opui-btn',
                style: { fontSize: '10.5px', padding: '1px 8px', flex: 'none' },
                title: 'Remove this queued message',
                onClick: (e) => {
                  e.stopPropagation();
                  session.updateQueue(q.id, { kind: 'remove' }).catch(() => {});
                },
              }, 'Remove')
              : h('span', { className: 'opui-meta' }, ''))),
        h('div', { className: 'opui-sec' }, 'Running tools'),
        runningCalls.length === 0
          ? h('div', { className: 'opui-none' }, live && live.running ? '—' : 'Not running')
          : runningCalls.map((c, i) => h('div', { key: i, className: 'opui-item' },
            h('span', { className: 'opui-kind t' }, 'tool'),
            h('span', { className: 'opui-txt' }, c.name || c.callId || 'call'),
            h('span', { className: 'opui-meta' }, ''))),
        h('div', { className: 'opui-sec' }, 'Background jobs'),
        jobList.length === 0
          ? h('div', { className: 'opui-none' }, 'None')
          : jobList.map((j, i) => h('div', { key: i, className: 'opui-item' },
            h('span', { className: 'opui-kind j' }, j.status || '?'),
            h('span', { className: 'opui-txt' }, j.label || j.kind || j.id || 'job'),
            h('span', { className: 'opui-meta' }, relTime(j.startedAt, Date.now()) || ''))));
    };

    const kv = (k, v) => h('div', { className: 'opui-kv' }, h('span', null, k), h('span', null, v));

    const h = React.createElement;

    const RunsTabInner = (props) => {
      useTick(30000);
      const ctx = props.__opuiCtx;
      const list = useSyncExternalStore(
        ctx.sessions.list.subscribe.bind(ctx.sessions.list),
        () => ctx.sessions.list.getSnapshot());
      const [selected, setSelected] = useState(null);
      const [filter, setFilter] = useState('');

      // Standard sessions feed: {ids, byId, current, phase, jobsBySession}.
      const items = useMemo(() => {
        const ids = list.ids || [];
        const byId = list.byId || {};
        return ids.map((id) => byId[id]).filter(Boolean);
      }, [list]);
      const jobsBySession = list.jobsBySession || {};
      const rows = useMemo(() => {
        const f = filter.trim().toLowerCase();
        const base = f
          ? items.filter((r) => (displayTitle(r) + ' ' + (r.cwd || '')).toLowerCase().includes(f))
          : items;
        return [...base].sort((a, b) =>
          (STATUS_RANK[rowStatus(a)] - STATUS_RANK[rowStatus(b)]) ||
          (b.updatedAt || 0) - (a.updatedAt || 0));
      }, [items, filter]);

      const counts = useMemo(() => {
        let running = 0, attention = 0, done = 0;
        for (const r of items) {
          const s = rowStatus(r);
          if (s === 'running') running++;
          else if (s === 'attention') attention++;
          else if (s === 'done') done++;
        }
        return { running, attention, done, total: items.length };
      }, [items]);

      const selRow = selected ? items.find((r) => rowId(r) === selected) : null;

      // Live per-session detail for the selected row (stable store identity;
      // fall back to a frozen empty store when the session has no binding).
      const binding = selected ? ctx.sessions.binding(selected) : undefined;
      const liveStore = useMemo(
        () => (binding && binding.session) || EmptyLiveStore,
        [binding]);
      // useSyncExternalStore requires getSnapshot to return a cached
      // reference until the source changes — derive once per upstream
      // snapshot, never per call (React invariant #185 otherwise).
      const liveCache = useRef({ up: undefined, derived: EmptyLive });
      const live = useSyncExternalStore(
        liveStore.subscribe.bind(liveStore),
        () => {
          const snap = liveStore.getSnapshot();
          if (snap !== liveCache.current.up) {
            liveCache.current = {
              up: snap,
              derived: {
                queue: (snap && snap.queue) || [],
                runningCalls: (snap && snap.runningCalls) || [],
                pending: (snap && snap.pending) || [],
                running: !!(snap && snap.running),
              },
            };
          }
          return liveCache.current.derived;
        });

      const now = Date.now();
      const selJobs = selected ? jobsBySession[selected] : undefined;
      const selQueueCount = selected && live && live.queue ? live.queue.length : 0;

      return h('div', { className: 'opui-root' },
        h('div', { className: 'opui-head' },
          h('h2', null, 'Runs'),
          counts.attention ? h('span', { className: 'opui-chip att' }, h('b', null, counts.attention), 'needs attention') : null,
          counts.running ? h('span', { className: 'opui-chip run' }, h('b', null, counts.running), 'running') : null,
          h('span', { className: 'opui-chip' }, h('b', null, counts.total), 'sessions'),
          h('span', { className: 'opui-spacer' }),
          h('input', {
            className: 'opui-filter',
            placeholder: 'Filter sessions…',
            value: filter,
            onChange: (e) => setFilter(e.target.value),
          }),
          h('span', { className: 'opui-hint' }, 'host-authoritative · live')),
        h('div', { className: 'opui-body' },
          h('div', { className: 'opui-tablewrap' },
            items.length === 0
              ? h('div', { className: 'opui-empty' },
                list.phase === 'pending' ? 'Loading sessions…' : 'No sessions yet — create one to see it here.')
              : rows.length === 0
                ? h('div', { className: 'opui-empty' }, 'No sessions match “' + filter + '”.')
              : h('table', { className: 'opui-table' },
                h('thead', null, h('tr', null,
                  h('th', null, ''), h('th', null, 'Session'), h('th', null, 'Updated'),
                  h('th', null, 'Context'), h('th', null, 'Tokens'), h('th', null, 'Work'))),
                h('tbody', null,
                  rows.map((row) => h(Row, {
                    key: rowId(row), row,
                    jobs: jobsBySession[rowId(row)],
                    queueCount: rowId(row) === selected ? selQueueCount : 0,
                    selected: rowId(row) === selected,
                    onSelect: (id) => setSelected((cur) => (cur === id ? null : id)),
                    now,
                  }))))),
          selRow
            ? h(Detail, {
              ctx, row: selRow, jobs: selJobs, live,
              binding: binding || null,
              onClose: () => setSelected(null),
            })
            : null));
    };

    // Render-hardened wrapper: a failure inside the grid must be visible
    // operator feedback, never a swallowed boundary blank.
    const RunsTab = (props) => {
      try {
        if (!props || !props.__opuiCtx) {
          return h('div', { className: 'opui-root', style: { padding: 24, color: '#c92a2a' } },
            'operator-ui: session context missing. props keys: ' +
            (props ? Object.keys(props).join(', ') : String(props)));
        }
        return RunsTabInner(props);
      } catch (e) {
        return h('div', { className: 'opui-root', style: { padding: 24, color: '#c92a2a' } },
          'operator-ui render error: ' + (e && e.message),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 11, opacity: .8 } }, (e && e.stack) || ''));
      }
    };

    // ---------------------------------------------------------------- palette

    // Tiny open-state store (stable snapshot references; the keyboard
    // listener lives in apply so it survives grid unmounts).
    const paletteStore = {
      open: false,
      snapshot: { open: false },
      subscribers: new Set(),
      getSnapshot() { return this.snapshot; },
      subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); },
      set(open) {
        if (this.open === open) return;
        this.open = open;
        this.snapshot = { open };
        for (const fn of this.subscribers) fn();
      },
    };

    const palItems = (ctx) => {
      const items = [];
      items.push({ kind: 'action', label: 'New session', hint: 'current workspace', run: () => ctx.workspaces.startSession() });
      items.push({ kind: 'action', label: 'Toggle sidebar', hint: '', run: () => { const l = ctx.layout; if (l && l.toggleSidebar) l.toggleSidebar(); } });
      for (const name of ['Chat', 'Trajectory', 'Runs']) {
        items.push({
          kind: 'view', label: 'Open ' + name + ' view', hint: '', run: () => {
            const tab = [...document.querySelectorAll('[role="tab"]')]
              .find((t) => t.textContent.trim() === name);
            if (tab) tab.click();
          },
          enabled: () => [...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.trim() === name),
        });
      }
      const list = ctx.sessions.list.getSnapshot();
      const byId = list.byId || {};
      for (const id of list.ids || []) {
        const row = byId[id];
        if (!row || row.blank) continue;
        items.push({
          kind: 'session',
          label: 'Session: ' + displayTitle(row),
          hint: row.cwd || '',
          run: () => ctx.sessions.open(id),
        });
      }
      return items;
    };

    const fuzzyRank = (query, text) => {
      if (!query) return 0;
      const q = query.toLowerCase();
      const t = text.toLowerCase();
      const idx = t.indexOf(q);
      if (idx >= 0) return 1000 - idx;
      let ti = 0, score = 0;
      for (const ch of q) {
        ti = t.indexOf(ch, ti);
        if (ti < 0) return -1;
        score += 1; ti += 1;
      }
      return score;
    };

    const Palette = ({ __opuiCtx: ctx }) => {
      const state = useSyncExternalStore(
        (fn) => paletteStore.subscribe(fn),
        () => paletteStore.getSnapshot());
      const [query, setQuery] = useState('');
      const [active, setActive] = useState(0);
      const inputRef = useRef(null);
      const open = state.open;

      useEffect(() => {
        if (open) { setQuery(''); setActive(0); }
        const t = setTimeout(() => { if (open && inputRef.current) inputRef.current.focus(); }, 0);
        return () => clearTimeout(t);
      }, [open]);

      const all = open ? palItems(ctx).filter((it) => !it.enabled || it.enabled()) : [];
      const filtered = (query
        ? all.map((it) => ({ it, r: Math.max(fuzzyRank(query, it.label), fuzzyRank(query, it.kind + ' ' + it.label) - 5) }))
          .filter((x) => x.r >= 0).sort((a, b) => b.r - a.r).map((x) => x.it)
        : all);
      const cursor = Math.min(active, Math.max(0, filtered.length - 1));

      if (!open) return null;
      const exec = (it) => {
        paletteStore.set(false);
        try { it.run(); } catch (e) { console.error('operator-ui palette command failed:', e); }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); paletteStore.set(false); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(filtered.length - 1, cursor + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, cursor - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filtered[cursor]) exec(filtered[cursor]); }
      };
      return h('div', {
        className: 'opui-pal-backdrop',
        onMouseDown: (e) => { if (e.target === e.currentTarget) paletteStore.set(false); },
      },
        h('div', { className: 'opui-pal', onKeyDown: onKey },
          h('input', {
            ref: inputRef,
            placeholder: 'Jump to a session, run a command…',
            value: query,
            onChange: (e) => { setQuery(e.target.value); setActive(0); },
          }),
          h('div', { className: 'opui-pal-list' },
            filtered.length === 0
              ? h('div', { className: 'opui-pal-empty' }, 'Nothing matches')
              : filtered.map((it, i) => h('div', {
                key: it.kind + ':' + it.label + ':' + i,
                className: 'opui-pal-item' + (i === cursor ? ' act' : ''),
                onMouseEnter: () => setActive(i),
                onClick: () => exec(it),
              },
                h('span', { className: 'opui-pal-kind' }, it.kind),
                h('span', { className: 'opui-pal-label' }, it.label),
                it.hint ? h('span', { className: 'opui-pal-hint' }, it.hint) : null))),
          h('div', { className: 'opui-pal-foot' },
            h('span', null, '↑↓ navigate'), h('span', null, '↵ run'), h('span', null, 'esc close'),
            h('span', { style: { marginLeft: 'auto' } }, 'operator-ui'))));
    };

    // ---------------------------------------------------------------- git tab

    const GIT_XY_LABEL = {
      M: 'modified', A: 'added', D: 'deleted', R: 'renamed',
      C: 'copied', U: 'unmerged', '?': 'untracked',
    };

    const GitTab = ({ __opuiCtx: ctx }) => {
      const list = useSyncExternalStore(
        ctx.sessions.list.subscribe.bind(ctx.sessions.list),
        () => ctx.sessions.list.getSnapshot());
      const cwd = (list.current && list.byId[list.current] && list.byId[list.current].cwd) || null;
      const [state, setState] = useState({ phase: 'idle', data: null, error: null });
      const [openFile, setOpenFile] = useState(null);
      const [fileQuery, setFileQuery] = useState('');
      const cwdRef = useRef(null);
      cwdRef.current = cwd;

      const load = () => {
        const path = cwdRef.current;
        if (!path) return;
        setState((s) => ({ ...s, phase: 'loading' }));
        fetch('/plugins/operator-ui/git?op=status&path=' + encodeURIComponent(path))
          .then((r) => r.json())
          .then((data) => {
            if (cwdRef.current !== path) return;
            setState({ phase: 'ready', data, error: data.ok ? null : (data.error || 'status failed') });
          })
          .catch((e) => {
            if (cwdRef.current !== path) return;
            setState({ phase: 'ready', data: null, error: String((e && e.message) || e) });
          });
      };

      useEffect(() => {
        setOpenFile(null);
        if (cwd) load();
      }, [cwd]);

      if (!cwd) {
        return h('div', { className: 'opui-git' },
          h('div', { className: 'opui-git-body' },
            h('div', { className: 'opui-git-empty' }, 'Open a session to see its workspace git status.')));
      }

      const d = state.data;
      const branchMain = d && d.branch ? d.branch.split('…')[0].replace(/^\[?no branch\]?/, '(detached)').trim() : null;
      const ahead = d && d.branch && d.branch.includes('ahead ') ? d.branch.match(/ahead (\d+)/) : null;
      const behind = d && d.branch && d.branch.includes('behind ') ? d.branch.match(/behind (\d+)/) : null;

      const clickFile = (f) => {
        if (f.untracked) return;
        if (openFile === f.file) { setOpenFile(null); return; }
        setOpenFile(f.file);
        fetch('/plugins/operator-ui/git?op=diff&path=' + encodeURIComponent(cwd) + '&file=' + encodeURIComponent(f.file))
          .then((r) => r.json())
          .then((res) => {
            setState((s) => {
              if (!s.data) return s;
              return { ...s, data: { ...s.data, diffs: { ...(s.data.diffs || {}), [res.file]: res } } };
            });
          })
          .catch(() => {});
      };

      const diffFor = (f) => d && d.diffs && d.diffs[f.file];

      return h('div', { className: 'opui-git' },
        h('div', { className: 'opui-git-head' },
          h('span', { className: 'opui-git-branch' }, d && d.branch ? branchMain || d.branch : 'git'),
          ahead ? h('span', { className: 'opui-chip' }, '↑' + ahead[1]) : null,
          behind ? h('span', { className: 'opui-chip' }, '↓' + behind[1]) : null,
          d ? h('span', { className: 'opui-git-meta' },
            d.files.length + ' change' + (d.files.length === 1 ? '' : 's') + ' · ' + cwd) : null,
          h('span', { style: { marginLeft: 'auto' } },
            h('input', {
              className: 'opui-git-filter',
              placeholder: 'Filter files…',
              value: fileQuery,
              onChange: (e) => setFileQuery(e.target.value),
            }),
            h('button', { className: 'opui-btn', onClick: load, disabled: state.phase === 'loading' },
              state.phase === 'loading' ? 'Loading…' : 'Refresh'))),
        h('div', { className: 'opui-git-body' },
          state.error
            ? h('div', { className: 'opui-git-err' }, state.error)
            : !d
              ? h('div', { className: 'opui-git-empty' }, 'Reading status…')
              : h('div', null,
                h('div', { className: 'opui-git-sec' }, 'Changes'),
                d.files.length === 0
                  ? h('div', { className: 'opui-git-empty' }, 'Working tree clean.')
                  : (() => {
                    const fq = fileQuery.trim().toLowerCase();
                    const shown = fq ? d.files.filter((f) => f.file.toLowerCase().includes(fq)) : d.files;
                    if (shown.length === 0) return h('div', { className: 'opui-git-empty' }, 'No files match “' + fileQuery + '”.');
                    return shown.map((f, i) => h('div', { key: i },
                    h('div', {
                      className: 'opui-git-file' + (f.untracked ? '' : ' diffable') + (openFile === f.file ? ' open' : ''),
                      onClick: () => clickFile(f),
                      title: f.untracked ? 'untracked — no diff' : 'click for diff',
                    },
                      h('span', { className: 'opui-git-xy' }, f.x === '?' ? '??' : (f.x + f.y).trim()),
                      h('span', { className: 'opui-git-path' }, f.file),
                      h('span', { className: 'opui-git-note' }, GIT_XY_LABEL[f.x === '?' ? '?' : (f.y !== '_' ? f.y : f.x)] || '')),
                    openFile === f.file
                      ? h('div', { className: 'opui-git-diff' },
                        (() => {
                          const res = diffFor(f);
                          if (!res) return h('pre', null, 'Loading diff…');
                          if (!res.ok) return h('pre', null, res.error || 'diff failed');
                          if (!res.diff) return h('pre', null, '(no unstaged diff)');
                          return h('pre', null, res.diff);
                        })())
                      : null));
                  })(),
                d.log && d.log.length
                  ? h('div', null,
                    h('div', { className: 'opui-git-sec' }, 'Recent commits'),
                    d.log.map((l, i) => h('div', { key: i, className: 'opui-git-log' }, l)))
                  : null)));
    };

    // ------------------------------------------------------------------ apply

    const inject = ['slots', 'sessions'];

    const apply = (ctx) => {
      if (styleEl === null) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin-css', 'dsh-operator-ui');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
      }
      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'runs',
            order: 20,
            label: () => 'Runs',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(RunsTab, props)));
        const disposePal = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({
            name: 'shell.overlay',
            id: 'opui-palette',
            order: 0,
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(Palette, props)));
        const disposeGit = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'git',
            order: 30,
            label: () => 'Git',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(GitTab, props)));
        // Global ⌘K / Ctrl+K: works from anywhere, including inside the
        // composer. Cleaned up with the plugin fiber.
        const onKey = (e) => {
          if (e.isComposing) return;
          if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k') {
            e.preventDefault();
            paletteStore.set(!paletteStore.open);
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          try { disposePal && disposePal(); } catch {}
          try { disposeGit && disposeGit(); } catch {}
          try { dispose && dispose(); } catch {}
          if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          styleEl = null;
        };
      });
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
