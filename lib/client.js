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
.opui-gate{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:var(--dsw-static-neutral-50,#f6f8fa);overflow:auto;padding:24px}
body[data-ds-dark-theme] .opui-gate{background:var(--dsw-static-neutral-900,#0d1117)}
.opui-gate-inner{max-width:1100px;width:100%;margin:auto}
/* vertical execution spine — the visual hero */
.opui-spine{position:relative;padding-left:4px}
.opui-stage{position:relative;padding:0 0 20px 26px;border-left:2px solid var(--dsw-static-neutral-200,#eaeef2)}
body[data-ds-dark-theme] .opui-stage{border-left-color:var(--dsw-static-neutral-700,#30363d)}
.opui-stage:last-child{border-left-color:transparent;padding-bottom:2px}
.opui-stage-marker{position:absolute;left:-7px;top:1px;width:12px;height:12px;border-radius:50%;background:var(--dsw-static-neutral-300,#d0d7de);box-shadow:0 0 0 3px var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-stage-marker{box-shadow:0 0 0 3px var(--dsw-static-neutral-900,#0d1117)}
.opui-stage-marker.ok{background:var(--dsw-static-green-600,#1a7f37)}
.opui-stage-marker.run{background:var(--dsw-static-amber-500,#d97706)}
.opui-stage-marker.err{background:var(--dsw-static-red-500,#cf222e)}
.opui-stage-marker.dim{background:var(--dsw-static-neutral-400,#8c959f)}
.opui-stage-key{font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;opacity:.55;margin-bottom:5px}
.opui-stage-val{font-size:14px;line-height:1.45}
.opui-stage-title{font-size:16px;font-weight:600}
.opui-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.55}
.opui-copybtn{border:none;background:none;cursor:pointer;opacity:.45;padding:0 2px;font-size:11px;color:inherit}
.opui-copybtn:hover{opacity:1}
/* semantic chips */
.opui-chip.ok{border-color:var(--dsw-static-green-600,#1a7f37);color:var(--dsw-static-green-700,#116329)}
.opui-chip.mut{opacity:.65}
.opui-elig{font-size:11px;line-height:1.5}
.opui-elig .why{opacity:.65}
/* task list */
.opui-work-list{display:flex;flex-direction:column;gap:4px}
.opui-work-row{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.opui-work-row:hover{background:var(--dsw-static-neutral-100,#eaeef2)}
body[data-ds-dark-theme] .opui-work-row:hover{background:var(--dsw-static-neutral-800,#161b22)}
.opui-work-row.sel{border-color:var(--dsw-static-green-600,#1a7f37);background:color-mix(in srgb,var(--dsw-static-green-600,#1a7f37) 8%,transparent)}
.opui-work-row.sys{opacity:.6}
.opui-work-row.sys .opui-work-title{font-size:12px}
.opui-work-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.opui-sys-toggle{border:none;background:none;cursor:pointer;padding:6px 9px;font-size:11px;opacity:.55;text-align:left;width:100%;color:inherit}
.opui-sys-toggle:hover{opacity:.9}
/* result card — what happened, above the spine (how) */
.opui-result{border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-result{background:var(--dsw-static-neutral-800,#161b22)}
.opui-result-head{display:flex;align-items:baseline;gap:10px}
.opui-result-head .opui-result-verdict{font-size:18px;font-weight:700;letter-spacing:.02em}
.opui-result-head.ok .opui-result-verdict{color:var(--dsw-static-green-700,#116329)}
.opui-result-head.err .opui-result-verdict{color:var(--dsw-static-red-500,#cf222e)}
.opui-result-head.run .opui-result-verdict{color:var(--dsw-static-amber-600,#b45309)}
.opui-ladder{display:flex;gap:12px;margin:8px 0;flex-wrap:wrap}
.opui-ladder-rung{display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.45}
.opui-ladder-rung.lit{opacity:1;font-weight:600}
.opui-ladder-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-static-neutral-300,#d0d7de)}
.opui-ladder-dot.lit{background:var(--dsw-static-green-600,#1a7f37)}
.opui-result-next{font-size:12px;line-height:1.5}
.opui-result-err{font-size:11px;color:var(--dsw-static-red-500,#cf222e);margin-top:6px;word-break:break-word}
/* permissions round: Preview ("RCOS plans to") + killed-card fallback */
.opui-preview{border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:10px;padding:8px 10px;margin:8px 0}
body[data-ds-dark-theme] .opui-preview{border-color:var(--dsw-static-neutral-800,#30363d)}
.opui-preview-head{font-size:12px;font-weight:600;margin-bottom:4px}
.opui-preview-line{font-size:12px;line-height:1.7}
.opui-preview-ok{color:var(--dsw-static-green-600,#1a7f37)}
.opui-preview-need{color:var(--dsw-static-amber-600,#b45309)}
.opui-card-dead{border:1px dashed var(--dsw-static-neutral-300,#d0d7de);border-radius:10px;padding:10px 12px;opacity:.75}
body[data-ds-dark-theme] .opui-card-dead{border-color:var(--dsw-static-neutral-700,#484f58)}
/* persistent surface nav */
.opui-nav{display:flex;gap:4px;align-items:center;margin-bottom:12px}
.opui-nav .opui-navbtn{border:none;background:none;cursor:pointer;padding:5px 10px;border-radius:8px;font-size:12px;opacity:.6;color:inherit}
.opui-nav .opui-navbtn.cur{opacity:1;font-weight:600;background:var(--dsw-static-neutral-100,#eaeef2)}
body[data-ds-dark-theme] .opui-nav .opui-navbtn.cur{background:var(--dsw-static-neutral-800,#161b22)}
.opui-nav .opui-spacer{flex:1}
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
.opui-brs{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-static-neutral-800,#24292f)}
body[data-ds-dark-theme] .opui-brs{color:var(--dsw-static-neutral-100,#e6edf3)}
.opui-brs-head{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-static-neutral-100,#d8dee4);flex:none;flex-wrap:wrap}
body[data-ds-dark-theme] .opui-brs-head{border-bottom-color:var(--dsw-static-neutral-700,#30363d)}
.opui-brs-url{font:inherit;font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);background:transparent;color:inherit;flex:1;min-width:200px;outline:none}
body[data-ds-dark-theme] .opui-brs-url{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-brs-url:focus{border-color:var(--dsw-static-blue-500,#4c6ef5)}
.opui-brs-body{flex:1;min-height:0;overflow:auto;padding:12px 16px;background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-brs-body{background:var(--dsw-static-neutral-900,#0d1117)}
.opui-brs-frame{display:block;margin:0 auto;max-width:100%;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);border-radius:8px;background:#fff;min-height:200px}
body[data-ds-dark-theme] .opui-brs-frame{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-brs-note{font-size:11px;opacity:.6;padding:6px 16px;border-top:1px solid var(--dsw-static-neutral-100,#d8dee4);flex:none}
body[data-ds-dark-theme] .opui-brs-note{border-top-color:var(--dsw-static-neutral-700,#30363d)}
.opui-brs-live{color:var(--dsw-static-green-600,#2b8a3e);font-weight:600}
body[data-ds-dark-theme] .opui-brs-live{color:var(--dsw-static-green-500,#51cf66)}
.opui-sum{display:flex;flex-direction:column;height:100%;min-height:0;overflow:auto;padding:14px 18px;font-size:13px;color:var(--dsw-static-neutral-800,#24292f)}
body[data-ds-dark-theme] .opui-sum{color:var(--dsw-static-neutral-100,#e6edf3)}
.opui-sum-hero{border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:10px;padding:12px 14px;margin-bottom:14px}
body[data-ds-dark-theme] .opui-sum-hero{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-sum-hero .opui-title{font-size:15px;font-weight:600;max-width:none}
.opui-sum-quote{margin:8px 0 0;font-size:12.5px;line-height:1.5;opacity:.85;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.opui-sum-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.opui-sum-card{border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:10px;padding:10px 12px}
body[data-ds-dark-theme] .opui-sum-card{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-sum-card h4{margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;opacity:.6}
.opui-fs{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-static-neutral-800,#24292f)}
body[data-ds-dark-theme] .opui-fs{color:var(--dsw-static-neutral-100,#e6edf3)}
.opui-fs-body{flex:1;min-height:0;overflow:auto;padding:10px 16px}
.opui-fs-row{display:flex;align-items:baseline;gap:8px;padding:3px 6px;border-radius:6px;font-size:12px;cursor:default}
.opui-fs-row.click{cursor:pointer}
.opui-fs-row.click:hover{background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-fs-row.click:hover{background:var(--dsw-static-neutral-800,#161b22)}
.opui-fs-row.open{background:var(--dsw-static-blue-50,#edf2ff)}
body[data-ds-dark-theme] .opui-fs-row.open{background:rgba(76,110,245,.12)}
.opui-fs-icon{flex:none;width:16px;text-align:center;opacity:.7}
.opui-fs-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opui-fs-meta{font-size:11px;opacity:.55;flex:none}
.opui-fs-badge{font-size:10.5px;font-weight:700;border-radius:4px;padding:0 4px;flex:none;background:var(--dsw-static-amber-100,#fff3bf);color:var(--dsw-static-amber-700,#a86600)}
.opui-fs-content{margin:8px 0 12px;padding:10px;border:1px solid var(--dsw-static-neutral-100,#d8dee4);border-radius:8px;background:var(--dsw-static-neutral-50,#f6f8fa);overflow:auto;max-height:420px}
body[data-ds-dark-theme] .opui-fs-content{background:var(--dsw-static-neutral-900,#0d1117);border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-fs-content pre{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.opui-git-add{color:var(--dsw-static-green-600,#2b8a3e);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.opui-git-del{color:var(--dsw-static-red-600,#c92a2a);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.opui-git-dels{display:flex;gap:4px;flex:none;width:86px;justify-content:flex-end;font-size:11px}
.opui-chip.good{border-color:var(--dsw-static-green-500,#2f9e44);color:var(--dsw-static-green-600,#2b8a3e)}
.opui-item.click{cursor:pointer;padding:5px 6px;border-radius:8px}
.opui-item.click:hover{background:var(--dsw-static-neutral-50,#f6f8fa)}
body[data-ds-dark-theme] .opui-item.click:hover{background:var(--dsw-static-neutral-800,#161b22)}
.opui-item.sel{background:var(--dsw-static-blue-50,#edf2ff)}
body[data-ds-dark-theme] .opui-item.sel{background:rgba(76,110,245,.14)}
.opui-wf-decision{border-radius:8px;padding:8px 12px;font-weight:700;font-size:12.5px;margin:6px 0}
.opui-wf-decision.good{background:var(--dsw-static-green-100,#d3f9d8);color:var(--dsw-static-green-800,#2b8a3e)}
.opui-wf-decision.warn{background:var(--dsw-static-blue-100,#dbe4ff);color:var(--dsw-static-blue-700,#3b5bdb)}
.opui-wf-decision.bad{background:var(--dsw-static-amber-100,#fff3bf);color:var(--dsw-static-amber-800,#a86600)}
body[data-ds-dark-theme] .opui-wf-decision.good{background:rgba(47,158,68,.18);color:#69db7c}
body[data-ds-dark-theme] .opui-wf-decision.warn{background:rgba(76,110,245,.18);color:#91a7ff}
body[data-ds-dark-theme] .opui-wf-decision.bad{background:rgba(217,119,6,.18);color:#ffc078}
.opui-wf-msg{border-left:3px solid var(--dsw-static-neutral-200,#c9d1d9);padding:2px 0 2px 10px;font-size:12.5px;opacity:.85;margin-top:6px}
body[data-ds-dark-theme] .opui-wf-msg{border-left-color:var(--dsw-static-neutral-700,#30363d)}
.opui-wf-art{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;border:1px solid var(--dsw-static-neutral-200,#c9d1d9);border-radius:6px;padding:2px 7px}
body[data-ds-dark-theme] .opui-wf-art{border-color:var(--dsw-static-neutral-700,#30363d)}
.opui-row.cur td:first-child{box-shadow:inset 3px 0 0 var(--dsw-static-blue-500,#4c6ef5)}
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

    const Row = ({ row, jobs, queueCount, selected, isCurrent, onSelect, now }) => {
      const st = rowStatus(row);
      const p = pressure(row);
      const tok = usageTotal(row);
      return h('tr', {
        className: 'opui-row' + (selected ? ' sel' : '') + (isCurrent ? ' cur' : ''),
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
      const [showBlanks, setShowBlanks] = useState(false);

      // Standard sessions feed: {ids, byId, current, phase, jobsBySession}.
      const items = useMemo(() => {
        const ids = list.ids || [];
        const byId = list.byId || {};
        return ids.map((id) => byId[id]).filter(Boolean);
      }, [list]);
      const jobsBySession = list.jobsBySession || {};
      const rows = useMemo(() => {
        const f = filter.trim().toLowerCase();
        const base = items
          .filter((r) => showBlanks || !r.blank)
          .filter((r) => !f || (displayTitle(r) + ' ' + (r.cwd || '')).toLowerCase().includes(f));
        return [...base].sort((a, b) =>
          (STATUS_RANK[rowStatus(a)] - STATUS_RANK[rowStatus(b)]) ||
          (b.updatedAt || 0) - (a.updatedAt || 0));
      }, [items, filter, showBlanks]);

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

      const markRow = (row) => h(Row, {
        key: rowId(row), row,
        jobs: jobsBySession[rowId(row)],
        queueCount: rowId(row) === selected ? selQueueCount : 0,
        selected: rowId(row) === selected,
        isCurrent: rowId(row) === list.current,
        onSelect: (id) => setSelected((cur) => (cur === id ? null : id)),
        now,
      });

      return h('div', { className: 'opui-root' },
        h('div', { className: 'opui-head' },
          h('h2', null, 'Runs'),
          counts.attention ? h('span', { className: 'opui-chip att' }, h('b', null, counts.attention), 'needs attention') : null,
          counts.running ? h('span', { className: 'opui-chip run' }, h('b', null, counts.running), 'running') : null,
          h('span', { className: 'opui-chip' }, h('b', null, counts.total), 'sessions'),
          h('span', {
            className: 'opui-chip' + (showBlanks ? ' run' : ''),
            style: { cursor: 'pointer' },
            onClick: () => setShowBlanks((v) => !v),
            title: 'show sessions that never got a first message',
          }, 'blanks'),
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
                  rows.map(markRow)))),
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
      for (const name of ['Chat', 'Trajectory', 'Runs', 'Git', 'Browser', 'Files']) {
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
          d && d.files.length ? h('span', { className: 'opui-chip' }, h('b', null, d.files.filter((f) => f.staged).length), 'staged') : null,
          d && d.files.length ? h('span', { className: 'opui-chip' }, h('b', null, d.files.filter((f) => f.unstaged && !f.untracked).length), 'unstaged') : null,
          d && d.files.length ? h('span', { className: 'opui-chip' }, h('b', null, d.files.filter((f) => f.untracked).length), 'untracked') : null,
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
                      h('span', { className: 'opui-git-dels' },
                        f.adds ? h('span', { className: 'opui-git-add' }, '+' + f.adds) : null,
                        f.dels ? h('span', { className: 'opui-git-del' }, '\u2212' + f.dels) : null),
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

    // ------------------------------------------------------------- browser tab
    //
    // Slice 1: the viewport is single-source from the host (/status reports
    // the live supervisor value, else the configured one). The client scales
    // clicks against that — never a hardcoded constant.
    const VIEW_DEFAULT = [1280, 800];

    const BrowserTab = ({ __opuiCtx: ctx }) => {
      const [src, setSrc] = useState(null);
      const [live, setLive] = useState(false);
      const [url, setUrl] = useState('');
      const [barText, setBarText] = useState('');
      const [busy, setBusy] = useState(false);
      const [toolsState, setToolsState] = useState({ available: true, error: null });
      const [view, setView] = useState(VIEW_DEFAULT);
      const esRef = useRef(null);

      useEffect(() => {
        const es = new EventSource('/plugins/operator-ui/browser/stream');
        esRef.current = es;
        es.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === 'frame') {
            setSrc('data:image/jpeg;base64,' + msg.d);
            setLive(true);
          } else if (msg.type === 'status') {
            setLive(!!msg.running);
            if (msg.url && msg.url !== 'about:blank') setUrl(msg.url);
          }
        };
        // Slice 0 (generic install): the four browser_* agent tools are OPTIONAL
        // (they need the dsh-tools peer). The host reports their real state here;
        // when false the tab says so instead of implying agent driving works.
        // Slice 1: the same probe carries the single-source viewport.
        fetch('/plugins/operator-ui/browser/status').then((r) => r.json()).then((st) => {
          if (st && typeof st.toolsAvailable === 'boolean') {
            setToolsState({ available: st.toolsAvailable, error: st.toolsError || null });
          }
          if (st && Array.isArray(st.viewport) && st.viewport.length === 2) {
            setView(st.viewport);
          }
        }).catch(() => {});
        return () => { try { es.close(); } catch {} };
      }, []);

      const op = (body) => {
        setBusy(true);
        fetch('/plugins/operator-ui/browser/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.ok && res.result && res.result.url) setUrl(res.result.url);
          })
          .catch(() => {})
          .finally(() => setBusy(false));
      };

      const go = () => {
        let t = barText.trim();
        if (!t) return;
        if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
        setUrl(t);
        op({ op: 'navigate', url: t });
      };

      const clickThrough = (e) => {
        // Scale the click from displayed size back to the host viewport
        // (single-source via /browser/status; never hardcoded here).
        const rect = e.target.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) * (view[0] / rect.width));
        const y = Math.round((e.clientY - rect.top) * (view[1] / rect.height));
        op({ op: 'click', x, y });
      };
      return h('div', { className: 'opui-brs' },
        toolsState.available ? null : h('div', { className: 'opui-empty', style: { padding: '10px 12px', marginBottom: 8 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, 'Agent browser tools unavailable'),
          h('div', { className: 'opui-sub' }, toolsState.error || 'The dsh-tools peer package is not installed — human driving still works; the agent cannot drive this browser until the peer resolves.')),
        h('div', { className: 'opui-brs-head' },
          h('input', {
            className: 'opui-brs-url',
            placeholder: 'Open a URL for yourself or the agent…',
            value: barText,
            onChange: (e) => setBarText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') go(); },
          }),
          h('button', { className: 'opui-btn primary', onClick: go, disabled: busy }, 'Go'),
          h('button', { className: 'opui-btn', onClick: () => op({ op: 'stop' }), disabled: busy }, 'Stop browser'),
          live
            ? h('span', { className: 'opui-brs-live' }, '\u25cf live')
            : h('span', { className: 'opui-num' }, 'stopped')),
        h('div', { className: 'opui-brs-body' },
          src
            ? h('div', { style: { position: 'relative' } },
              h('img', {
                className: 'opui-brs-frame', src, alt: 'live browser view',
                style: { cursor: 'crosshair' },
                title: 'click to interact — your clicks land in the real browser',
                onClick: clickThrough,
              }),
              !live ? h('div', {
                style: {
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', borderRadius: 8,
                  background: 'rgba(0,0,0,.45)', color: '#fff', fontSize: 13, fontWeight: 600,
                },
              }, 'browser stopped — open a URL to start it again') : null)
            : h('div', { className: 'opui-empty' },
              'No browser running yet. Open a URL above — the agent drives the same window.')),
        h('div', { className: 'opui-brs-note' },
          'Supervised on-screen browser — one instance, stops after 10 idle minutes (watching counts as alive). ',
          'Click the view to interact. ', toolsState.available
            ? h('span', null, h('span', { className: 'opui-live' }, 'Agent tools: '),
              'browser_navigate \u00b7 browser_snapshot \u00b7 browser_click \u00b7 browser_type — everything the agent does appears here in real time.')
            : h('span', { className: 'opui-sub' }, 'Agent driving disabled (dsh-tools peer missing) — human driving still works.')));
    };

    // ------------------------------------------------------------- summary tab

    const lastAssistantText = (session) => {
      // Defensive walk of the conversation snapshot for the newest assistant
      // text; shape drift degrades to null, never throws.
      try {
        const snap = session.getSnapshot();
        const order = snap?.chat?.order;
        const nodes = snap?.chat?.nodes;
        if (!order || !nodes) return null;
        const keys = [...order].reverse();
        for (const key of keys) {
          const node = nodes.get ? nodes.get(key) : nodes[key];
          const blocks = node && node.data && node.data.blocks;
          if (!Array.isArray(blocks)) continue;
          const texts = [];
          for (const b of blocks) {
            if (b && typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
          }
          if (texts.length) return texts.join('\n').slice(0, 1200);
        }
      } catch {}
      return null;
    };

    // ---------------------------------------------------- system verification
    // Slice 2 Setup surface, inside the existing Summary tab (no new tab).
    // It answers the five Setup questions from the Slices 0/1 contracts:
    // What do I need / have? What is wrong? (from /status) — What can be
    // verified now? (probe preflight) — What did RCOS actually test? (the
    // sealed receipt + fresh VALID/STALE/TAMPERED verdict).

    const VER_CHIP = { RCOS_VERIFIED: 'good', SYSTEM_VERIFIED: 'run', NOT_VERIFIED: 'att' };
    const FRESH_CHIP = { VALID: 'good', STALE: 'run', TAMPERED: 'att', NONE: '', UNSEALED: 'att' };

    const SystemVerification = () => {
      const [st, setSt] = useState(null);
      const [vr, setVr] = useState(null);
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);
      const load = () => {
        fetch('/plugins/operator-ui/status').then((r) => r.json()).then((d) => { if (alive.current) setSt(d); }).catch(() => {});
        fetch('/plugins/operator-ui/verify?op=receipt').then((r) => r.json()).then((d) => { if (alive.current) setVr(d); }).catch(() => {});
      };
      useEffect(load, []);
      const runVerify = () => {
        setBusy(true);
        fetch('/plugins/operator-ui/verify', { method: 'POST' })
          .then((r) => r.json())
          .then(() => load())
          .catch(() => {})
          .finally(() => { if (alive.current) setBusy(false); });
      };

      const comps = st && st.components ? st.components : null;
      const order = ['dsh', 'operatorUi', 'node', 'archon', 'rcos', 'git', 'chrome', 'tools', 'providers'];
      const degraded = comps
        ? order.filter((k) => comps[k] && comps[k].state !== 'AVAILABLE').map((k) => [k, comps[k]])
        : [];
      const available = comps ? order.filter((k) => comps[k] && comps[k].state === 'AVAILABLE').length : 0;
      const probeBReady = !!(comps && comps.archon.state === 'AVAILABLE' && comps.rcos.state === 'AVAILABLE');

      const rec = vr && vr.receipt ? vr.receipt : null;
      const level = rec ? rec.decision : 'NOT_VERIFIED';
      const fresh = vr ? vr.state : 'NONE';

      const vcard = (title, nodes) => h('div', { className: 'opui-sum-card' }, h('h4', null, title), ...nodes);

      return h('div', { className: 'opui-sum-grid', style: { marginBottom: 16 } },
        vcard('Verification', [
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: rec ? 6 : 0 } },
            h('span', { className: 'opui-chip ' + (VER_CHIP[level] || 'att') }, level),
            h('span', { className: 'opui-chip ' + (FRESH_CHIP[fresh] || '') }, fresh === 'NONE' ? 'no receipt' : fresh),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { className: 'opui-btn', onClick: runVerify }, busy ? 'Verifying…' : 'Run verification')),
          rec ? h('div', null,
            kv('Verified', relTime(Date.parse(rec.createdAt), Date.now()) + ' ago'),
            kv('Probes', rec.probes.map((p) => (p.pass ? '\u2713 ' : '\u2717 ') + p.id).join(' \u00b7 ')),
            rec.execution ? kv('Executed', (rec.execution.routedVia ? rec.execution.routedVia.capability + ' \u2192 ' : '') + (rec.execution.runId || 'run')) : null,
            rec.failureCodes && rec.failureCodes.length ? kv('Failure codes', rec.failureCodes.join(', ')) : null,
            kv('Seal', ((rec.seal && rec.seal.hash) || '').slice(0, 21) + '\u2026'))
            : h('div', { className: 'opui-meta' }, 'No receipt yet — Run verification produces the genesis receipt (Probe A needs nothing; Probe B routes a seeded workflow through the registry + Archon).'),
          fresh === 'STALE' && vr && vr.staleReasons.length ? vr.staleReasons.map((r, i) =>
            h('div', { key: i, className: 'opui-meta' }, '\u00b7 stale: ' + r)) : null,
          fresh === 'TAMPERED' ? h('div', { className: 'opui-meta' }, '\u00b7 receipt body no longer matches its seal — modified after generation. Treat as invalid, not merely old.') : null,
        ]),
        vcard('Needs / wrong', [
          !comps ? h('div', { className: 'opui-meta' }, 'Reading status\u2026')
            : degraded.length === 0 ? h('div', { className: 'opui-meta' }, 'Nothing degraded — every known component reports AVAILABLE.')
            : degraded.map(([k, c]) => h('div', { key: k, className: 'opui-kv', title: c.reason || '' },
                h('span', null, k),
                h('span', null, c.state + (c.reason ? ' — ' + c.reason.slice(0, 80) + '\u2026' : '')))),
        ]),
        vcard('Can verify now', [
          h('div', { className: 'opui-kv' }, h('span', null, 'Probe A'), h('span', null, 'ready — zero-credential machinery self-check')),
          h('div', { className: 'opui-kv' }, h('span', null, 'Probe B'),
            h('span', null, probeBReady ? 'ready — seeded workflow via registry + Archon' : 'blocked — needs registry + Archon AVAILABLE')),
          h('div', { className: 'opui-meta' }, available + ' of ' + order.length + ' known components AVAILABLE.'),
        ]));
    };

    const SummaryTab = ({ __opuiCtx: ctx }) => {
      useTick(30000);
      const list = useSyncExternalStore(
        ctx.sessions.list.subscribe.bind(ctx.sessions.list),
        () => ctx.sessions.list.getSnapshot());
      const current = list.current;
      const row = current ? list.byId[current] : null;
      const binding = current ? ctx.sessions.binding(current) : undefined;
      const session = binding && binding.session;
      const liveStore = useMemo(() => session || EmptyLiveStore, [session]);
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
                running: !!(snap && snap.running),
              },
            };
          }
          return liveCache.current.derived;
        });
      const [git, setGit] = useState(null);
      const cwd = row ? (row.cwd || null) : null;
      const cwdRef = useRef(null);
      cwdRef.current = cwd;
      useEffect(() => {
        setGit(null);
        if (!cwd) return;
        fetch('/plugins/operator-ui/git?op=status&path=' + encodeURIComponent(cwd))
          .then((r) => r.json()).then((d) => { if (cwdRef.current === cwd) setGit(d.ok ? d : null); }).catch(() => {});
      }, [cwd]);

      if (!row) {
        return h('div', { className: 'opui-sum' },
          h(SystemVerification),
          h('div', { className: 'opui-empty', style: { paddingTop: 40 } }, 'Open a session to see its summary.'));
      }

      const st = rowStatus(row);
      const p = pressure(row);
      const tok = usageTotal(row);
      const stats = row.projectionValues && row.projectionValues.sessionStats || {};
      const lastOut = session ? lastAssistantText(session) : null;
      const jobs = (list.jobsBySession && list.jobsBySession[rowId(row)]) || [];
      const queued = (live.queue || []).filter((q) => q.placement === 'queued').length;
      const steering = (live.queue || []).filter((q) => q.placement === 'steering').length;

      const card = (title, rows) => h('div', { className: 'opui-sum-card' },
        h('h4', null, title),
        rows.filter(Boolean).map((r, i) => kv(r[0], r[1])));

      return h('div', { className: 'opui-sum' },
        h(SystemVerification),
        h('div', { className: 'opui-sum-hero' },
          h('div', null,
            h('span', { className: 'opui-dot ' + st, style: { marginRight: 8, display: 'inline-block', verticalAlign: 'baseline' } }),
            h('span', { className: 'opui-title' }, displayTitle(row)),
            row.agentPreset ? h('span', { className: 'opui-badge', style: { marginLeft: 8 } }, row.agentPreset) : null),
          h('div', { className: 'opui-sub', style: { marginTop: 2 } }, row.cwd || ''),
          lastOut
            ? h('div', { className: 'opui-sum-quote' }, lastOut.length >= 1200 ? lastOut + '…' : lastOut)
            : h('div', { className: 'opui-sum-quote', style: { opacity: .5 } }, live.running ? 'Working — output appears here as it streams…' : 'No assistant output yet.')),
        h('div', { className: 'opui-sum-grid' },
          card('Session', [
            ['Status', st],
            ['Updated', relTime(row.updatedAt, Date.now()) + ' ago'],
            stats.turns != null ? ['Turns / steps', stats.turns + ' / ' + (stats.steps || 0)] : null,
            stats.llmMs ? ['LLM time', Math.round(stats.llmMs / 100) / 10 + 's'] : null,
            stats.toolMs ? ['Tool time', Math.round(stats.toolMs / 100) / 10 + 's'] : null,
          ]),
          card('Context', [
            p ? ['Used', fmtTokens(p.used) + (p.win ? ' / ' + fmtTokens(p.win) : '')] : null,
            p && p.pct != null ? ['Pressure', p.pct + '%'] : null,
            tok != null ? ['Tokens (session)', fmtTokens(tok)] : null,
            !p && tok == null ? ['—', 'no usage reported yet'] : null,
          ]),
          card('Work right now', [
            live.running ? ['Turn', 'running'] : ['Turn', 'idle'],
            queued ? ['Queued', queued] : null,
            steering ? ['Steering', steering] : null,
            (live.runningCalls || []).length ? ['Tools running', live.runningCalls.length] : null,
            jobs.length ? ['Background jobs', jobs.length] : null,
            !live.running && !queued && !jobs.length ? ['—', 'nothing in flight'] : null,
          ]),
          card('Workspace', [
            git && git.branch ? ['Branch', git.branch.split('…')[0]] : ['Branch', '—'],
            git ? ['Changes', String(git.files.length)] : null,
            git && git.log && git.log[0] ? ['Last commit', git.log[0].length > 34 ? git.log[0].slice(0, 34) + '\u2026' : git.log[0]] : null,
            ['Folder', basename(cwd || '') || '—'],
          ])));
    };

    // ---------------------------------------------------------------- files tab

    const FilesTab = ({ __opuiCtx: ctx }) => {
      const list = useSyncExternalStore(
        ctx.sessions.list.subscribe.bind(ctx.sessions.list),
        () => ctx.sessions.list.getSnapshot());
      const cwd = (list.current && list.byId[list.current] && list.byId[list.current].cwd) || null;
      const [dirs, setDirs] = useState({});     // rel -> entries[] | {error}
      const [openDirs, setOpenDirs] = useState(new Set(['']));
      const [openFile, setOpenFile] = useState(null); // {path, content}
      const [gitMap, setGitMap] = useState({});
      const cwdRef = useRef(null);
      cwdRef.current = cwd;

      const loadDir = (rel) => {
        if (!cwd) return;
        fetch('/plugins/operator-ui/files?op=list&path=' + encodeURIComponent(cwd) + '&rel=' + encodeURIComponent(rel))
          .then((r) => r.json())
          .then((d) => {
            if (cwdRef.current !== cwd) return;
            setDirs((s) => ({ ...s, [rel]: d.ok ? d.entries : { error: d.error } }));
          })
          .catch(() => {});
      };
      const loadGit = () => {
        if (!cwd) return;
        fetch('/plugins/operator-ui/git?op=status&path=' + encodeURIComponent(cwd))
          .then((r) => r.json())
          .then((d) => {
            if (cwdRef.current !== cwd) return;
            const m = {};
            if (d.ok) for (const f of d.files) m[f.file] = f;
            setGitMap(m);
          }).catch(() => {});
      };

      useEffect(() => {
        setDirs({}); setOpenDirs(new Set([''])); setOpenFile(null); setGitMap({});
        if (cwd) { loadDir(''); loadGit(); }
      }, [cwd]);

      if (!cwd) {
        return h('div', { className: 'opui-fs' },
          h('div', { className: 'opui-fs-body' },
            h('div', { className: 'opui-empty', style: { paddingTop: 40 } }, 'Open a session to browse its workspace files.')));
      }

      const toggleDir = (rel) => {
        setOpenDirs((s) => {
          const n = new Set(s);
          if (n.has(rel)) n.delete(rel); else { n.add(rel); if (!dirs[rel]) loadDir(rel); }
          return n;
        });
      };
      const clickFile = (rel) => {
        if (openFile && openFile.path === rel) { setOpenFile(null); return; }
        setOpenFile({ path: rel, content: null });
        fetch('/plugins/operator-ui/files?op=read&path=' + encodeURIComponent(cwd) + '&file=' + encodeURIComponent(rel))
          .then((r) => r.json())
          .then((d) => {
            setOpenFile((cur) => (cur && cur.path === rel ? { path: rel, content: d.ok ? d.content : ('— ' + d.error) } : cur));
          }).catch(() => {});
      };

      const renderRows = (rel, depth) => {
        const entries = dirs[rel];
        if (entries === undefined) return [h('div', { key: 'l' + rel, className: 'opui-fs-row', style: { paddingLeft: 6 + depth * 16 } }, h('span', { className: 'opui-fs-meta' }, 'Loading…'))];
        if (entries && entries.error) return [h('div', { key: 'e' + rel, className: 'opui-fs-row', style: { paddingLeft: 6 + depth * 16 } }, h('span', { className: 'opui-fs-meta' }, entries.error))];
        const out = [];
        if ((entries || []).length === 0) out.push(h('div', { key: 'none' + rel, className: 'opui-fs-meta', style: { paddingLeft: 6 + depth * 16 } }, '(empty folder)'));
        for (const e of entries || []) {
          const childRel = rel ? rel + '/' + e.name : e.name;
          const badge = gitMap[childRel];
          const isOpenDir = e.dir && openDirs.has(childRel);
          out.push(h('div', {
            key: childRel,
            className: 'opui-fs-row click' + (openFile && openFile.path === childRel ? ' open' : ''),
            style: { paddingLeft: 6 + depth * 16 },
            onClick: () => (e.dir ? toggleDir(childRel) : clickFile(childRel)),
            title: e.dir ? 'open folder' : 'preview file',
          },
            h('span', { className: 'opui-fs-icon' }, e.dir ? (isOpenDir ? '▾' : '▸') : '·'),
            h('span', { className: 'opui-fs-name' }, e.name),
            badge ? h('span', { className: 'opui-fs-badge' }, badge.untracked ? '??' : (badge.x + badge.y).trim()) : null,
            !e.dir && e.size != null ? h('span', { className: 'opui-fs-meta' }, e.size > 1024 ? Math.round(e.size / 1024) + ' KB' : e.size + ' B') : null));
          if (e.dir && isOpenDir) out.push(...renderRows(childRel, depth + 1));
        }
        return out;
      };

      return h('div', { className: 'opui-fs' },
        h('div', { className: 'opui-brs-head', style: { borderTop: 'none' } },
          h('span', { className: 'opui-git-branch' }, 'Files'),
          h('span', { className: 'opui-git-meta' }, cwd),
          h('span', { style: { marginLeft: 'auto' } },
            h('button', { className: 'opui-btn', onClick: () => { setDirs({}); loadDir(''); loadGit(); } }, 'Refresh'))),
        h('div', { className: 'opui-fs-body' },
          renderRows('', 0),
          Object.keys(dirs).length === 0 ? h('div', { className: 'opui-empty' }, 'Reading…') : null,
          openFile
            ? h('div', { className: 'opui-fs-content' },
              h('div', { className: 'opui-fs-meta', style: { marginBottom: 6 } }, openFile.path),
              h('pre', null, openFile.content === null ? 'Loading…' : openFile.content))
            : null));
    };

    // ---------------------------------------------------------- workflows tab

    const WF_DOT = { running: 'running', completed: 'done', failed: 'attention', queued: 'idle', pending: 'idle' };
    const wfDot = (r) => WF_DOT[r.status] || 'idle';

    const DecisionChip = ({ decision }) => decision
      ? h('span', { className: 'opui-chip ' + (decision === 'ship' ? 'good' : decision === 'blocked' ? 'att' : 'run') },
          decision === 'ship' ? '\u2713 ship' : decision === 'blocked' ? '\u26d4 blocked' : '\u21bb fix')
      : null;

    const WorkflowsTab = () => {
      const [data, setData] = useState({ phase: 'loading', catalog: [], runs: [], error: null, unreachable: false, at: 0 });
      const [selId, setSelId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [wfQuery, setWfQuery] = useState('');
      const [runQuery, setRunQuery] = useState('');
      // Slice 1: the unreachable panel names the CONFIGURED Archon endpoint
      // (from /status, authority-tagged) — never a hardcoded default.
      const [archonHint, setArchonHint] = useState(null);
      const aliveRef = useRef(true);
      useTick(15000); // keep relative times fresh

      useEffect(() => {
        fetch('/plugins/operator-ui/status').then((r) => r.json()).then((st) => {
          if (!aliveRef.current) return;
          const a = st && st.components && st.components.archon;
          if (a && a.detail && a.detail.baseUrl) {
            setArchonHint({ baseUrl: a.detail.baseUrl, source: a.source, reason: a.reason });
          }
        }).catch(() => {});
      }, []);

      const load = () => {
        fetch('/plugins/operator-ui/archon?op=catalog').then((r) => r.json()).then((c) => {
          if (!aliveRef.current) return;
          setData((s) => ({ ...s, catalog: c.ok ? (c.workflows || []) : [], error: c.ok ? null : (c.error || s.error), unreachable: s.unreachable || !!c.unreachable }));
        }).catch(() => {});
        fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((r0) => {
          if (!aliveRef.current) return;
          setData((s) => ({ ...s, phase: 'ready', runs: r0.ok ? (r0.runs || []) : [], error: r0.ok ? null : (r0.error || s.error), unreachable: !!r0.unreachable, at: r0.ok ? Date.now() : s.at }));
        }).catch(() => {});
      };

      useEffect(() => {
        aliveRef.current = true;
        load();
        const t = setInterval(load, 10000);
        return () => { aliveRef.current = false; clearInterval(t); };
      }, []);

      const openRun = (id) => {
        if (selId === id) { setSelId(null); setDetail(null); return; }
        setSelId(id);
        setDetail({ id, loading: true });
        fetch('/plugins/operator-ui/archon?op=run&id=' + encodeURIComponent(id))
          .then((r) => r.json())
          .then((d) => { if (aliveRef.current) setDetail((cur) => (cur && cur.id === id ? { id, d } : cur)); })
          .catch(() => {});
      };

      if (data.unreachable) {
        return h('div', { className: 'opui-sum' },
          h('div', { className: 'opui-empty', style: { paddingTop: 60 } },
            h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, 'Archon not reachable'),
            h('div', { className: 'opui-sub', style: { maxWidth: 420, margin: '0 auto' } },
              'The workflow layer reads the Archon API' +
              (archonHint ? ' at ' + archonHint.baseUrl : '') +
              '. Start Archon, or point the configured endpoint' +
              (archonHint && archonHint.source ? ' (' + archonHint.source + ')' : '') +
              ' at it, and this tab fills in.')));
      }

      const q = wfQuery.trim().toLowerCase();
      const rq = runQuery.trim().toLowerCase();
      const catalog = data.catalog.filter((w) => !q || ((w.name || '') + ' ' + (w.description || '') + ' ' + (w.category || '')).toLowerCase().includes(q));
      const runs = data.runs.filter((r) => !rq || ((r.workflow_name || '') + ' ' + (r.user_message || '')).toLowerCase().includes(rq));
      const running = data.runs.filter((r) => r.status === 'running').length;
      const d = detail && detail.d;

      // --- pieces, then one flat return (paren-proof) ---
      const head = h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 10px' } },
        h('h2', null, 'Workflows'),
        running ? h('span', { className: 'opui-chip run' }, h('b', null, running), 'running') : null,
        h('span', { className: 'opui-chip' }, h('b', null, data.runs.length), 'runs'),
        h('span', { className: 'opui-chip' }, h('b', null, data.catalog.length), 'workflows'),
        h('span', { className: 'opui-spacer' }),
        data.at ? h('span', { className: 'opui-hint' },
          h('span', { className: 'opui-brs-live' }, '\u25cf live'), ' \u00b7 updated ' + relTime(data.at, Date.now()) + ' ago') : null,
        h('button', { className: 'opui-btn', onClick: load }, 'Refresh'));

      const runRow = (r, i) => h('div', {
        key: r.id || i,
        className: 'opui-item click' + (selId === r.id ? ' sel' : ''),
        onClick: () => openRun(r.id),
        title: r.id,
      },
        h('span', { className: 'opui-dot ' + wfDot(r), style: { marginRight: 2 } }),
        h('span', { className: 'opui-txt' },
          h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.workflow_name || r.id),
          h('div', { style: { fontSize: 11, opacity: .6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (r.user_message || '') + (r.current_step_index != null ? '  \u00b7  step ' + r.current_step_index : ''))),
        h('span', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: 'none' } },
          r.started_at ? h('span', { className: 'opui-meta' }, relTime(r.started_at, Date.now())) : null,
          DecisionChip({ decision: r.receipt && r.receipt.decision })));

      const runsCard = h('div', { className: 'opui-sum-card' },
        h('h4', null, 'Runs'),
        h('input', {
          className: 'opui-filter', style: { width: '100%', marginBottom: 8 },
          placeholder: 'Filter runs\u2026', value: runQuery,
          onChange: (e) => setRunQuery(e.target.value),
        }),
        data.phase === 'loading' ? h('div', { className: 'opui-none' }, 'Loading\u2026')
          : runs.length === 0 ? h('div', { className: 'opui-none' }, 'No runs match')
          : runs.map(runRow));

      const detailBody = !selId
        ? h('div', { className: 'opui-none' }, 'Select a run to inspect it.')
        : detail && detail.loading ? h('div', { className: 'opui-none' }, 'Loading\u2026')
        : !d ? h('div', { className: 'opui-none' }, 'Loading\u2026')
        : h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { className: 'opui-dot ' + wfDot(d), style: { flex: 'none' } }),
            h('span', { style: { fontWeight: 600, fontSize: 13.5 } }, d.workflow_name || d.id),
            d.status === 'running' ? h('span', { className: 'opui-brs-live', style: { fontSize: 11 } }, '\u25cf running') : null),
          d.receipt && d.receipt.decision
            ? h('div', { className: 'opui-wf-decision ' + (d.receipt.decision === 'ship' ? 'good' : d.receipt.decision === 'blocked' ? 'bad' : 'warn') },
                (d.receipt.decision === 'ship' ? '\u2713 SHIP' : d.receipt.decision === 'blocked' ? '\u26d4 BLOCKED' : '\u21bb NEEDS FIX'),
                d.receipt.summary ? h('span', { style: { fontWeight: 400, opacity: .85 } }, ' \u2014 ' + d.receipt.summary) : null)
            : null,
          d.user_message ? h('div', { className: 'opui-wf-msg' }, d.user_message) : null,
          h('div', { style: { marginTop: 10 } },
            kv('Run', d.id || '\u2014'),
            d.started_at ? kv('Started', relTime(d.started_at, Date.now()) + ' ago') : null,
            d.current_step_index != null ? kv('Step', String(d.current_step_index)) : null,
            kv('Status', d.status || '\u2014')),
          d.metadata && d.metadata.model_bindings && Object.keys(d.metadata.model_bindings).length
            ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'opui-sec', style: { margin: '6px 0 4px' } }, 'Model bindings'),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  Object.entries(d.metadata.model_bindings).map(([k, v]) =>
                    h('span', { key: k, className: 'opui-chip' }, k + ': ', h('b', null, String(v))))))
            : null,
          d.receipt && Array.isArray(d.receipt.artifacts) && d.receipt.artifacts.length
            ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'opui-sec', style: { margin: '6px 0 4px' } }, 'Artifacts'),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  d.receipt.artifacts.map((a, i) => h('span', { key: i, className: 'opui-wf-art' }, a))))
            : null);

      const detailCard = h('div', { className: 'opui-sum-card' }, h('h4', null, 'Run detail'), detailBody);

      const wfCard = (w, i) => h('div', {
        key: i,
        style: { border: '1px solid var(--dsw-static-neutral-100,#d8dee4)', borderRadius: 8, padding: '8px 10px' },
      },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 } },
          w.category ? h('span', { className: 'opui-kind t' }, w.category) : null,
          h('span', { style: { fontWeight: 600, fontSize: 12 } }, w.name)),
        h('div', { style: { fontSize: 11.5, opacity: .65 } }, w.description || ''),
        w.tags && w.tags.length
          ? h('div', { style: { marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap' } },
              w.tags.map((t, j) => h('span', { key: j, className: 'opui-badge' }, t)))
          : null);

      const catalogCard = h('div', { className: 'opui-sum-card', style: { marginTop: 12 } },
        h('h4', null, 'Catalog'),
        h('input', {
          className: 'opui-filter', style: { width: '100%', marginBottom: 8 },
          placeholder: 'Filter workflows\u2026', value: wfQuery,
          onChange: (e) => setWfQuery(e.target.value),
        }),
        catalog.length === 0 ? h('div', { className: 'opui-none' }, 'No workflows match')
          : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 8 } },
              catalog.map(wfCard)));

      return h('div', { className: 'opui-sum' },
        head,
        h('div', { className: 'opui-sub', style: { marginBottom: 12 } },
          'The Archon workflow layer \u2014 authoritative run state, never chat text.'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12, alignItems: 'start' } },
          runsCard, detailCard),
        catalogCard);
    };

    // -------------------------------------------------------- capabilities tab

    const RCOS_STATUS_META = {
      promoted: { dot: 'done', chip: 'good', label: '\u2713 promoted' },
      candidate: { dot: 'idle', chip: 'run', label: '\u25cb candidate' },
      retired: { dot: 'blank', chip: '', label: '\u2690 retired' },
    };

    const verdictDot = (v) => v === 'ship' ? 'done' : v === 'fix' ? 'idle' : 'attention';

    // Distinct-task ships toward the x2 promotion gate.
    const shipProgress = (c) => new Set((c.evals || []).filter((e) => e.verdict === 'ship').map((e) => e.task_id)).size;

    const CapabilitiesTab = () => {
      const [data, setData] = useState({ phase: 'loading', registry: null, error: null, at: 0 });
      const [query, setQuery] = useState('');
      const [statusFilter, setStatusFilter] = useState('');
      const aliveRef = useRef(true);
      useTick(30000);

      const load = () => {
        fetch('/plugins/operator-ui/rcos?op=registry').then((r) => r.json()).then((d) => {
          if (!aliveRef.current) return;
          setData({ phase: 'ready', registry: d.ok ? d.registry : null, error: d.ok ? null : (d.error || 'registry failed'), at: d.ok ? Date.now() : 0 });
        }).catch(() => {});
      };
      useEffect(() => {
        aliveRef.current = true;
        load();
        return () => { aliveRef.current = false; };
      }, []);

      if (data.error) {
        return h('div', { className: 'opui-sum' },
          h('div', { className: 'opui-empty', style: { paddingTop: 60 } },
            h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, 'Capability registry not available'),
            h('div', { className: 'opui-sub', style: { maxWidth: 460, margin: '0 auto' } }, data.error)));
      }
      const caps = (data.registry && data.registry.capabilities) || [];
      const q = query.trim().toLowerCase();
      const shown = caps.filter((c) =>
        (!q || ((c.name || '') + ' ' + (c.id || '') + ' ' + (c.kind || '')).toLowerCase().includes(q)) &&
        (!statusFilter || c.status === statusFilter));
      const counts = { promoted: 0, candidate: 0, retired: 0 };
      for (const c of caps) if (counts[c.status] != null) counts[c.status]++;

      const capCard = (c, i) => {
        const meta = RCOS_STATUS_META[c.status] || RCOS_STATUS_META.candidate;
        const ships = shipProgress(c);
        return h('div', {
          key: c.id || i,
          style: { border: '1px solid var(--dsw-static-neutral-100,#d8dee4)', borderRadius: 10, padding: '10px 12px', opacity: c.status === 'retired' ? .62 : 1 },
        },
          h('div', { style: { display: 'flex', gap: 7, alignItems: 'center', marginBottom: 4 } },
            h('span', { className: 'opui-dot ' + meta.dot, style: { flex: 'none' } }),
            h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, c.name || c.id),
            c.kind ? h('span', { className: 'opui-kind t' }, c.kind) : null,
            h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: .55 } }, 'v' + (c.version || '?'))),
          c.status === 'candidate'
            ? h('div', { className: 'opui-wf-decision warn', style: { margin: '4px 0 6px', fontSize: 11.5 } },
                '\u25cb gate ' + Math.min(ships, 2) + '/2 ships', ships > 0 ? ' \u00b7 ' + ships + ' ship' + (ships === 1 ? '' : 's') + ' recorded' : ' \u00b7 no shipped evals yet')
            : c.status === 'retired'
              ? h('div', { className: 'opui-wf-decision bad', style: { margin: '4px 0 6px', fontSize: 11.5 } },
                  '\u2690 retired', c.retire_reason ? h('span', { style: { fontWeight: 400, opacity: .85 } }, ' \u2014 ' + c.retire_reason) : null)
              : h('div', { className: 'opui-wf-decision good', style: { margin: '4px 0 6px', fontSize: 11.5 } },
                  '\u2713 promoted \u00b7 reused ' + (c.reuse_count || 0) + '\u00d7'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
            (c.evals || []).slice(-6).map((e, j) => h('span', {
              key: j, className: 'opui-dot ' + verdictDot(e.verdict),
              title: e.task_id + ' \u2192 ' + e.verdict + (e.run_id ? ' (' + e.run_id + ')' : ''),
            })),
            (c.evals || []).length > 6 ? h('span', { className: 'opui-meta' }, '+' + (c.evals.length - 6)) : null,
            c.last_eval ? h('span', { className: 'opui-meta', style: { marginLeft: 'auto' } }, 'eval ' + c.last_eval) : null));
      };

      const head = h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 10px' } },
        h('h2', null, 'Capabilities'),
        h('span', { className: 'opui-chip good' }, h('b', null, counts.promoted), 'promoted'),
        h('span', { className: 'opui-chip' }, h('b', null, counts.candidate), 'candidates'),
        h('span', { className: 'opui-chip' }, h('b', null, counts.retired), 'retired'),
        h('span', { className: 'opui-spacer' }),
        data.registry ? h('span', { className: 'opui-hint' }, 'registry ' + (data.registry.registry_version || 'v?')) : null,
        h('button', { className: 'opui-btn', onClick: load }, 'Refresh'));

      const filterRow = h('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
        h('input', {
          className: 'opui-filter', placeholder: 'Filter capabilities\u2026',
          value: query, onChange: (e) => setQuery(e.target.value),
        }),
        ['', 'promoted', 'candidate', 'retired'].map((st) => h('span', {
          key: st,
          className: 'opui-chip' + (statusFilter === st ? ' run' : ''),
          style: { cursor: 'pointer' },
          onClick: () => setStatusFilter(st),
        }, st || 'all')));

      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 10 } },
        shown.map(capCard));

      return h('div', { className: 'opui-sum' },
        head,
        h('div', { className: 'opui-sub', style: { marginBottom: 12 } },
          'The RCOS capability registry \u2014 admitted only through the promotion gate (2 ships on distinct tasks), retired on decay. Reuse is the compounding metric.'),
        filterRow,
        data.phase === 'loading' ? h('div', { className: 'opui-none' }, 'Loading\u2026')
          : shown.length === 0 ? h('div', { className: 'opui-none' }, 'No capabilities match')
          : grid);
    };

    // ══════════════════════════════════════════════ M0 control plane ════
    // Four product surfaces (proposal §1): SYSTEM / WORK / INTELLIGENCE /
    // (FLEET later). Reversible migration: the legacy tabs stay registered;
    // these surfaces are additive, and the first-run gate overlay can be
    // dismissed to legacy mode via a persisted client preference.
    //
    // Rules honored here (M0 authorization):
    // - lifecycleState and routingEligibility are SEPARATE: eligibility is
    //   derived (decision + reasons), never copied from lifecycle.
    // - Receipt freshness is fetched live from /verify?op=receipt — the
    //   client never duplicates or re-derives receipt state.
    // - The seeded verification capability is SYSTEM-oriented and never
    //   presented as the user's first useful task.

    const MODE_KEY = 'opui-cp-mode'; // 'm0' (default) | 'legacy'
    const getMode = () => {
      try { return localStorage.getItem(MODE_KEY) === 'legacy' ? 'legacy' : 'm0'; } catch { return 'm0'; }
    };
    const modeStore = (() => {
      let mode = getMode();
      const subs = new Set();
      return {
        get: () => mode,
        set(m) { mode = m; try { localStorage.setItem(MODE_KEY, m); } catch {} subs.forEach((f) => f()); },
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      };
    })();

    // ONE shared receipt/status store: every surface sees the same live
    // state, and one reload (e.g. after POST /verify) refreshes them all.
    // Live reads only — the client never duplicates or re-derives receipt
    // state (M0 rule).
    const receiptStore = (() => {
      let state = { vr: null, st: null };
      let loading = false;
      let loaded = false;
      const subs = new Set();
      const load = () => {
        if (loading) return;
        loading = true;
        Promise.all([
          fetch('/plugins/operator-ui/verify?op=receipt').then((r) => r.json()).catch(() => null),
          fetch('/plugins/operator-ui/status').then((r) => r.json()).catch(() => null),
        ]).then(([vr, st]) => {
          state = { vr, st };
          loading = false;
          loaded = true;
          subs.forEach((f) => f());
        });
      };
      setInterval(load, 30000);
      return {
        get: () => state,
        isLoaded: () => loaded,
        load,
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      };
    })();

    const useReceiptGate = () => {
      const snap = useSyncExternalStore(receiptStore.subscribe, receiptStore.get);
      useEffect(() => { receiptStore.load(); }, []);
      return { vr: snap.vr, st: snap.st, reload: receiptStore.load };
    };

    // Derived routing eligibility (proposal §1.3, as corrected): NEVER copied
    // from lifecycle state — a decision from evidence + current availability
    // + compatibility, always with reasons.
    const deriveEligibility = (cap, st) => {
      const reasons = [];
      const lifecycle = String(cap.status || 'unknown').toUpperCase();
      if (cap.seed === true) {
        return { decision: 'CONDITIONAL', reasons: ['SEEDED system-verification capability — system-oriented, not offered as user work'] };
      }
      if (lifecycle === 'RETIRED') {
        reasons.push('lifecycle RETIRED' + (cap.retire_reason ? ' — ' + cap.retire_reason : ''));
        return { decision: 'INELIGIBLE', reasons };
      }
      if (lifecycle === 'CANDIDATE') reasons.push('thin evidence: lifecycle CANDIDATE (promotion gate not passed)');
      const archon = st && st.components && st.components.archon;
      if (cap.kind === 'workflow' || cap.workflow) {
        if (!archon || archon.state !== 'AVAILABLE') {
          reasons.push('execution adapter (Archon) not AVAILABLE right now');
          return { decision: 'INELIGIBLE', reasons };
        }
        reasons.push('execution adapter AVAILABLE' + (archon.detail && archon.detail.serviceVersion ? ' (' + archon.detail.serviceVersion + ')' : ''));
      }
      if (lifecycle === 'PROMOTED' || lifecycle === 'VERIFIED') return { decision: 'ELIGIBLE', reasons };
      if (lifecycle === 'CANDIDATE') return { decision: 'CONDITIONAL', reasons };
      reasons.push('lifecycle ' + lifecycle + ' — eligibility unknown');
      return { decision: 'UNKNOWN', reasons };
    };

    // ------------------------------------------------------------ SYSTEM v0
    // Receipt-gated first-run + machine/runtime management. The gate is the
    // already-proven verification contract rendered full-screen.

    const VER_CHIP2 = { RCOS_VERIFIED: 'good', SYSTEM_VERIFIED: 'run', NOT_VERIFIED: 'att' };
    const FRESH_CHIP2 = { VALID: 'good', STALE: 'run', TAMPERED: 'att', NONE: '', UNSEALED: 'att' };

    const SystemSurface = () => {
      const { vr, st, reload } = useReceiptGate();
      const mode = useSyncExternalStore(modeStore.subscribe, modeStore.get);
      const runVerify = () => {
        fetch('/plugins/operator-ui/verify', { method: 'POST' }).then(() => reload()).catch(() => {});
      };
      const comps = st && st.components ? st.components : null;
      const order = ['dsh', 'operatorUi', 'node', 'archon', 'rcos', 'git', 'chrome', 'tools', 'providers'];
      const rec = vr && vr.receipt ? vr.receipt : null;
      const fresh = vr ? vr.state : 'NONE';
      const OPTIONAL = ['chrome', 'tools', 'providers'];
      const degraded = comps ? order.filter((k) => comps[k] && comps[k].state !== 'AVAILABLE') : [];
      const requiredDegraded = degraded.filter((k) => !OPTIONAL.includes(k));
      const optionalDown = degraded.filter((k) => OPTIONAL.includes(k));
      const available = comps ? order.filter((k) => comps[k] && comps[k].state === 'AVAILABLE') : [];
      const [showInv, setShowInv] = useState(false);

      // HERO: the verification state IS the surface's headline.
      const heroTitle = fresh === 'VALID' ? ['\u2713 RCOS verified', 'ok']
        : fresh === 'STALE' ? ['RCOS verification is stale', 'run']
        : fresh === 'TAMPERED' ? ['Receipt was modified after sealing', 'err']
        : ['Not verified yet', 'run'];
      const heroSub = fresh === 'VALID' && rec
        ? 'Core execution path verified ' + relTime(Date.parse(rec.createdAt), Date.now()) + ' ago' + (optionalDown.length ? ' \u00b7 ' + optionalDown.length + ' optional integration' + (optionalDown.length > 1 ? 's' : '') + ' unavailable' : '') + '.'
        : fresh === 'STALE' && vr ? (vr.staleReasons || [])[0] || 'This installation changed since its receipt.'
        : fresh === 'TAMPERED' ? 'The receipt no longer matches its seal — invalid, not merely old.'
        : 'Run verification to execute the real seeded path and seal the genesis receipt.';

      return h('div', { className: 'opui-sum' },
        h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 10px' } },
          h('h2', null, 'System'),
          h('span', { className: 'opui-spacer' }),
          h('button', { className: 'opui-btn', onClick: () => modeStore.set(mode === 'm0' ? 'legacy' : 'm0') }, mode === 'm0' ? 'Legacy tabs' : 'Control plane'),
          h('button', { className: 'opui-btn', onClick: reload }, 'Refresh')),
        h('div', { className: 'opui-sum-card', style: { marginBottom: 12 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
            h('div', { className: 'opui-stage-marker ' + heroTitle[1], style: { position: 'static', marginTop: 5, flex: 'none' } }),
            h('div', { style: { flex: 1 } },
              h('div', { className: 'opui-stage-title', style: { fontSize: 18 } }, heroTitle[0]),
              h('div', { className: 'opui-sub', style: { marginTop: 2 } }, heroSub))),
          h('div', { style: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
            h('button', { className: 'opui-btn', onClick: runVerify }, 'Verify again'),
            rec ? h('span', { className: 'opui-meta' },
              'Receipt ' + fresh.toLowerCase() + ' \u00b7 ' + ((rec.seal && rec.seal.hash) || '').slice(7, 23) + '\u2026') : null)),
        fresh === 'STALE' && vr && vr.staleReasons && vr.staleReasons.length > 1 ? h('div', { className: 'opui-meta', style: { marginBottom: 12 } },
          vr.staleReasons.slice(1).map((r, i) => h('div', { key: i }, '\u00b7 ' + r))) : null,
        // NEEDS ATTENTION — required degradation only; vanishes when empty.
        comps && requiredDegraded.length ? h('div', { className: 'opui-sum-card', style: { marginBottom: 12, borderColor: 'var(--dsw-static-amber-500,#d97706)' } },
          h('h4', null, 'Needs attention'),
          requiredDegraded.map((k) => h('div', { key: k, className: 'opui-kv', title: comps[k].reason || '' },
            h('span', null, k),
            h('span', null, comps[k].state + (comps[k].reason ? ' \u2014 ' + comps[k].reason.slice(0, 90) : ''))))) : null,
        // OPTIONAL integrations: quieter card, never contradicts verification.
        comps && optionalDown.length ? h('div', { className: 'opui-sum-card', style: { marginBottom: 12, opacity: .8 } },
          h('h4', null, 'Optional integrations unavailable'),
          h('div', { className: 'opui-meta' }, 'These degrade features honestly \u2014 verification is not affected.'),
          optionalDown.map((k) => h('div', { key: k, className: 'opui-kv', title: comps[k].reason || '' },
            h('span', null, k),
            h('span', null, comps[k].state + (comps[k].reason ? ' \u2014 ' + comps[k].reason.slice(0, 80) : ''))))) : null,
        // COMPONENTS — collapsed inventory.
        h('div', { className: 'opui-sum-card' },
          h('button', { className: 'opui-sys-toggle', onClick: () => setShowInv(!showInv) },
            (showInv ? '\u25be ' : '\u25b8 ') + 'Components (' + available.length + ' available' + (requiredDegraded.length ? ', ' + requiredDegraded.length + ' needing attention' : '') + (optionalDown.length ? ', ' + optionalDown.length + ' optional down' : '') + ')'),
          showInv ? available.map((k) => h('div', { key: k, className: 'opui-kv' },
            h('span', null, k),
            h('span', null, String(comps[k].version || (comps[k].detail && comps[k].detail.serviceVersion) || 'available')))) : null),
        !rec ? h('div', { className: 'opui-meta', style: { marginTop: 10 } }, 'No receipt yet — Run verification produces the genesis receipt (Probe A needs nothing; Probe B routes a seeded workflow through the registry + Archon).') : null);
    };

    // First-run gate: no VALID current receipt ⇒ SYSTEM full-screen. STALE /
    // TAMPERED / NOT_VERIFIED stay distinct. Escape hatch → legacy tabs
    // (reversible migration boundary; persisted client preference only).
    const GateOverlay = ({ onOpenSurface, onRerun }) => {
      const { vr, st, reload } = useReceiptGate();
      const fresh = vr ? vr.state : null;
      if (fresh === null) return null; // still loading — flash nothing
      if (fresh === 'VALID') return null;
      // Same contracts as SYSTEM, a different job: a focused activation
      // screen, not an inspector. One hero state, one checklist, one action.
      const comps = st && st.components ? st.components : null;
      const order = ['dsh', 'operatorUi', 'node', 'archon', 'rcos', 'git', 'chrome', 'tools', 'providers'];
      const checklist = comps ? order.map((k) => {
        const c = comps[k];
        const ok = c.state === 'AVAILABLE';
        const optional = k === 'chrome' || k === 'tools' || k === 'providers';
        return { name: k, ok, optional, note: ok ? (c.version || (c.detail && c.detail.serviceVersion) || '') : c.state + (optional ? ' \u00b7 optional' : '') };
      }) : [];
      const headline = fresh === 'TAMPERED' ? ['Receipt was modified — verify again', 'err']
        : fresh === 'STALE' ? ['This installation changed since its last verification', 'run']
        : ['Bring RCOS online', 'run'];
      const verify = () => { if (onRerun) onRerun(); else fetch('/plugins/operator-ui/verify', { method: 'POST' }).then(() => reload()).catch(() => {}); };
      return h('div', { className: 'opui-gate' },
        h('div', { className: 'opui-gate-inner', style: { maxWidth: 640 } },
          h('div', { className: 'opui-stage', style: { paddingBottom: 16 } },
            h('div', { className: 'opui-stage-marker ' + headline[1] }),
            h('div', { className: 'opui-stage-key' }, 'RCOS'),
            h('div', { className: 'opui-stage-title', style: { fontSize: 20 } }, headline[0]),
            h('div', { className: 'opui-sub', style: { marginTop: 6 } },
              fresh === 'NONE' ? 'Verification executes a real capability through your registry and Archon — the green state is earned, sealed, and re-checked against this machine.'
              : fresh === 'TAMPERED' ? 'The sealed receipt no longer matches its contents. Run verification to reissue it.'
              : 'Configuration or components changed since the last verification. Run it again to reissue the receipt.'),
            h('div', { style: { margin: '16px 0' } },
              checklist.map((c, i) => h('div', { key: i, className: 'opui-kv' },
                h('span', null,
                  h('span', { className: 'opui-dot ' + (c.ok ? 'done' : c.optional ? 'idle' : 'attention'), style: { display: 'inline-block', verticalAlign: 'baseline', marginRight: 6 } }),
                  c.name),
                h('span', { className: 'opui-mono' }, c.note || '')))),
            h('button', { className: 'opui-btn', style: { padding: '9px 20px', fontSize: 13, fontWeight: 600 }, onClick: verify }, 'Verify RCOS'),
            h('div', { style: { display: 'flex', gap: 14, marginTop: 14 } },
              onOpenSurface ? h('button', { className: 'opui-copybtn', onClick: () => onOpenSurface('work') }, 'Work \u203a') : null,
              h('button', { className: 'opui-copybtn', onClick: () => modeStore.set('legacy') }, 'Use legacy tabs (debug)')))));
    };

    // Control-plane launcher: the M0 surfaces are reachable from the shell
    // alone — no DSH session required (the conversation tab rail only
    // renders inside a session view, and WORK/INTELLIGENCE must not depend
    // on one). Small fixed launcher; surfaces open full-screen.
    const SurfaceOverlay = () => {
      const mode = useSyncExternalStore(modeStore.subscribe, modeStore.get);
      // RCOS owns the front door (M0 adjudication P0): a fresh operator lands
      // on Work, not on the DSH home. The DSH shell stays reachable via the
      // nav's explicit 'DSH home' escape — preserved, never the default.
      const [open, setOpen] = useState('work'); // 'work' | 'intelligence' | 'system' | null (null = DSH shell)
      const { vr, reload } = useReceiptGate();
      const [justVerified, setJustVerified] = useState(false);
      const gateRunRef = useRef(false);
      const prevFresh = useRef(null);
      const [act, setAct] = useState({ running: 0, failed: 0 });
      useEffect(() => {
        let alive = true;
        const load = () => fetch('/plugins/operator-ui/goal').then((r) => r.json()).then((d) => {
          if (!alive || !d.ok) return;
          const gs = d.goals || [];
          setAct({ running: 0, failed: gs.filter((g) => goalVerdict(g) === 'FAILED').length });
        }).catch(() => {});
        load();
        const t = setInterval(load, 30000);
        return () => clearInterval(t);
      }, []);
      // Activation moment: when a verification STARTED FROM THE GATE lands
      // VALID, show the RCOS_VERIFIED hero before entering the shell.
      useEffect(() => {
        const fresh = vr ? vr.state : null;
        if (gateRunRef.current && fresh === 'VALID' && prevFresh.current !== 'VALID') {
          setJustVerified(true);
          gateRunRef.current = false;
        }
        if (fresh !== null) prevFresh.current = fresh;
      }, [vr]);
      if (mode !== 'm0') return null;
      // First-run gate has priority: no VALID current genesis receipt ⇒
      // SYSTEM full-screen (NONE / STALE / TAMPERED each distinct).
      const fresh = vr ? vr.state : null;
      const gateOpen = fresh !== null && fresh !== 'VALID';
      const SURFACES = {
        system: { label: 'System', el: h(SystemSurface, null) },
        work: { label: 'Work', el: null },          // Work needs ctx — see below
        intelligence: { label: 'Intelligence', el: h(IntelligenceSurface, null) },
      };
      const surfaceNav = h('div', { className: 'opui-nav' },
        ['work', 'intelligence', 'system'].map((k) => h('button', {
          key: k,
          className: 'opui-navbtn' + (open === k ? ' cur' : ''),
          onClick: () => setOpen(k),
        }, SURFACES[k].label)),
        h('span', { className: 'opui-spacer' }),
        fresh === 'VALID' ? h('span', { className: 'opui-chip ok' }, 'verified') : null,
        act.failed ? h('span', { className: 'opui-chip att' }, act.failed + ' needs attention') : null,
        h('button', { className: 'opui-copybtn', title: 'Open the DSH shell (sessions, chat)', onClick: () => setOpen(null) }, 'DSH home \u2192'));
      if (gateOpen) {
        return h(GateOverlay, {
          onOpenSurface: (k) => setOpen(k),
          gateKind: fresh,
          onRerun: () => { gateRunRef.current = true; fetch('/plugins/operator-ui/verify', { method: 'POST' }).then(() => reload()).catch(() => {}); },
        });
      }
      if (justVerified && vr && vr.receipt) {
        return h('div', { className: 'opui-gate' },
          h('div', { className: 'opui-gate-inner' },
            h('div', { className: 'opui-sum' },
              h('div', { className: 'opui-stage' },
                h('div', { className: 'opui-stage-marker ok' }),
                h('div', { className: 'opui-stage-key' }, 'Genesis receipt'),
                h('div', { className: 'opui-stage-title' }, 'RCOS VERIFIED'),
                h('div', { className: 'opui-sub', style: { marginTop: 4 } }, 'Real execution completed through Archon. This installation is sealed and verified.'),
                h('div', { className: 'opui-mono', style: { marginTop: 8 } }, (vr.receipt.seal && vr.receipt.seal.hash || '').slice(0, 30) + '\u2026'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 14 } },
                  h('button', { className: 'opui-btn', onClick: () => setJustVerified(false) }, 'Enter RCOS'))))));
      }
      if (fresh === null) return null; // receipt still loading — flash nothing
      return h('div', null,
        open === null ? h('div', { style: { position: 'fixed', right: 14, bottom: 14, zIndex: 9000, display: 'flex', gap: 6 } },
          ['system', 'work', 'intelligence'].map((k) => h('button', {
            key: k,
            className: 'opui-btn',
            style: { background: 'var(--dsw-static-neutral-50,#f6f8fa)', boxShadow: '0 1px 4px rgba(0,0,0,.15)' },
            onClick: () => setOpen(k),
          }, SURFACES[k].label))) : null,
        open !== null ? h('div', { className: 'opui-gate' },
          h('div', { className: 'opui-gate-inner' },
            surfaceNav,
            open === 'work'
              ? h(SessionlessWork, { onClose: () => setOpen(null) })
              : h('div', { className: 'opui-sum' }, SURFACES[open].el))) : null);
    };

    // WORK surface without a session context (no DSH sessions store access
    // here): Archon-run tasks only — honest about the scope. Shares the same
    // TaskRow/SpineCard builders as the tab variant.
    const SessionlessWork = ({ onClose }) => {
      const [runs, setRuns] = useState(null);
      const [sel, setSel] = useState(null);
      const [detail, setDetail] = useState(null);
      const [reg, setReg] = useState(null);
      const [st, setSt] = useState(null);
      const [goals, setGoals] = useState([]);
      const [teaching, setTeaching] = useState([]);
      const [teachBusy, setTeachBusy] = useState(false);
      const loadRuns = () => {
        fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((d) => { if (d.ok) setRuns(d.runs || []); else setRuns([]); }).catch(() => setRuns([]));
        fetch('/plugins/operator-ui/goal').then((r) => r.json()).then((d) => { if (d.ok) setGoals(d.goals || []); }).catch(() => {});
        fetch('/plugins/operator-ui/teach').then((r) => r.json()).then((d) => { if (d.ok) setTeaching(d.teaching || []); }).catch(() => {});
        fetch('/plugins/operator-ui/rcos').then((r) => r.json()).then((d) => { if (d.ok) setReg(d.registry); }).catch(() => {});
        fetch('/plugins/operator-ui/status').then((r) => r.json()).then(setSt).catch(() => {});
      };
      // Teach RCOS: open a TEACHING task from a gap (no-route or BLOCK).
      // The source task is never mutated; the teaching envelope is a new,
      // separately-identified durable task.
      const teachFrom = (sourceTaskId) => {
        if (teachBusy) return;
        setTeachBusy(true);
        setSel('teach:' + sourceTaskId);
        fetch('/plugins/operator-ui/teach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId }) })
          .then((r) => r.json())
          .then((d) => { loadRuns(); if (d.ok && d.teaching) setSel('teach:' + d.teaching.taskId); })
          .catch(() => loadRuns())
          .finally(() => setTeachBusy(false));
      };
      useEffect(() => { loadRuns(); }, []);
      const openRun = (id) => {
        setSel(id);
        setDetail(null);
        fetch('/plugins/operator-ui/archon?op=run&id=' + encodeURIComponent(id))
          .then((r) => r.json()).then(setDetail).catch(() => setDetail({ ok: false, error: 'run detail unavailable' }));
      };
      const seededWf = new Set((reg && Array.isArray(reg.capabilities) ? reg.capabilities : []).filter((c) => c.seed === true).map((c) => c.workflow));
      const runToTask = {};
      for (const g of goals) for (const a of (g.attempts || [])) if (a.runId) runToTask[a.runId] = g;
      const rerun = (taskId, mode) => {
        const env = goals.find((g) => g.taskId === taskId);
        if (!env) return;
        const body = mode === 'fork' ? { objective: env.objective, forkOf: taskId } : { objective: env.objective, retryOf: taskId };
        fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then((r) => r.json()).then(() => loadRuns()).catch(() => {});
      };
      const items = (runs || []).map((r) => { const g = runToTask[r.id]; return { key: r.id, src: 'archon', title: r.user_message || r.workflow_name, sub: r.workflow_name + (g ? ' \u00b7 ' + g.taskId : ''), at: fmtRunTime(r.started_at), status: r.status, verdict: r.receipt && r.receipt.decision, sys: seededWf.has(r.workflow_name), taskId: g ? g.taskId : null, goal: g }; });
      // Envelopes that never reached execution are durable tasks too: an
      // awaiting-approval task must stay visible (its Next Action is Approve),
      // a refused task keeps its refusal card. Run-backed envelopes are
      // already listed above via their runs.
      for (const g of goals) {
        const awaiting = goalFailureCodes(g).includes('awaiting-approval');
        if (!(awaiting || goalVerdict(g) === 'FAILED')) continue;
        if ((g.attempts || []).some((a) => a.runId)) continue;
        items.push({ key: 'goal:' + g.taskId, src: 'goal', title: g.objective, sub: awaiting ? 'goal \u00b7 awaiting your approval' : 'goal \u00b7 refused before execution', at: fmtRunTime(g.createdAt), status: awaiting ? 'awaiting-approval' : 'failed', verdict: awaiting ? null : 'failed', taskId: g.taskId, goal: g });
      }
      for (const t of teaching) {
        items.push({ key: 'teach:' + t.taskId, src: 'teaching', title: 'Teach RCOS: ' + ((t.gap && t.gap.objective) || t.sourceTaskId), sub: 'teaching \u00b7 ' + (t.verdict === 'CANDIDATE' ? 'candidate ready' : t.status === 'promoted' ? 'learned + promoted' : t.status), at: fmtRunTime(t.createdAt), status: t.status, verdict: t.verdict, teach: t });
      }
      const d = detail && detail.ok ? (detail.run ? detail : { run: detail, events: [] }) : null;
      const runObj = d ? d.run : null;
      const selItem = items.find((t) => t.key === sel) || null;
      const [evd, setEvd] = useState(null);
      const userTasks = items.filter((t) => !t.sys);
      const sysTasks = items.filter((t) => t.sys);
      const [showSys, setShowSys] = useState(false);
      // Approval POST is owned by the Result Card; loadRuns() refreshes both
      // runs + goal envelopes after it returns.
      return h('div', { className: 'opui-sum' },
        h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 10px' } },
          h('h2', null, 'Work'),
          h('span', { className: 'opui-hint' }, 'Follow a task from request to verdict.'),
          h('span', { className: 'opui-spacer' }),
          h('button', { className: 'opui-btn', onClick: loadRuns }, 'Refresh')),
        h(GoalComposer, { onDone: () => { fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((d) => { if (d.ok) setRuns(d.runs || []); }).catch(() => {}); }, onTeach: teachFrom }),
        teachBusy ? h('div', { className: 'opui-meta', style: { margin: '6px 0' } }, 'Learning\u2026 building a candidate and evaluating it on the real Archon (this takes ~30\u201360s).') : null,
        !items.length ? h('div', { className: 'opui-none' }, 'No execution tasks yet — give RCOS work and it appears here.')
          : h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start' } },
              h('div', { className: 'opui-work-list', style: { flex: '0 0 32%' } },
                userTasks.map((t) => h(TaskRow, { key: t.key, t, sel, onOpen: openRun })),
                sysTasks.length ? h('div', null,
                  h('button', { className: 'opui-sys-toggle', onClick: () => setShowSys(!showSys) },
                    (showSys ? '\u25be ' : '\u25b8 ') + 'System activity (' + sysTasks.length + ')'),
                  showSys ? sysTasks.map((t) => h(TaskRow, { key: t.key, t, sel, onOpen: openRun })) : null) : null),
              selItem && selItem.src === 'goal' ? (() => {
                const g = selItem.goal;
                const gCodes = goalFailureCodes(g);
                const awaiting = gCodes.includes('awaiting-approval');
                return h('div', { className: 'opui-sum-card', style: { flex: 1 } },
                  h('h4', null, 'Task spine'),
                  h(CardBoundary, { label: 'Result card' }, h(ResultCard, { goal: g, onApproved: (ng) => {
                    // Preview → Act → Prove in ONE view: after the approval
                    // dispatch completes, follow the task's new run so the
                    // spine transitions to the executed result.
                    const rid = ng && ng.attempts && ng.attempts.length ? (ng.attempts[ng.attempts.length - 1].runId || null) : null;
                    loadRuns();
                    if (rid) openRun(rid);
                  }, onTeach: () => teachFrom(g.taskId) })),
                  h('div', { className: 'opui-spine' }, [
                    ['Request', g.objective],
                    ['Route', (g.route && g.route.reason) || '\u2014'],
                    ['Execution', awaiting ? 'awaiting your approval — nothing dispatched yet' : '\u2014 (refused before execution)'],
                    ['Evidence', '\u2014'],
                    ['Verdict', goalVerdict(g) + (gCodes.length ? ' \u00b7 ' + gCodes.join(', ') : '')],
                  ].map(([k, v]) => h('div', { key: k, className: 'opui-spine-row' },
                    h('div', { className: 'opui-spine-key' }, k),
                    h('div', { className: 'opui-spine-val' }, String(v))))),
                  goalError(g) ? h('div', { className: 'opui-meta', style: { marginTop: 6 } }, goalError(g)) : null,
                  !awaiting ? h('div', { style: { display: 'flex', gap: 10, marginTop: 8 } },
                    h('button', { className: 'opui-copybtn', onClick: () => rerun(g.taskId, 'retry') }, 'Retry (same task)'),
                    h('button', { className: 'opui-copybtn', onClick: () => rerun(g.taskId, 'fork') }, 'Fork as new task')) : null);
              })()
              : selItem && selItem.src === 'teaching' ? h('div', { className: 'opui-sum-card', style: { flex: 1 } },
                  h('h4', null, 'Teaching spine'),
                  h(CardBoundary, { label: 'Teaching card' }, h(TeachingCard, { t: selItem.teach, onRefresh: loadRuns })))
              : selItem ? h(CardBoundary, { label: 'Task spine' }, h(SpineCard, {
                selItem: { ...selItem, key: 'archon:' + selItem.key },
                runObj, events: d ? d.events : null, reg, st, isArchon: true,
                onEvidence: setEvd,
                onRetry: (tid) => rerun(tid, 'retry'),
                onFork: (tid) => rerun(tid, 'fork'),
              })) : h('div', { className: 'opui-sum-card', style: { flex: 1 } }, h('h4', null, 'Task spine'), h('div', { className: 'opui-meta' }, 'Select a task to follow it end to end.')),
              evd ? h(EvidenceDrawer, { ...evd, onClose: () => setEvd(null) }) : null));
    };

    // Evidence Drawer — the RCOS primitive: every claim opens its chain.
    // Claim -> Supported by -> Execution -> Observed outputs -> Provenance.
    const EvidenceDrawer = ({ title, claim, supportedBy, executionRows, outputRows, provenanceRows, onClose }) => {
      const sec = (heading, rows) => h('div', { className: 'opui-sum-card', style: { marginTop: 10 } },
        h('h4', null, heading),
        rows.map((r, i) => h('div', { key: i, className: 'opui-kv' }, h('span', null, r[0]), h('span', null, String(r[1])))));
      return h('div', { className: 'opui-gate', onClick: onClose },
        h('div', { className: 'opui-gate-inner', style: { maxWidth: 760 }, onClick: (e) => e.stopPropagation() },
          h('div', { className: 'opui-sum' },
            h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 8px' } },
              h('h2', null, 'Evidence'),
              h('span', { className: 'opui-hint' }, title || '')),
            h('div', { className: 'opui-sum-card' },
              h('h4', null, 'Claim'),
              h('div', { className: 'opui-stage-title' }, claim)),
            sec('Supported by', supportedBy || []),
            executionRows && executionRows.length ? sec('Execution', executionRows) : null,
            outputRows && outputRows.length ? sec('Observed outputs', outputRows.map((o) => ['\u00b7', o])) : null,
            provenanceRows && provenanceRows.length ? sec('Provenance', provenanceRows) : null,
            h('div', { style: { marginTop: 12 } },
              h('button', { className: 'opui-btn', onClick: onClose }, 'Close')))));
    };

    // ------------------------------------------------------------- WORK v0
    // ONE task, end to end: request → route → capability → execution →
    // evidence → verdict. Tasks come from Archon runs (spine-complete) and
    // DSH sessions (request-level in v0). The route layer reads the
    // configured registry — a workflow dispatched outside the registry says
    // so honestly. Shared builders keep the tab and session-less variants
    // from drifting.
    //
    // Goal Mode (M1-candidate, zero-credential v0): the composer is the
    // "give RCOS work" affordance. POST /goal routes the objective through
    // the registry, executes on the configured Archon, and independently
    // verifies the evidence (terminal status + the capability's declared
    // expectation) before any verdict — SHIP is earned, never assumed.

    const GOAL_CHIP = { SHIP: 'ok', BLOCK: 'att', FAILED: 'att', PENDING: 'run' };

    const GoalComposer = ({ onDone, onTeach }) => {
      const [obj, setObj] = useState('');
      const [busy, setBusy] = useState(false);
      const [goal, setGoal] = useState(null);
      const submit = () => {
        const o = obj.trim();
        if (!o || busy) return;
        setBusy(true);
        fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: o }) })
          .then((r) => r.json())
          .then((d) => { setGoal(d.goal || null); setObj(''); if (onDone) onDone(d.goal); })
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      const stage = (key, markerCls, body) => h('div', { key: key, className: 'opui-stage' },
        h('div', { className: 'opui-stage-marker ' + markerCls }),
        h('div', { className: 'opui-stage-key' }, key),
        h('div', { className: 'opui-stage-val' }, body));
      const gv = goalVerdict(goal);
      const verdictChip = goal && gv !== 'PENDING'
        ? h('span', { className: 'opui-chip ' + (GOAL_CHIP[gv] || '') }, gv) : null;
      return h('div', { className: 'opui-sum-card', style: { marginBottom: 12 } },
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            className: 'opui-filter', style: { flex: 1 },
            placeholder: 'What do you want RCOS to do?',
            value: obj,
            onChange: (e) => setObj(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          }),
          h('button', { className: 'opui-btn', onClick: submit }, busy ? 'Working\u2026' : 'Give to RCOS')),
        h('div', { className: 'opui-meta', style: { marginTop: 4 } }, 'Routed through the configured registry, executed on the configured Archon, verified against the capability\u2019s declared expectation.'),
        goal ? h('div', null,
          h(CardBoundary, { label: 'Result card' }, h(ResultCard, { goal, onApproved: (ng) => { setGoal(ng); if (onDone) onDone(ng); }, onTeach })),
          h('div', { className: 'opui-spine', style: { marginTop: 10 } },
          stage('Goal', gv === 'SHIP' ? 'ok' : gv === 'PENDING' ? 'run' : 'err',
            h('div', { className: 'opui-stage-title' }, goal.objective),
            verdictChip ? h('div', { style: { marginTop: 3 } }, verdictChip) : null),
          goal.route ? stage('Route', goal.route.selected ? 'ok' : 'err',
            h('div', null,
              goal.route.selected
                ? h('div', null, h('b', null, goal.route.selected.id), h('span', { className: 'opui-mono' }, ' v' + (goal.route.selected.version || '?')), ' \u2192 ', h('span', { className: 'opui-mono' }, goal.route.selected.workflow))
                : h('div', null, goal.route.reason),
              goal.route.selected ? h('div', { className: 'opui-elig' }, h('span', { className: 'why' }, goal.route.reason)) : null,
              goal.route.considered && goal.route.considered.length > 1 ? h('div', { className: 'opui-meta', style: { marginTop: 2 } }, 'considered ' + goal.route.considered.length + ' capabilities') : null)) : null,
          goal.attempts && goal.attempts.length ? goal.attempts.map((a, i) => stage('Execution ' + (goal.attempts.length > 1 ? a.attempt : ''), a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'err' : 'run',
            h('div', null,
              h('span', null, (a.runId || '').slice(0, 8) ? h('span', { className: 'opui-mono' }, a.runId.slice(0, 8) + '\u2026') : 'dispatching\u2026'),
              a.status ? h('span', null, ' \u00b7 ' + a.status) : null),
            (a.outputs || []).length ? h('div', { style: { marginTop: 3 } }, a.outputs.map((o, j) => h('div', { key: j, className: 'opui-mono', style: { opacity: 1, fontSize: 12 } }, o.length > 90 ? o.slice(0, 90) + '\u2026' : o))) : null)) : null,
          goal.checks ? stage('Verify', goal.checks.every((c) => c.pass) ? 'ok' : 'err',
            goal.checks.map((c, i) => h('div', { key: i }, (c.pass ? '\u2713 ' : '\u2717 ') + c.id))) : null,
          goal.failureCodes && goal.failureCodes.length ? stage('Failure', 'err',
            h('span', { className: 'opui-mono' }, goal.failureCodes.join(', ')),
            goal.error ? h('div', { className: 'opui-meta' }, goal.error) : null) : null,
          goal.taskId && gv !== 'PENDING' ? h('div', { style: { display: 'flex', gap: 10, marginTop: 8 } },
            h('button', { className: 'opui-copybtn', onClick: () => {
                setBusy(true);
                fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: goal.objective, retryOf: goal.taskId }) })
                  .then((r) => r.json()).then((d) => { if (d.goal) setGoal(d.goal); if (onDone) onDone(d.goal); }).catch(() => {}).finally(() => setBusy(false));
              } }, 'Retry (same task)'),
            h('button', { className: 'opui-copybtn', onClick: () => {
                setBusy(true);
                fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: goal.objective, forkOf: goal.taskId }) })
                  .then((r) => r.json()).then((d) => { if (d.goal) setGoal(d.goal); if (onDone) onDone(d.goal); }).catch(() => {}).finally(() => setBusy(false));
              } }, 'Fork as new task')) : null)) : null);
    };

    const fmtRunTime = (ts) => {
      try {
        const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
        return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    };

    // TeachingCard — capability ACQUISITION on one card (M2). Three identities
    // stay visible and separate: the source task (the gap), this teaching
    // task, and the candidate capability it may produce. Generation is never
    // success: the eval cases below are REAL Archon executions, and promotion
    // is always an explicit human click.
    const TeachingCard = ({ t, onRefresh }) => {
      const [busy, setBusy] = useState(false);
      if (!t) return null;
      const stage = (key, markerCls, body) => h('div', { key: key, className: 'opui-stage' },
        h('div', { className: 'opui-stage-marker ' + markerCls }),
        h('div', { className: 'opui-stage-key' }, key),
        h('div', { className: 'opui-stage-val' }, body));
      const cand = t.candidate || null;
      const evals = t.evaluations || [];
      const passed = evals.filter((e) => e.pass).length;
      const headCls = t.verdict === 'CANDIDATE' ? 'ok' : t.verdict === 'REFUSED' ? 'err' : 'run';
      const promote = () => {
        if (busy) return;
        setBusy(true);
        fetch('/plugins/operator-ui/teach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ promoteTaskId: t.taskId }) })
          .then((r) => r.json())
          .then(() => { if (onRefresh) onRefresh(); })
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      return h('div', { className: 'opui-result' },
        h('div', { className: 'opui-result-head ' + headCls },
          h('span', { className: 'opui-result-verdict' }, t.verdict || 'LEARNING'),
          h('span', { className: 'opui-meta' }, 'teaching task ' + t.taskId + (t.sourceTaskId ? ' \u00b7 gap from ' + t.sourceTaskId : ''))),
        h('div', { className: 'opui-spine', style: { marginTop: 8 } },
          t.gap ? stage('Gap', 'err',
            h('div', { className: 'opui-stage-title' }, t.gap.objective),
            h('div', { className: 'opui-meta', style: { marginTop: 2 } }, t.gap.reason + (t.gap.failureCodes && t.gap.failureCodes.length ? ' (' + t.gap.failureCodes.join(', ') + ')' : ''))) : null,
          cand ? stage('Build', 'ok',
            h('div', null,
              h('b', null, cand.capabilityId), h('span', { className: 'opui-mono' }, ' v' + cand.version), ' \u2192 ', h('span', { className: 'opui-mono' }, cand.workflow),
              h('div', { className: 'opui-meta', style: { marginTop: 2 } }, cand.provides),
              h('div', { className: 'opui-meta', style: { marginTop: 2 } }, 'Requires: ' + (cand.requires || []).join(', ') + ' \u00b7 declared BEFORE it can ever route'))) : null,
          evals.length ? stage('Evaluate', evals.every((e) => e.pass) ? 'ok' : 'err',
            evals.map((e) => h('div', { key: e.caseId },
              (e.pass ? '\u2713 ' : '\u2717 ') + e.caseId +
              (e.observed ? ' \u00b7 observed Lines: ' + e.observed.lines + ' Words: ' + e.observed.words + ' Bytes: ' + e.observed.bytes : ' \u00b7 no totals') +
              ' \u00b7 run ' + (e.runId || '').slice(0, 8))),
            h('div', { className: 'opui-meta', style: { marginTop: 3 } }, passed + '/' + evals.length + ' held-out cases on the real Archon')) : null,
          stage('Verdict', t.verdict === 'CANDIDATE' ? 'ok' : t.verdict === 'REFUSED' ? 'err' : 'run',
            t.verdict === 'CANDIDATE'
              ? h('div', null, 'Tested on ' + evals.length + ' cases — ' + passed + ' execution checks passed, ' + passed + ' capability validations passed, ' + passed + ' objective evaluations satisfied.')
              : t.verdict === 'REFUSED'
                ? h('div', null, h('b', null, 'Couldn\u2019t learn this reliably.'), h('span', { className: 'opui-meta' }, ' Candidate succeeded ' + passed + '/' + evals.length + ' evaluations. Not added to Intelligence.'))
                : h('div', null, 'Learning\u2026'))),
        t.verdict === 'CANDIDATE' && t.status === 'candidate' ? h('div', { style: { marginTop: 8 } },
          h('button', { className: 'opui-btn', onClick: promote, disabled: busy }, busy ? 'Promoting\u2026' : 'Promote to Intelligence')) : null,
        t.status === 'promoted' ? h('div', { className: 'opui-preview', style: { marginTop: 8 } },
          h('div', { className: 'opui-preview-head' }, 'RCOS learned this capability.'),
          h('div', { className: 'opui-preview-line' }, (cand ? cand.capabilityId + ' v' + cand.version + ' \u00b7 ' : '') + 'promoted by operator \u00b7 provenance sealed in the registry entry'),
          t.nextAction && t.nextAction.reason ? h('div', { className: 'opui-meta', style: { marginTop: 4 } }, t.nextAction.reason) : null) : null);
    };

    // Real output lines from node_completed events (the actual evidence a
    // person asks for: "what did it produce?").
    const extractNodeOutputs = (events) => {
      const outs = [];
      for (const e of events || []) {
        const d = e && e.data;
        const o = d && (typeof d.node_output === 'string' ? d.node_output : (typeof d.output === 'string' ? d.output : null));
        if (o && o.trim()) outs.push({ node: (e.step_name || 'node') + ':', out: o.trim() });
      }
      return outs;
    };

    // M1 shared: GET /goal returns durable ENVELOPES (verdict is
    // {decision, scope, failureCodes, error}; trust + nextAction ride along)
    // while POST /goal returns the live goal (verdict is a bare string).
    // Normalize once so every surface reads the same shape — never guess.
    const goalVerdict = (g) => {
      if (!g) return 'PENDING';
      const v = g.verdict;
      if (typeof v === 'string') return v;
      if (v && typeof v.decision === 'string') return v.decision;
      return 'PENDING';
    };
    const goalFailureCodes = (g) => {
      if (!g) return [];
      if (Array.isArray(g.failureCodes)) return g.failureCodes;
      if (g.verdict && Array.isArray(g.verdict.failureCodes)) return g.verdict.failureCodes;
      return [];
    };
    const goalError = (g) => {
      if (!g) return null;
      if (typeof g.error === 'string') return g.error;
      if (g.verdict && typeof g.verdict.error === 'string') return g.verdict.error;
      return null;
    };
    // Client-side mirror of the host ladder: rungs are cumulative and
    // positional, so a stored envelope without a trust field still reads
    // honestly from its own attempts + checks. The host is authoritative
    // when its trust field is present.
    const LADDER_RUNGS = ['Observed', 'Executed', 'Validated', 'Objective satisfied'];
    const deriveLadder = (goal) => {
      if (goal && goal.trust && typeof goal.trust.index === 'number') return goal.trust;
      const attempts = (goal && goal.attempts) || [];
      const last = attempts[attempts.length - 1] || null;
      const checks = (goal && goal.checks) || [];
      const pass = (id) => checks.some((c) => c.id === id && c.pass);
      let index = 0;
      if (last && typeof last.status === 'string' && !['running', 'queued', 'pending'].includes(last.status)) index = 1;
      if (index >= 1 && pass('terminal-status') && (!checks.some((c) => c.id === 'declared-expectation') || pass('declared-expectation'))) index = 2;
      if (index >= 2 && pass('objective-satisfaction')) index = 3;
      const truth = [null, 'execution', 'capability validation', 'objective evaluation'][index];
      return { rungs: LADDER_RUNGS, index, label: LADDER_RUNGS[index], truth };
    };
    // Next Action labels when the host gave none (older envelopes): derived
    // from verdict + failure codes only. Never auto-executes — the UI maps
    // each kind onto an affordance that already exists.
    const NEXT_ACTION_LABEL = {
      wait: 'Wait for the run', ship: 'Ship it', inspect: 'Inspect the task',
      retry: 'Retry (same task)', fork: 'Fork as new task', refine: 'Refine the objective',
      configure: 'Configure the registry', teach: 'Teach RCOS', approve: 'Approve plan',
    };
    // Client mirror of the host's humanScope/humanPreset (lib/authority.js):
    // one vocabulary, two tenses — Preview says "RCOS plans to Read files",
    // Prove says "RCOS did", same words. Kept in sync by check.js.
    const HUMAN_SCOPE = {
      'filesystem:read': 'Read files',
      'filesystem:write': 'Modify files',
      'shell:execute': 'Run commands',
      'network:outbound': 'Reach the network',
      'browser:read': 'Read browser pages',
      'browser:interact': 'Drive browser pages',
      'credentials:use': 'Use named credentials',
      'git:read': 'Read repositories',
      'git:modify': 'Modify repositories',
      'git:push': 'Push to remotes',
      'external:draft': 'Draft external actions',
      'external:submit': 'Submit external actions',
    };
    const PRESET_LABEL = {
      PLAN_ONLY: 'Plan only',
      ASK_BEFORE_ACTION: 'Ask before acting',
      AUTO_WITHIN_POLICY: 'Auto within policy',
      FULL_ACCESS: 'Full access',
    };
    const deriveNextKind = (goal) => {
      if (goal && goal.nextAction && goal.nextAction.kind) return goal.nextAction.kind;
      const v = goalVerdict(goal);
      const codes = new Set(goalFailureCodes(goal));
      if (codes.has('awaiting-approval')) return 'approve';
      if (v === 'PENDING' || !v) return 'wait';
      if (v === 'SHIP') return 'ship';
      if (codes.has('objective-required')) return 'refine';
      if (codes.has('registry-not-configured')) return 'configure';
      if (codes.has('no-route')) return 'teach';
      if (codes.has('run-not-found') || codes.has('run-failed')) return 'retry';
      if (codes.has('objective-not-satisfied')) return 'fork';
      return 'inspect';
    };
    const deriveNextReason = (goal) => {
      if (goal && goal.nextAction && goal.nextAction.reason) return goal.nextAction.reason;
      const v = goalVerdict(goal);
      const codes = goalFailureCodes(goal);
      if (v === 'PENDING') return 'the goal has not reached a verdict yet';
      if (v === 'SHIP') return codes.length ? 'shipped with advisory codes: ' + codes.join(', ') : 'all three checks passed';
      if (v === 'BLOCK') return 'completed but the evidence did not satisfy the gate — open the spine before acting';
      return 'verdict ' + v + (codes.length ? ' \u00b7 ' + codes.join(', ') : '') + ' — open the spine before acting';
    };
    // Fault isolation (P0): a bug in ONE card/surface kills that card/surface,
    // never the shell. The boundary renders a small killed-card fallback and
    // never rethrows — shell.overlay stays mounted no matter what a surface
    // throws (the React #185 abdication class, now contained).
    class CardBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      componentDidCatch() { /* contained: the card dies, the shell lives */ }
      render() {
        if (this.state.err) {
          const msg = String((this.state.err && this.state.err.message) || this.state.err).slice(0, 160);
          return h('div', { className: 'opui-card-dead' },
            h('strong', null, (this.props.label || 'This card') + ' hit a bug'),
            h('div', { className: 'opui-meta' }, msg));
        }
        return this.props.children;
      }
    }

    // Result Card: what happened, on one card, above the spine (how).
    // Headline verdict first, then the ladder strip, then Next Action.
    // Permissions round: the SAME authority block renders in two tenses —
    // Preview ("RCOS plans to …" + Approve plan) when a task awaits approval,
    // Prove (authority line) after execution. Never a new tab.
    const ResultCard = ({ goal, onApproved, onTeach }) => {
      const [busy, setBusy] = useState(false);
      if (!goal) return null;
      const v = goalVerdict(goal);
      const ladder = deriveLadder(goal);
      const kind = deriveNextKind(goal);
      const reason = deriveNextReason(goal);
      const label = (goal.nextAction && goal.nextAction.label) || NEXT_ACTION_LABEL[kind] || kind;
      const err = goalError(goal);
      const au = goal.authority || null;
      const headCls = v === 'SHIP' ? 'ok' : v === 'BLOCK' || v === 'FAILED' ? 'err' : v === 'PENDING' ? 'run' : 'dim';
      const rungEls = (ladder.rungs || LADDER_RUNGS).map((name, i) =>
        h('span', { key: name, className: 'opui-ladder-rung' + (i <= ladder.index ? ' lit' : '') },
          h('span', { className: 'opui-ladder-dot' + (i <= ladder.index ? ' lit' : '') }),
          h('span', { className: 'opui-ladder-name' }, name)));
      // ACT: approval resumes the SAME task (approveTaskId) — nothing is
      // dispatched until the operator presses it, and the host re-checks the
      // stored envelope is genuinely awaiting approval before executing.
      const approve = () => {
        if (busy || !goal.taskId) return;
        setBusy(true);
        fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approveTaskId: goal.taskId }) })
          .then((r) => r.json())
          .then((d) => { if (d.ok && d.goal && onApproved) onApproved(d.goal); })
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      // PREVIEW — "RCOS plans to …": one line per required scope, honest
      // about what is pre-authorized vs what needs THIS approval.
      const preview = kind === 'approve' && au ? h('div', { className: 'opui-preview' },
        h('div', { className: 'opui-preview-head' }, 'RCOS plans to:'),
        (au.requires || []).length
          ? au.requires.map((s) => h('div', { key: s, className: 'opui-preview-line' },
              h('span', null, HUMAN_SCOPE[s] || s),
              (au.granted || []).includes(s)
                ? h('span', { className: 'opui-preview-ok' }, ' \u2713 pre-authorized')
                : h('span', { className: 'opui-preview-need' }, ' \u2014 approval required')))
          : h('div', { className: 'opui-preview-line' }, h('span', null, 'Execute the capability'),
              h('span', { className: 'opui-preview-need' }, ' \u2014 approval required')),
        au.reason ? h('div', { className: 'opui-meta', style: { marginTop: 4 } }, au.reason) : null,
        goal.taskId ? h('div', { style: { marginTop: 8 } },
          h('button', { className: 'opui-btn', onClick: approve, disabled: busy }, busy ? 'Dispatching\u2026' : 'Approve plan')) : null) : null;
      // PROVE — the authority the task ran under, in the same words.
      const prove = au && kind !== 'approve' ? h('div', { className: 'opui-meta', style: { marginTop: 4 } },
        'Authority: ' + (PRESET_LABEL[au.preset] || au.preset) +
        (au.approvedAt ? ' \u00b7 approved ' + fmtRunTime(au.approvedAt) : '')) : null;
      return h('div', { className: 'opui-result' },
        h('div', { className: 'opui-result-head ' + headCls },
          h('span', { className: 'opui-result-verdict' }, v),
          h('span', { className: 'opui-meta' }, ladder.label + (ladder.truth ? ' \u00b7 ' + ladder.truth : ''))),
        h('div', { className: 'opui-ladder' }, rungEls),
        preview || null,
        prove,
        h('div', { className: 'opui-result-next' },
          h('span', { className: 'opui-meta' }, 'Next: '),
          h('strong', null, label),
          h('span', { className: 'opui-meta' }, ' — ' + reason),
          // Teach RCOS: a GAP is a real action, not a dead end. Offered when
          // routing found nothing or the capability ran but missed the
          // objective — the two honest gaps in M2.
          onTeach && (kind === 'teach' || goalFailureCodes(goal).includes('objective-not-satisfied')) ? h('span', null,
            h('span', { className: 'opui-meta' }, ' · '),
            h('button', { className: 'opui-copybtn', onClick: onTeach, disabled: busy }, 'Teach RCOS')) : null),
        err ? h('div', { className: 'opui-result-err' }, err) : null);
    };

    const SpineCard = ({ selItem, runObj, events, reg, st, isArchon, onEvidence, onRetry, onFork }) => {
      const outputs = isArchon ? extractNodeOutputs(events) : [];
      const artifactLine = runObj && runObj.receipt && runObj.receipt.artifacts && runObj.receipt.artifacts.length
        ? runObj.receipt.artifacts.join(', ') : null;
      const cap = runObj && reg && Array.isArray(reg.capabilities)
        ? reg.capabilities.find((c) => c.workflow === runObj.workflow_name) || null : null;
      const elig = cap ? deriveEligibility(cap, st) : null;
      const adapterV = st && st.components && st.components.archon && st.components.archon.detail ? st.components.archon.detail.serviceVersion : null;
      const [copiedId, setCopiedId] = useState('');
      const copyText = (s) => {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s).catch(() => {}); return; } } catch {}
        try {
          const ta = document.createElement('textarea');
          ta.value = s; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch {}
      };
      const stage = (key, markerCls, body) => h('div', { key: key, className: 'opui-stage' },
        h('div', { className: 'opui-stage-marker ' + markerCls }),
        h('div', { className: 'opui-stage-key' }, key),
        h('div', { className: 'opui-stage-val' }, body));
      const stages = [];
      stages.push(stage('Request', 'dim', h('div', { className: 'opui-stage-title' }, selItem ? selItem.title : '\u2014')));
      if (!isArchon) {
        stages.push(stage('Route', 'dim', h('span', { className: 'opui-meta' }, 'DSH session task \u2014 routing spine lands in a later milestone')));
        stages.push(stage('Verdict', 'dim', h('span', { className: 'opui-meta' }, '\u2014')));
      } else {
        // ROUTE — decomposed: what was chosen and why (first question).
        stages.push(stage('Route', elig && elig.decision === 'ELIGIBLE' ? 'ok' : elig && elig.decision === 'INELIGIBLE' ? 'err' : 'run',
          h('div', null,
            h('div', null,
              h('b', null, cap ? cap.id : 'bare workflow'),
              cap ? h('span', { className: 'opui-mono' }, ' v' + (cap.version || '?')) : null,
              ' \u2192 ',
              h('span', { className: 'opui-mono' }, runObj ? runObj.workflow_name : '')),
            cap && cap.seed === true ? h('div', { className: 'opui-meta', style: { marginTop: 2 } }, 'SEEDED system-verification capability') : null,
            elig ? h('div', { className: 'opui-elig', style: { marginTop: 3 } },
              h('span', { className: 'opui-chip ' + (elig.decision === 'ELIGIBLE' ? 'ok' : elig.decision === 'INELIGIBLE' ? 'att' : 'mut') }, elig.decision),
              h('span', { className: 'why' }, ' ' + elig.reasons.join(' \u00b7 '))) : null)));
        // EXECUTION — result prominent, id demoted to copyable metadata.
        const done = runObj && runObj.status === 'completed';
        const failed = runObj && runObj.status === 'failed';
        stages.push(stage('Execution', runObj ? (failed ? 'err' : done ? 'ok' : 'run') : 'dim',
          h('div', null,
            h('div', null,
              h('b', null, 'Archon'),
              adapterV ? h('span', { className: 'opui-mono' }, ' @' + adapterV) : null,
              ' \u00b7 ',
              runObj ? String(runObj.status || '?') : '\u2026'),
            runObj && runObj.id ? h('div', { style: { marginTop: 2 } },
              h('span', { className: 'opui-mono' }, runObj.id.slice(0, 8) + '\u2026'),
              h('button', { className: 'opui-copybtn', title: 'copy run id', onClick: () => copyText(runObj.id) }, copiedId === runObj.id.slice(0, 8) ? '\u2713 copied' : 'copy')) : null)));
        // EVIDENCE — output dominates; events are provenance.
        stages.push(stage('Evidence', outputs.length ? 'ok' : 'dim',
          h('div', null,
            outputs.length
              ? outputs.map((o, i) => h('div', { key: i, style: { marginBottom: 3 } },
                  h('span', { className: 'opui-meta' }, o.node + ' '),
                  h('span', { className: 'opui-mono', style: { opacity: 1, fontSize: 12 } }, o.out.length > 100 ? o.out.slice(0, 100) + '\u2026' : o.out)))
              : h('span', { className: 'opui-meta' }, 'no output recorded'),
            artifactLine ? h('div', { className: 'opui-meta', style: { marginTop: 4 } }, 'artifacts: ' + artifactLine) : null,
            events && events.length ? h('div', { className: 'opui-meta', style: { marginTop: 4 } }, events.length + ' node events') : null)));
        // VERDICT — semantic chips; execution success ≠ evaluation.
        // The durable goal envelope is authoritative when attached (a real
        // Archon run carries no receipt of its own); the run receipt is only
        // a fallback for bare/legacy runs without an envelope.
        const envGoal = selItem && selItem.goal ? selItem.goal : null;
        const envChecks = (envGoal && Array.isArray(envGoal.checks)) ? envGoal.checks : [];
        const envPass = (id) => envChecks.some((c) => c.id === id && c.pass);
        const envHas = (id) => envChecks.some((c) => c.id === id);
        const capFromEnv = envChecks.length
          ? (envPass('terminal-status') && (!envHas('declared-expectation') || envPass('declared-expectation')))
          : null;
        const vChip = runObj && runObj.receipt && runObj.receipt.decision
          ? h('span', { className: 'opui-chip ' + (runObj.receipt.decision === 'ship' ? 'ok' : runObj.receipt.decision === 'blocked' ? 'att' : 'run') }, runObj.receipt.decision.toUpperCase())
          : null;
        stages.push(stage('Verdict', runObj && runObj.receipt && runObj.receipt.decision === 'ship' ? 'ok' : runObj && runObj.receipt && runObj.receipt.decision === 'blocked' ? 'err' : runObj && runObj.status === 'failed' ? 'err' : 'dim',
          h('div', null,
            h('div', null, h('b', null, 'Execution: '), runObj ? String(runObj.status || '?') : '\u2026', done ? ' \u2713' : failed ? ' \u2717' : ''),
            h('div', { style: { marginTop: 3 } }, h('b', null, 'Capability validation: '), capFromEnv === true ? h('span', null, 'passed ', vChip) : runObj && runObj.receipt && runObj.receipt.decision ? h('span', null, 'passed ', vChip) : h('span', { className: 'opui-meta' }, capFromEnv === false ? 'not satisfied — see objective evaluation' : 'not evaluated')),
            h('div', { style: { marginTop: 3 } }, h('b', null, 'Objective evaluation: '),
              selItem && selItem.goal && selItem.goal.objectiveEvaluation
                ? h('span', null, selItem.goal.objectiveEvaluation.pass ? 'satisfied' : 'not satisfied',
                    h('span', { className: 'opui-meta' }, ' — ' + (selItem.goal.objectiveEvaluation.detail || '')))
                : h('span', { className: 'opui-meta' }, 'not evaluated — refusal or legacy run')),
            runObj && runObj.receipt && runObj.receipt.summary ? h('div', { className: 'opui-meta', style: { marginTop: 4 } }, runObj.receipt.summary) : null)));
      }
      const retryFork = selItem && selItem.taskId && (onRetry || onFork) ? h('div', { style: { display: 'flex', gap: 10, marginBottom: 8 } },
        onRetry ? h('button', { className: 'opui-copybtn', onClick: () => onRetry(selItem.taskId) }, 'Retry (same task)') : null,
        onFork ? h('button', { className: 'opui-copybtn', onClick: () => onFork(selItem.taskId) }, 'Fork as new task') : null) : null;
      return h('div', { className: 'opui-sum-card', style: { flex: 1, minWidth: 0 } },
        retryFork,
        selItem && selItem.goal ? h(CardBoundary, { label: 'Result card' }, h(ResultCard, { goal: selItem.goal })) : null,
        h('div', { className: 'opui-spine' }, stages),
        isArchon && runObj ? h('div', { style: { marginTop: 10 } },
          h('button', { className: 'opui-copybtn', onClick: () => onEvidence && onEvidence({
              title: 'Run ' + (runObj.id || '').slice(0, 8),
              claim: 'Execution ' + (runObj.status || '?') + (runObj.receipt && runObj.receipt.decision ? ' \u00b7 capability ' + runObj.receipt.decision.toUpperCase() : ''),
              supportedBy: [
                ['Terminal status', String(runObj.status || 'unknown')],
                ['Capability validation', capFromEnv === true ? 'passed' : capFromEnv === false ? 'not satisfied' : (runObj.receipt && runObj.receipt.decision ? runObj.receipt.decision : 'not evaluated')],
                ['Route', (selItem && selItem.sub) ? selItem.sub : (runObj.workflow_name || '')],
              ],
              executionRows: [
                ['Adapter', (st && st.components && st.components.archon && st.components.archon.detail && st.components.archon.detail.serviceVersion) ? 'archon@' + st.components.archon.detail.serviceVersion : 'archon'],
                ['Run id', runObj.id || '\u2014'],
              ],
              outputRows: outputs.map((o) => o.node + ': ' + o.out),
              provenanceRows: [
                ['Registry', (st && st.components && st.components.rcos && st.components.rcos.detail) ? (st.components.rcos.detail.path || '') : ''],
                ['Seed workflow', (st && st.components && st.components.rcos) ? 'declared expectation: capability verification entry' : ''],
              ].filter((r) => r[1]),
            }) }, 'evidence \u2192')) : null);
    };

    const TaskRow = ({ t, sel, onOpen }) => h('div', { className: 'opui-work-row' + (t.key === sel ? ' sel' : '') + (t.sys ? ' sys' : ''), onClick: () => onOpen(t.key) },
      h('span', { className: 'opui-dot ' + (t.verdict === 'ship' ? 'done' : t.verdict === 'blocked' ? 'attention' : t.status === 'failed' ? 'attention' : t.status === 'completed' ? 'done' : t.status === 'running' ? 'running' : 'idle') }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { className: 'opui-work-title' }, t.title),
        h('div', { className: 'opui-meta' }, [t.sub, t.at].filter(Boolean).join(' \u00b7 '))),
      t.verdict ? h('span', { className: 'opui-chip ' + (t.verdict === 'ship' ? 'good' : t.verdict === 'blocked' ? 'att' : 'run') }, t.verdict) : null);


    const WorkSurface = ({ __opuiCtx: ctx }) => {
      const [runs, setRuns] = useState(null);
      const [sel, setSel] = useState(null);      // selected task key
      const [detail, setDetail] = useState(null); // run detail for archon tasks
      const [reg, setReg] = useState(null);      // registry for route lookup
      const [st, setSt] = useState(null);
      const list = useSyncExternalStore(
        ctx.sessions.list.subscribe.bind(ctx.sessions.list),
        () => ctx.sessions.list.getSnapshot());
      const [goalRows, setGoalRows] = useState([]); // durable goals that never reached execution (refusals, awaiting approval)
      const [teachingRows, setTeachingRows] = useState([]);
      const [teachBusy, setTeachBusy] = useState(false);
      const loadBoards = () => {
        setRuns(null);
        fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((dd) => { if (dd.ok) setRuns(dd.runs || []); }).catch(() => {});
        fetch('/plugins/operator-ui/goal').then((r) => r.json()).then((d) => {
          if (!d.ok) return;
          setGoalRows((d.goals || []).filter((g) => (goalVerdict(g) === 'FAILED' || goalFailureCodes(g).includes('awaiting-approval')) && !(g.attempts || []).some((a) => a.runId)));
        }).catch(() => {});
        fetch('/plugins/operator-ui/teach').then((r) => r.json()).then((d) => { if (d.ok) setTeachingRows(d.teaching || []); }).catch(() => {});
      };
      // Teach RCOS from a gap: opens a separate teaching task (the source
      // task is never mutated into a capability).
      const teachFrom = (sourceTaskId) => {
        if (teachBusy) return;
        setTeachBusy(true);
        setSel('teach:' + sourceTaskId);
        fetch('/plugins/operator-ui/teach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId }) })
          .then((r) => r.json())
          .then((d) => { loadBoards(); if (d.ok && d.teaching) setSel('teach:' + d.teaching.taskId); })
          .catch(() => loadBoards())
          .finally(() => setTeachBusy(false));
      };
      // WorkSurface-local resubmit: POST retry/fork against the live goal, then
      // refresh the same sources openTask/loadRoots read — no dead references.
      const resubmitGoal = (g, extra) => {
        fetch('/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: g.objective, ...extra }) })
          .then((r) => r.json())
          .then((d) => {
            if (!(d.ok && d.goal)) return;
            const done = d.goal;
            setGoalRows((rows) => {
              const rest = rows.filter((r) => r.taskId !== g.taskId);
              return goalVerdict(done) === 'FAILED' && !(done.attempts || []).some((a) => a.runId) ? [...rest, done] : rest;
            });
            setSel(done.taskId && !(done.attempts || []).some((a) => a.runId) ? 'goal:' + done.taskId : sel);
            setRuns(null);
            fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((dd) => { if (dd.ok) setRuns(dd.runs || []); }).catch(() => {});
          }).catch(() => {});
      };
      // Post-approval refresh only — the Result Card performed the one and
      // only approveTaskId POST; this re-reads the boards (the task now has a
      // runId and leaves the refusal section for the run list above).
      const approveGoal = () => {
        setRuns(null);
        fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((dd) => { if (dd.ok) setRuns(dd.runs || []); }).catch(() => {});
        fetch('/plugins/operator-ui/goal').then((r) => r.json()).then((d) => {
          if (!d.ok) return;
          setGoalRows((d.goals || []).filter((g) => (goalVerdict(g) === 'FAILED' || goalFailureCodes(g).includes('awaiting-approval')) && !(g.attempts || []).some((a) => a.runId)));
        }).catch(() => {});
      };
      useEffect(() => {
        fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((d) => { if (d.ok) setRuns(d.runs || []); else setRuns([]); }).catch(() => setRuns([]));
        fetch('/plugins/operator-ui/rcos').then((r) => r.json()).then((d) => { if (d.ok) setReg(d.registry); }).catch(() => {});
        fetch('/plugins/operator-ui/status').then((r) => r.json()).then(setSt).catch(() => {});
        fetch('/plugins/operator-ui/goal').then((r) => r.json()).then((d) => {
          if (!d.ok) return;
          const executed = new Set((d.goals || []).flatMap((g) => (g.attempts || []).filter((a) => a.runId).map((a) => a.runId)));
          setGoalRows((d.goals || []).filter((g) => (goalVerdict(g) === 'FAILED' || goalFailureCodes(g).includes('awaiting-approval')) && !(g.attempts || []).some((a) => a.runId)));
        }).catch(() => {});
        fetch('/plugins/operator-ui/teach').then((r) => r.json()).then((d) => { if (d.ok) setTeachingRows(d.teaching || []); }).catch(() => {});
      }, []);
      const openTask = (key) => {
        setSel(key);
        setDetail(null);
        if (key && key.startsWith('archon:')) {
          const id = key.slice(7);
          fetch('/plugins/operator-ui/archon?op=run&id=' + encodeURIComponent(id))
            .then((r) => r.json()).then((d) => setDetail(d)).catch(() => setDetail({ ok: false, error: 'run detail unavailable' }));
        }
      };
      const runsReady = runs !== null;
      const seededWf = new Set((reg && Array.isArray(reg.capabilities) ? reg.capabilities : []).filter((c) => c.seed === true).map((c) => c.workflow));
      const items = [];
      for (const r of runs || []) items.push({ key: 'archon:' + r.id, src: 'archon', title: r.user_message || r.workflow_name, sub: r.workflow_name, at: fmtRunTime(r.started_at), status: r.status, verdict: r.receipt && r.receipt.decision, sys: seededWf.has(r.workflow_name) });
      for (const g of goalRows) {
        const awaiting = goalFailureCodes(g).includes('awaiting-approval');
        items.push({ key: 'goal:' + g.taskId, src: 'goal', title: g.objective, sub: awaiting ? 'goal \u00b7 awaiting your approval' : 'goal \u00b7 refused before execution', at: fmtRunTime(g.createdAt), status: awaiting ? 'awaiting-approval' : 'failed', verdict: awaiting ? null : 'failed', goal: g });
      }
      for (const t of teachingRows) {
        items.push({ key: 'teach:' + t.taskId, src: 'teaching', title: 'Teach RCOS: ' + ((t.gap && t.gap.objective) || t.sourceTaskId), sub: 'teaching \u00b7 ' + (t.verdict === 'CANDIDATE' ? 'candidate ready' : t.status === 'promoted' ? 'learned + promoted' : t.status), at: fmtRunTime(t.createdAt), status: t.status, verdict: t.verdict, teach: t });
      }
      const sessions = (list && list.order && list.byId) ? list.order.map((id) => list.byId[id]).filter(Boolean) : [];
      for (const s of sessions) items.push({ key: 'dsh:' + (s.id || s.sessionId), src: 'dsh', title: String(s.title || s.cwd || 'session').slice(0, 90), sub: s.cwd || '', at: null, status: null, verdict: null, sys: false });
      const selItem = items.find((t) => t.key === sel) || null;
      const d = detail && detail.ok ? (detail.run ? detail : { run: detail, events: [] }) : null;
      const runObj = d ? d.run : null;
      const selGoal = sel && sel.startsWith('goal:') ? (goalRows.find((g) => g.taskId === sel.slice(5)) || null) : null;
      const [evd, setEvd] = useState(null);
      const userTasks = items.filter((t) => !t.sys);
      const sysTasks = items.filter((t) => t.sys);
      const [showSys, setShowSys] = useState(false);

      return h('div', { className: 'opui-sum' },
        h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 10px' } },
          h('h2', null, 'Work'),
          h('span', { className: 'opui-hint' }, 'Follow a task from request to verdict.'),
          h('span', { className: 'opui-spacer' }),
          h('button', { className: 'opui-btn', onClick: () => openTask(sel) }, 'Refresh')),
        h(GoalComposer, { onDone: () => { setRuns(null); fetch('/plugins/operator-ui/archon?op=runs&limit=20').then((r) => r.json()).then((d) => { if (d.ok) setRuns(d.runs || []); }).catch(() => {}); }, onTeach: teachFrom }),
        teachBusy ? h('div', { className: 'opui-meta', style: { margin: '6px 0' } }, 'Learning\u2026 building a candidate and evaluating it on the real Archon (this takes ~30\u201360s).') : null,
        !runsReady ? h('div', { className: 'opui-none' }, 'Reading tasks\u2026')
          : items.length === 0 ? h('div', { className: 'opui-none' }, 'No tasks yet — give RCOS work and it appears here.')
          : h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start' } },
              h('div', { className: 'opui-work-list', style: { flex: '0 0 32%' } },
                userTasks.map((t) => h(TaskRow, { key: t.key, t, sel, onOpen: openTask })),
                sysTasks.length ? h('div', null,
                  h('button', { className: 'opui-sys-toggle', onClick: () => setShowSys(!showSys) },
                    (showSys ? '\u25be ' : '\u25b8 ') + 'System activity (' + sysTasks.length + ')'),
                  showSys ? sysTasks.map((t) => h(TaskRow, { key: t.key, t, sel, onOpen: openTask })) : null) : null),
              selItem && selItem.src === 'goal' ? (() => {
                const g = selItem.goal;
                const gCodes = goalFailureCodes(g);
                const resubmit = (extra) => resubmitGoal(g, extra);
                return h('div', { className: 'opui-sum-card', style: { flex: 1 } },
                  h('h4', null, 'Task spine'),
                  h(CardBoundary, { label: 'Result card' }, h(ResultCard, { goal: g, onApproved: (ng) => {
                    const rid = ng && ng.attempts && ng.attempts.length ? (ng.attempts[ng.attempts.length - 1].runId || null) : null;
                    approveGoal();
                    if (rid) openTask('archon:' + rid);
                  }, onTeach: () => teachFrom(g.taskId) })),                  h('div', { className: 'opui-spine' }, [
                    ['Request', g.objective],
                    ['Route', (g.route && g.route.reason) || '\u2014'],
                    ['Execution', goalFailureCodes(g).includes('awaiting-approval') ? 'awaiting your approval — nothing dispatched yet' : '\u2014 (refused before execution)'],
                    ['Evidence', '\u2014'],
                    ['Verdict', goalVerdict(g) + (gCodes.length ? ' \u00b7 ' + gCodes.join(', ') : '')],
                  ].map(([k, v]) => h('div', { key: k, className: 'opui-spine-row' },
                    h('div', { className: 'opui-spine-key' }, k),
                    h('div', { className: 'opui-spine-val' }, String(v))))),
                  goalError(g) ? h('div', { className: 'opui-meta', style: { marginTop: 6 } }, goalError(g)) : null,
                  !goalFailureCodes(g).includes('awaiting-approval') ? h('div', { style: { display: 'flex', gap: 10, marginTop: 8 } },
                    h('button', { className: 'opui-copybtn', onClick: () => resubmit({ retryOf: g.taskId }) }, 'Retry (same task)'),
                    h('button', { className: 'opui-copybtn', onClick: () => resubmit({ forkOf: g.taskId }) }, 'Fork as new task')) : null);
              })()
              : selItem && selItem.src === 'teaching' ? h('div', { className: 'opui-sum-card', style: { flex: 1 } },
                  h('h4', null, 'Teaching spine'),
                  h(CardBoundary, { label: 'Teaching card' }, h(TeachingCard, { t: selItem.teach, onRefresh: loadBoards })))
              : selItem ? h(CardBoundary, { label: 'Task spine' }, h(SpineCard, {
                selItem,
                runObj: selItem.src === 'archon' ? runObj : null,
                events: selItem.src === 'archon' && d ? d.events : null,
                reg, st,
                isArchon: selItem.src === 'archon',
                onEvidence: setEvd,
                onRetry: (tid) => { const g = goalRows.find((r) => r.taskId === tid); if (g) resubmitGoal(g, { retryOf: tid }); },
                onFork: (tid) => { const g = goalRows.find((r) => r.taskId === tid); if (g) resubmitGoal(g, { forkOf: tid }); },
              })) : h('div', { className: 'opui-sum-card', style: { flex: 1 } }, h('h4', null, 'Task spine'), h('div', { className: 'opui-meta' }, 'Select a task to follow it end to end.')),
              evd ? h(EvidenceDrawer, { ...evd, onClose: () => setEvd(null) }) : null));
    };

    // ---------------------------------------------------- INTELLIGENCE v0
    // Capabilities are the primary abstraction; workflows are inspectable
    // beneath them. Lifecycle state and derived routingEligibility (with
    // reasons) are shown SEPARATELY.

    const ELIG_CHIP = { ELIGIBLE: 'ok', CONDITIONAL: 'run', INELIGIBLE: 'att', UNKNOWN: '' };
    const humanName = (id) => {
      const t = String(id || '').replace(/[-_]+/g, ' ').trim();
      return t ? t[0].toUpperCase() + t.slice(1) : '';
    };

    const IntelligenceSurface = () => {
      const { st } = useReceiptGate();
      const [reg, setReg] = useState(null);
      const [catalog, setCatalog] = useState([]);
      const [hist, setHist] = useState(null);
      const [err, setErr] = useState(null);
      const [filter, setFilter] = useState('');       // '' | ELIGIBLE | CONDITIONAL | INELIGIBLE | UNKNOWN
      const [showSeeded, setShowSeeded] = useState(false);
      useEffect(() => {
        fetch('/plugins/operator-ui/rcos').then((r) => r.json()).then((d) => { if (d.ok) setReg(d.registry); else setErr(d.error); }).catch(() => setErr('registry unavailable'));
        fetch('/plugins/operator-ui/archon?op=catalog').then((r) => r.json()).then((d) => { if (d.ok) setCatalog(d.workflows || []); }).catch(() => {});
        fetch('/plugins/operator-ui/rcos?op=history').then((r) => r.json()).then((d) => { if (d.ok) setHist(d.capabilities || {}); }).catch(() => {});
      }, []);
      const caps = reg && Array.isArray(reg.capabilities) ? reg.capabilities : [];
      const rows = caps.map((c) => {
        const e = deriveEligibility(c, st);
        const h = hist ? hist[c.id] : null;
        const histLine = h && h.uses
          ? h.uses + ' use' + (h.uses === 1 ? '' : 's') + ' \u00b7 ' + h.objectivesSatisfied + ' objective' + (h.objectivesSatisfied === 1 ? '' : 's') + ' satisfied \u00b7 ' + (h.lastVerifiedAt ? 'last verified ' + new Date(h.lastVerifiedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'never SHIP-verified')
          : null;
        // Decay (M2.5): the recent record, named — never a confidence score.
        const decayLine = h && h.needsReevaluation
          ? 'Needs re-evaluation \u2014 ' + h.decayReason
          : null;
        const lineage = c.provenance && c.provenance.teachingTaskId
          ? 'learned via ' + c.provenance.teachingTaskId + (c.provenance.sourceTaskId ? ' from ' + c.provenance.sourceTaskId : '')
          : null;
        const lifecycleLine = [
          c.status === 'promoted' ? 'Promoted' : c.status === 'candidate' ? 'Candidate' : c.status === 'retired' ? 'Retired' : c.status === 'seeded' ? 'Seeded' : (c.status || 'Unknown'),
          (c.evals || []).length ? (c.evals.length + (c.evals.length === 1 ? ' eval' : ' evals')) : null,
          c.reuse_count ? 'reused ' + c.reuse_count + '\u00d7' : 'never reused',
          lineage,
        ].filter(Boolean).join(' \u00b7 ');
        return { c, e, lifecycleLine, histLine, decayLine };
      });
      const counts = { ELIGIBLE: 0, CONDITIONAL: 0, INELIGIBLE: 0, UNKNOWN: 0 };
      rows.forEach((r) => { counts[r.e.decision]++; });
      const userRows = rows.filter((r) => r.c.seed !== true);
      const seededRows = rows.filter((r) => r.c.seed === true);
      const shown = filter ? userRows.filter((r) => r.e.decision === filter) : userRows;
      const servedBy = (c) => catalog.some((w) => w.name === c.workflow);
      const capCard = ({ c, e, lifecycleLine, histLine, decayLine }) => h('div', { key: c.id, className: 'opui-sum-card' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          h('span', { className: 'opui-stage-title' }, humanName(c.id)),
          h('span', { className: 'opui-chip ' + (ELIG_CHIP[e.decision] || ''), style: { fontWeight: 600 } }, e.decision)),
        h('div', { className: 'opui-meta', style: { marginTop: 2 } }, lifecycleLine),
        h('div', { style: { marginTop: 8, fontSize: 13 } },
          e.decision === 'ELIGIBLE' ? h('b', null, 'Ready for routing') : e.decision === 'CONDITIONAL' ? h('b', null, 'Needs more evidence') : e.decision === 'INELIGIBLE' ? h('b', null, 'Not routable now') : h('b', null, 'Eligibility unknown')),
        e.reasons.length ? h('div', { className: 'opui-meta', style: { marginTop: 3 } },
          e.reasons.join(' \u00b7 ')) : null,
        decayLine ? h('div', { className: 'opui-preview-need', style: { marginTop: 6, fontSize: 12 } },
          h('b', null, decayLine)) : null,
        histLine ? h('div', { className: 'opui-meta', style: { marginTop: 6 } }, histLine) : null,
        c.workflow ? h('div', { className: 'opui-mono', style: { marginTop: 8 } },
          '\u2192 ' + c.workflow + (servedBy(c) ? ' \u00b7 Archon' : '')) : null);
      return h('div', { className: 'opui-sum' },
        h('div', { className: 'opui-head', style: { border: 'none', padding: '0 0 4px' } },
          h('h2', null, 'Intelligence'),
          h('span', { className: 'opui-hint' }, 'Installed executable capabilities.')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 } },
          h('span', { className: 'opui-chip run', style: { fontWeight: 600 } }, 'Routing now'),
          ['ELIGIBLE', 'CONDITIONAL', 'INELIGIBLE', 'UNKNOWN'].map((k) => h('span', {
            key: k,
            className: 'opui-chip ' + (ELIG_CHIP[k] || '') + (filter === k ? ' sel' : ''),
            style: { cursor: 'pointer', fontWeight: filter === k ? 600 : 400 },
            onClick: () => setFilter(filter === k ? '' : k),
          }, counts[k] + ' ' + k)),
          h('span', { style: { flex: 1 } }),
          reg ? h('span', { className: 'opui-mono' }, 'registry ' + (reg.registry_version || 'v?')) : null),
        h('div', { className: 'opui-sub', style: { marginBottom: 12 } },
          'Lifecycle is what each capability IS. \u201cRouting now\u201d is what the router may use in this installation, with reasons.'),
        err ? h('div', { className: 'opui-none' }, err)
          : caps.length === 0 ? h('div', { className: 'opui-none' }, 'No capabilities installed — add intelligence to give RCOS more to do.')
          : h('div', null,
              shown.length === 0 ? h('div', { className: 'opui-none' }, 'No ' + (filter || 'matching') + ' capabilities.') : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 10 } },
                shown.map(capCard)),
              seededRows.length ? h('div', { style: { marginTop: 12 } },
                h('button', { className: 'opui-sys-toggle', onClick: () => setShowSeeded(!showSeeded) },
                  (showSeeded ? '\u25be ' : '\u25b8 ') + 'System verification capabilities (' + seededRows.length + ') — kept out of normal routing'),
                showSeeded ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 10, opacity: .75 } },
                  seededRows.map(capCard)) : null) : null));
    };

    // ------------------------------------------------------------------ apply    // ------------------------------------------------------------------ apply

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
          }, (props) => h(CardBoundary, { label: 'Git' }, h(GitTab, props))));
        const disposeBrs = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'browser',
            order: 40,
            label: () => 'Browser',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(CardBoundary, { label: 'Browser' }, h(BrowserTab, props))));
        const disposeSum = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'summary',
            order: 25,
            label: () => 'Summary',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(CardBoundary, { label: 'Summary' }, h(SummaryTab, props))));
        const disposeFs = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'files',
            order: 50,
            label: () => 'Files',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(CardBoundary, { label: 'Files' }, h(FilesTab, props))));
        const disposeWf = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'workflows',
            order: 55,
            label: () => 'Workflows',
            inject: () => ({ __opuiCtx: ctx }),
          }, () => h(CardBoundary, { label: 'Workflows' }, h(WorkflowsTab, {}))));
        const disposeCaps = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'capabilities',
            order: 57,
            label: () => 'Capabilities',
            inject: () => ({ __opuiCtx: ctx }),
          }, () => h(CardBoundary, { label: 'Capabilities' }, h(CapabilitiesTab, {}))));
        // M0 control-plane surfaces (additive; legacy tabs stay — reversible
        // migration boundary). Order groups them first: System, Work,
        // Intelligence.
        const disposeSys = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'system',
            order: 15,
            label: () => 'System',
            inject: () => ({ __opuiCtx: ctx }),
          }, () => h(CardBoundary, { label: 'System' }, h(SystemSurface, {}))));
        const disposeWork = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'work',
            order: 22,
            label: () => 'Work',
            inject: () => ({ __opuiCtx: ctx }),
          }, (props) => h(CardBoundary, { label: 'Work' }, h(WorkSurface, props))));
        const disposeIntel = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'intelligence',
            order: 24,
            label: () => 'Intelligence',
            inject: () => ({ __opuiCtx: ctx }),
          }, () => h(CardBoundary, { label: 'Intelligence' }, h(IntelligenceSurface, {}))));
        // Control plane overlay: first-run gate (receipt not VALID) +
        // session-less launcher for the M0 surfaces (mode-gated; the
        // persisted preference is the reversible migration boundary).
        const disposeGate = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({
            name: 'shell.overlay',
            id: 'opui-gate',
            order: 10,
            inject: () => ({ __opuiCtx: ctx }),
          }, () => h(CardBoundary, { label: 'Gate' }, h(SurfaceOverlay, null))));
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
          try { disposeBrs && disposeBrs(); } catch {}
          try { disposeSum && disposeSum(); } catch {}
          try { disposeFs && disposeFs(); } catch {}
          try { disposeWf && disposeWf(); } catch {}
          try { disposeCaps && disposeCaps(); } catch {}
          try { disposeSys && disposeSys(); } catch {}
          try { disposeWork && disposeWork(); } catch {}
          try { disposeIntel && disposeIntel(); } catch {}
          try { disposeGate && disposeGate(); } catch {}
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
