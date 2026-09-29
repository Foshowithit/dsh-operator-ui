// A2-d loopback — TEST ONLY, scratch evidence. Binds 127.0.0.1:8793.
// Same locked routing design as the a2c loopback, plus the invalid-dispatch
// marker: the caller's turn-2 request gets a dispatch_seat tool_use for an
// UNDESIGNATED seat — the real dispatcher authority gate refuses it, which is
// the pass condition. Zero inference, zero spend; the dummy key is never
// validated and NEVER written — only sha256[:10] + length.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = 8793;
const EVIDENCE = '/Users/adam26/dsh-a0-boot/a2d/evidence';
const JOURNAL = `${EVIDENCE}/loopback.jsonl`;
const PROGRAM_FILE = process.env.A2D_PROGRAM ?? '/Users/adam26/dsh-a0-boot/a2d/program.a2d.txt';
let n = 0;
let toolSeq = 0;
const t0 = Date.now();

const fp = (value) => (value === undefined ? null : createHash('sha256').update(String(value)).digest('hex').slice(0, 10));

// ── SSE event builders ──────────────────────────────────────────────────────
function textEvents(text) {
  return [
    { type: 'message_start', message: { id: 'msg_a2d_loopback', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
function toolUseEvents(name, input) {
  toolSeq += 1;
  return [
    { type: 'message_start', message: { id: 'msg_a2d_loopback', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_a2d_${toolSeq}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
function sseSend(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function jsonSend(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ── scripted turns ──────────────────────────────────────────────────────────
const BRAINSTORM_REPLY =
  '[A2D-BRAINSTORM-REPLY] Still conversation: the failure paths are part of the design, not an afterthought — a chain that only proves its happy path proves nothing. No tools this turn.';
const CALLER_CLOSE_REPLY =
  '[A2D-CALLER-CLOSED] The seat turn is done. The tool result carries the receipt — read verdict, evidence, and any archon fields from it; presence != success stays our rule.';
const WM_CLOSE_REPLY = 'Objective handled; the receipt has been submitted from inside the program. Nothing further this turn.';

const INVALID_DISPATCH_ARGS = {
  seat: 'no-such-seat',
  objective:
    'A2-d failure-path probe (dispatcher layer): dispatch to a seat that is not designated in this composition. The expected outcome is an EXPLICIT authority refusal recorded in the dispatch audit — a silent success or a silent failure both fail the probe.',
  done_when: 'The dispatcher refuses the dispatch with an authority-stage reason and appends the refusal audit line.',
  reason: 'A2-d invalid-identity failure path: exercise the authority gate with an undesignated seat identity.',
  constraints: [],
  context: 'A2-d testbed. This call is expected to be refused.',
  lane_expectation: 'loopback-0spend/deepseek-flash',
  timeout_ms: 60000,
};

const DISPATCH_ARGS = {
  seat: 'wm',
  objective:
    'Demonstrate the four A2-d failure paths with explicit refusal and recovery, using the real rcos CLI on the Dell over ssh: (1) missing capability — rcos run names a capability absent from the registry; (2) invalid identity at the kernel layer — the promoted route-record-validate capability evaluates the authority-refused fixture record (a delegated-child handoff) and must refuse it while the run itself completes; (3) permission denied — the local ptc bash sandbox must deny a write outside the seat workspace and record the denial; (4) backend down — an ssh connection to a closed port must fail with an explicit connection-refused error. Then submit one receipt stating, per path, the refusal text and the recovery.',
  done_when:
    'All four probes produced their expected explicit refusal, the program recovered after each, and one submit_dispatch_receipt was accepted describing them.',
  reason:
    'A2-d ordinary-conversation procedural request: this caller (idea-chat) has no shell; the probes need the WM seat.',
  constraints: [
    'Zero model spend: no model calls anywhere in the probes.',
    'Dell is production: never restart services; no pkill ever; writes stay inside ~/zcode-rcos and /tmp.',
    'The backend-down probe must target a closed LOCAL port (127.0.0.1), never the real Dell.',
    'Never print key material; fingerprints only.',
  ],
  context:
    'A2-d testbed on the Mac reaches the Dell via ssh chow@100.111.182.5. The rcos CLI lives at ~/zcode-rcos/bin/rcos. The authority-refused fixture is at ~/zcode-rcos/capabilities/route-record-validate/fixtures/authority-refused.json (kernel exit 3, verdict authority-refusal). A calibrated live refusal: rcos run no-such-capability exits 2 with "no such capability" in the message.',
  lane_expectation: 'loopback-0spend/deepseek-flash',
  timeout_ms: 900000,
};

// ── request analysis ────────────────────────────────────────────────────────
function analyze(body, headers) {
  const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t.name) : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  let lastUserText = '';
  let lastIsToolResult = false;
  if (last !== undefined) {
    const content = last.content;
    if (typeof content === 'string') lastUserText = content;
    else if (Array.isArray(content)) {
      lastUserText = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
      lastIsToolResult = content.some((b) => b?.type === 'tool_result');
    }
  }
  return {
    tools,
    hasRunCode: tools.includes('run_code'),
    hasDispatchSeat: tools.includes('dispatch_seat'),
    compact: headers['x-deepseek-harness-compact'] ?? null,
    sessionId: headers['x-deepseek-harness-session-id'] ?? null,
    model: body?.model ?? null,
    stream: body?.stream !== false,
    messageCount: messages.length,
    lastRole: last?.role ?? null,
    lastIsToolResult,
    lastUserTextLen: lastUserText.length,
    brainstormTag: lastUserText.includes('A2D-BRAINSTORM-MARKER'),
    invalidTag: lastUserText.includes('A2D-INVALID-MARKER'),
    proceduralTag: lastUserText.includes('A2D-PROCEDURAL-MARKER'),
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    n += 1;
    const raw = Buffer.concat(chunks).toString('utf8');
    writeFileSync(`${EVIDENCE}/req-${n}.json`, raw);
    let body = null;
    try { body = JSON.parse(raw); } catch { /* journaled below */ }
    const a = analyze(body, req.headers);
    const key = req.headers['x-api-key'];
    const record = {
      n,
      t: Date.now() - t0,
      method: req.method,
      url: req.url,
      apiKeyFp: key === undefined ? null : fp(key),
      apiKeyLen: key === undefined ? 0 : String(key).length,
      ...a,
    };
    appendFileSync(JOURNAL, JSON.stringify(record) + '\n');

    if (body === null) {
      jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: 'a2d loopback: body is not JSON (fail loud)' } });
      return;
    }
    if (a.hasRunCode) {
      if (a.lastIsToolResult) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'wm/close' }) + '\n');
        a.stream ? sseSend(res, textEvents(WM_CLOSE_REPLY)) : jsonSend(res, 200, nonStreamText(WM_CLOSE_REPLY));
      } else {
        const program = readFileSync(PROGRAM_FILE, 'utf8');
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'wm/probes', programFile: PROGRAM_FILE, programLen: program.length }) + '\n');
        a.stream ? sseSend(res, toolUseEvents('run_code', { code: program, description: 'Run the A2-d failure-path probe program' }))
          : jsonSend(res, 200, nonStreamTool('run_code', { code: program, description: 'Run the A2-d failure-path probe program' }));
      }
      return;
    }
    if (a.hasDispatchSeat) {
      if (a.compact !== null) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/compact' }) + '\n');
        a.stream ? sseSend(res, textEvents('summary: a2d brainstorm, invalid-dispatch refusal, then procedural dispatch (a2d scripted compact)')) : jsonSend(res, 200, nonStreamText('summary'));
        return;
      }
      if (a.lastIsToolResult) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/close' }) + '\n');
        a.stream ? sseSend(res, textEvents(CALLER_CLOSE_REPLY)) : jsonSend(res, 200, nonStreamText(CALLER_CLOSE_REPLY));
        return;
      }
      if (a.brainstormTag) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/brainstorm' }) + '\n');
        a.stream ? sseSend(res, textEvents(BRAINSTORM_REPLY)) : jsonSend(res, 200, nonStreamText(BRAINSTORM_REPLY));
        return;
      }
      if (a.invalidTag) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/invalid-dispatch' }) + '\n');
        a.stream ? sseSend(res, toolUseEvents('dispatch_seat', INVALID_DISPATCH_ARGS)) : jsonSend(res, 200, nonStreamTool('dispatch_seat', INVALID_DISPATCH_ARGS));
        return;
      }
      if (a.proceduralTag) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/procedural' }) + '\n');
        a.stream ? sseSend(res, toolUseEvents('dispatch_seat', DISPATCH_ARGS)) : jsonSend(res, 200, nonStreamTool('dispatch_seat', DISPATCH_ARGS));
        return;
      }
      appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/other-UNEXPECTED' }) + '\n');
      jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: 'a2d loopback: unexpected caller request (no marker, not tool_result) — fail loud' } });
      return;
    }
    if (a.tools.length === 0) {
      appendFileSync(JOURNAL, JSON.stringify({ n, route: 'secondary' }) + '\n');
      a.stream ? sseSend(res, textEvents('ok')) : jsonSend(res, 200, nonStreamText('ok'));
      return;
    }
    appendFileSync(JOURNAL, JSON.stringify({ n, route: 'unknown-UNEXPECTED', tools: a.tools }) + '\n');
    jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: `a2d loopback: unroutable tool set ${JSON.stringify(a.tools)} — fail loud` } });
  });
});

function nonStreamText(text) {
  return { id: 'msg_a2d_loopback', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}
function nonStreamTool(name, input) {
  return { id: 'msg_a2d_loopback', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_a2d_${++toolSeq}`, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
}

server.listen(PORT, '127.0.0.1', () => {
  appendFileSync(JOURNAL, JSON.stringify({ ev: 'listening', port: PORT, programFile: PROGRAM_FILE, t: 0 }) + '\n');
  console.log(`a2d loopback listening on 127.0.0.1:${PORT} (program: ${PROGRAM_FILE})`);
});
// Hard self-exit (25 min > the 15-min dispatch budget) so no stray listener
// ever survives the experiment.
setTimeout(() => process.exit(0), 25 * 60 * 1000).unref();
