// dsh-operator-ui — supervised on-screen browser ("browser with a leash").
//
// ONE Chromium instance, owned by this plugin, that BOTH the agent (via the
// browser_* tools) and the human (via the Browser tab) share. The human
// watches a live screencast of exactly what the agent does — the GooeyPi /
// ZCode-desktop model, adapted to DSH's web UI.
//
// Leash rules (this capability is shaped by the 2026-09-12 dev-host OOM incident,
// where agent-spawned headless-Chrome trees ate 6 cores + 19.6 GB):
//   - exactly one browser process and one page target, lazily started;
//   - fixed argv, dedicated user-data-dir under $DSH_HOME (never the user's
//     real Chrome profile), http/https only;
//   - idle reaper: no activity for IDLE_MS → browser torn down;
//   - full teardown on plugin dispose (fiber-tracked).
//
// Zero dependencies: raw CDP over Node's native WebSocket; frames stream to
// the UI as SSE (webServer routes may hold responses open for SSE).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const IDLE_MS = 10 * 60 * 1000;
const VIEW_W = 1280;
const VIEW_H = 800;

function findChrome() {
  if (process.env.DSH_OPERATOR_UI_CHROME) return process.env.DSH_OPERATOR_UI_CHROME;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function createBrowserSupervisor(ctx) {
  let child = null;
  let ws = null;
  let msgId = 0;
  const pending = new Map();
  const eventHandlers = new Map();
  let pageUrl = 'about:blank';
  let lastActivity = 0;
  let starting = null;
  let refs = new Map(); // ref -> {x, y} from the last browser_snapshot
  const sseClients = new Set();
  let reaper = null;

  const touch = () => { lastActivity = Date.now(); };

  function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { sseClients.delete(res); }
    }
  }

  function send(method, params = {}) {
    if (!ws || ws.readyState !== 1) throw new Error('browser not running');
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 15000);
      pending.set(id, { resolve, reject, t });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function onFrame(params) {
    touch();
    try { send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); } catch {}
    broadcast({
      type: 'frame',
      d: params.data,
      w: params.metadata?.deviceWidth || VIEW_W,
      h: params.metadata?.deviceHeight || VIEW_H,
    });
  }

  async function connectPage(wsUrl) {
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.t);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      } else if (msg.method === 'Page.screencastFrame') {
        onFrame(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      broadcast({ type: 'status', running: false, url: pageUrl });
    });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.startScreencast', {
      format: 'jpeg', quality: 55, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1,
    });
  }

  async function ensure() {
    touch();
    if (ws && ws.readyState === 1) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        const chrome = findChrome();
        if (!chrome) throw new Error('Chrome/Chromium not found (set DSH_OPERATOR_UI_CHROME)');
        const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
        const profileDir = join(home, 'operator-ui-browser');
        mkdirSync(profileDir, { recursive: true });
        const dbg = join(profileDir, 'DevToolsActivePort');
        try { if (existsSync(dbg)) unlinkSync(dbg); } catch {}
        child = spawn(chrome, [
          '--headless=new',
          '--remote-debugging-port=0',
          `--user-data-dir=${profileDir}`,
          '--no-first-run', '--no-default-browser-check',
          '--disable-extensions', '--disable-background-networking',
          '--disable-sync', '--disable-crash-reporter', '--mute-audio',
          `--window-size=${VIEW_W},${VIEW_H}`,
          'about:blank',
        ], { stdio: 'ignore' });
        child.on('exit', () => { child = null; ws = null; });
        // wait for the DevToolsActivePort file (port on its first line)
        let port = null;
        for (let i = 0; i < 50; i++) {
          await delay(200);
          if (existsSync(dbg)) {
            try {
              const first = readFileSync(dbg, 'utf8').split('\n')[0].trim();
              if (first) { port = Number(first); break; }
            } catch {}
          }
          if (child === null) throw new Error('browser exited during startup');
        }
        if (!port) throw new Error('browser DevTools port never appeared');
        // page target ws url
        let wsUrl = null;
        for (let i = 0; i < 25; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page');
            if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
          } catch {}
          await delay(200);
        }
        if (!wsUrl) throw new Error('no page target found');
        await connectPage(wsUrl);
        startReaper();
        broadcast({ type: 'status', running: true, url: pageUrl });
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function startReaper() {
    if (reaper) return;
    reaper = setInterval(() => {
      if (child && Date.now() - lastActivity > IDLE_MS) {
        stop().catch(() => {});
      }
      if (!child && reaper) { clearInterval(reaper); reaper = null; }
    }, 60 * 1000);
    if (reaper.unref) reaper.unref();
  }

  async function stop() {
    lastActivity = 0;
    try { if (ws && ws.readyState === 1) { try { await send('Page.close'); } catch {} } } catch {}
    try { ws && ws.close(); } catch {}
    ws = null;
    if (child) { try { child.kill('SIGKILL'); } catch {} child = null; }
    broadcast({ type: 'status', running: false, url: pageUrl });
  }

  function assertHttpUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('invalid URL: ' + url); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('only http/https URLs are allowed');
    }
    return url;
  }

  async function navigate(url) {
    await ensure();
    const target = assertHttpUrl(String(url));
    await send('Page.navigate', { url: target });
    pageUrl = target;
    await delay(700); // let first paint hit the screencast
    const title = await evalJs('document.title');
    broadcast({ type: 'status', running: true, url: pageUrl });
    return { url: target, title: title || '' };
  }

  async function evalJs(expression) {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    return res?.result?.value;
  }

  async function snapshot() {
    await ensure();
    touch();
    const raw = await evalJs(`JSON.stringify((() => {
      const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick]')];
      return {
        title: document.title,
        url: location.href,
        text: (document.body ? (document.body.innerText || '') : '').slice(0, 4000),
        els: els.slice(0, 80).map((e, i) => {
          const r = e.getBoundingClientRect();
          return {
            ref: i + 1,
            tag: e.tagName.toLowerCase(),
            text: ((e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '') + '').trim().slice(0, 60),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            visible: r.width > 0 && r.height > 0
          };
        }).filter(e => e.visible)
      };
    })())`);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('snapshot failed'); }
    refs = new Map(parsed.els.map((e) => [e.ref, { x: e.x, y: e.y }]));
    pageUrl = parsed.url || pageUrl;
    return parsed;
  }

  async function click({ ref, x, y }) {
    await ensure();
    touch();
    let cx = x, cy = y;
    if (ref !== undefined) {
      const hit = refs.get(Number(ref));
      if (!hit) throw new Error('unknown ref ' + ref + ' — run browser_snapshot first');
      cx = hit.x; cy = hit.y;
    }
    if (cx == null || cy == null) throw new Error('click needs ref or x/y');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
    }
    await delay(400);
    return { clicked: [cx, cy] };
  }

  async function typeText({ text, ref, submit }) {
    await ensure();
    touch();
    if (ref !== undefined) await click({ ref });
    await send('Input.insertText', { text: String(text) });
    if (submit) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    await delay(400);
    return { typed: String(text).length, submit: !!submit };
  }

  function addSseClient(res) {
    const wasEmpty = sseClients.size === 0;
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', running: !!child, url: pageUrl })}\n\n`);
    touch();
    // Screencast only emits on paint; static pages would look frozen. While
    // anyone is watching, poll explicit captures at a modest cadence.
    if (wasEmpty) startCapturePoll();
    return () => {
      sseClients.delete(res);
      if (sseClients.size === 0) stopCapturePoll();
    };
  }

  let captureTimer = null;
  let lastBroadcast = 0;
  function startCapturePoll() {
    if (captureTimer) return;
    captureTimer = setInterval(async () => {
      if (!ws || ws.readyState !== 1 || sseClients.size === 0) return;
      const now = Date.now();
      if (now - lastBroadcast < 450) return;
      try {
        const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
        lastBroadcast = Date.now();
        broadcast({ type: 'frame', d: shot.data, w: VIEW_W, h: VIEW_H });
      } catch {}
    }, 500);
    if (captureTimer.unref) captureTimer.unref();
  }
  function stopCapturePoll() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  }

  function dispose() {
    if (reaper) { clearInterval(reaper); reaper = null; }
    stopCapturePoll();
    return stop();
  }

  return { ensure, navigate, snapshot, click, typeText, stop, dispose, addSseClient,
    status: () => ({ running: !!child, url: pageUrl, clients: sseClients.size, idleMs: child ? Date.now() - lastActivity : null }) };
}
