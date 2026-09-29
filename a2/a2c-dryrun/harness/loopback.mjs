// A2-c loopback — TEST ONLY, scratch evidence. Binds 127.0.0.1:8793.
// Answers the harness's /messages requests with SCRIPTED model turns over
// SSE (zero inference, zero spend, no upstream of any kind; the dummy key is
// never validated and NEVER written — only sha256[:10] + length).
//
// Routing (locked design):
//   tools include run_code      -> WM seat scope (ptc presentation: the seat's
//                                  model-visible list is exactly [run_code])
//       last msg tool_result    -> short closing text (seat drains, receipt lane)
//       otherwise               -> run_code tool_use whose code = PROGRAM_FILE
//                                  contents, read fresh per request
//   tools include dispatch_seat -> caller scope (idea-chat: no run_code)
//       compact header set      -> trivial text (compaction helper)
//       last msg tool_result    -> closing text (dispatch result in hand)
//       text has BRAINSTORM tag -> conversational text, NO tools (turn 1 proof)
//       text has PROCEDURAL tag -> dispatch_seat tool_use (scripted routing
//                                  decision; everything after it is real)
//       anything else           -> 500 + journal (fail loud, never guess)
//   no tools / empty            -> trivial text (title + secondary helpers)
//   anything else               -> 500 + journal
//
// SSE frames are data-only (no `event:` lines — if present it must equal
// event.type); the provider's EventSourceParserStream + translator consume
// exactly this sequence.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = 8793;
const EVIDENCE = '/Users/adam26/dsh-a0-boot/a2c/evidence';
const JOURNAL = `${EVIDENCE}/loopback.jsonl`;
const PROGRAM_FILE = process.env.A2C_PROGRAM ?? '/Users/adam26/dsh-a0-boot/a2c/program.dryrun.txt';
let n = 0;
let toolSeq = 0;
const t0 = Date.now();

const fp = (value) => (value === undefined ? null : createHash('sha256').update(String(value)).digest('hex').slice(0, 10));

// ── SSE event builders ──────────────────────────────────────────────────────
function textEvents(text) {
  return [
    { type: 'message_start', message: { id: 'msg_a2c_loopback', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } } },
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
    { type: 'message_start', message: { id: 'msg_a2c_loopback', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_a2c_${toolSeq}`, name, input: {} } },
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
  '[A2C-BRAINSTORM-REPLY] Talking it through, no tools touched: the promo keeps one law — near-black, off-white, a single accent. The film opens on the ring, not the logo; the reveal earns itself over three beats. When we want any of this actually made, I hand it to the WM seat — but we are not there yet; this is still conversation.';
const CALLER_CLOSE_REPLY =
  '[A2C-CALLER-CLOSED] The WM seat returned its receipt. Back in plain conversation: check the receipt fields in the tool result — verdict, evidence, the Archon run id if any — and treat presence != success as our standing rule.';
const WM_CLOSE_REPLY = 'Objective handled; the receipt has been submitted from inside the program. Nothing further this turn.';

const DISPATCH_ARGS = {
  seat: 'wm',
  objective:
    'Validate one RCOS routing record end to end through the real capability ladder and run it on Archon: find the route-record-validate capability in the registry (build it if missing), compile its IR to a workflow and install, run the workflow on Archon, and report the real run id and artifacts.',
  done_when:
    'The workflow run completed on Archon, its artifacts exist on disk, and one submit_dispatch_receipt carrying the real run id, artifact dir, and evidence was accepted.',
  reason:
    'A2-c ordinary-conversation procedural request: this caller (idea-chat) has no shell and no workflow authority; the work needs the WM seat.',
  constraints: [
    'Zero model spend: the workflow must be bash-only nodes — no model nodes anywhere in the DAG.',
    'Dell is production: never restart services; if a pid must die, kill only the pid holding the port via lsof -ti tcp:<port> -sTCP:LISTEN.',
    'Dell writes stay inside ~/zcode-rcos (repo work), the Archon workflows/artifacts roots, and /tmp.',
    'Never print key material; fingerprints only.',
  ],
  context:
    'A2-c testbed on the Mac reaches the Dell via ssh chow@100.111.182.5. The rcos CLI lives at ~/zcode-rcos/bin/rcos (ir-compile --install subcommand available). Archon CLI: archon workflow run <name> <input-json>. Mac is a read-only client for Dell-owned things; Dell repos are single-writer.',
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
    brainstormTag: lastUserText.includes('A2C-BRAINSTORM-MARKER'),
    proceduralTag: lastUserText.includes('A2C-PROCEDURAL-MARKER'),
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
      jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: 'a2c loopback: body is not JSON (fail loud)' } });
      return;
    }
    if (a.hasRunCode) {
      if (a.lastIsToolResult) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'wm/close' }) + '\n');
        a.stream ? sseSend(res, textEvents(WM_CLOSE_REPLY)) : jsonSend(res, 200, nonStreamText(WM_CLOSE_REPLY));
      } else {
        const program = readFileSync(PROGRAM_FILE, 'utf8');
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'wm/ladder', programFile: PROGRAM_FILE, programLen: program.length }) + '\n');
        a.stream ? sseSend(res, toolUseEvents('run_code', { code: program, description: 'Run the WM ladder program' }))
          : jsonSend(res, 200, nonStreamTool('run_code', { code: program, description: 'Run the WM ladder program' }));
      }
      return;
    }
    if (a.hasDispatchSeat) {
      if (a.compact !== null) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/compact' }) + '\n');
        a.stream ? sseSend(res, textEvents('summary: bearing-film brainstorm then procedural dispatch (a2c scripted compact)')) : jsonSend(res, 200, nonStreamText('summary'));
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
      if (a.proceduralTag) {
        appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/procedural' }) + '\n');
        a.stream ? sseSend(res, toolUseEvents('dispatch_seat', DISPATCH_ARGS)) : jsonSend(res, 200, nonStreamTool('dispatch_seat', DISPATCH_ARGS));
        return;
      }
      appendFileSync(JOURNAL, JSON.stringify({ n, route: 'caller/other-UNEXPECTED' }) + '\n');
      jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: 'a2c loopback: unexpected caller request (no marker, not tool_result) — fail loud' } });
      return;
    }
    if (a.tools.length === 0) {
      appendFileSync(JOURNAL, JSON.stringify({ n, route: 'secondary' }) + '\n');
      a.stream ? sseSend(res, textEvents('ok')) : jsonSend(res, 200, nonStreamText('ok'));
      return;
    }
    appendFileSync(JOURNAL, JSON.stringify({ n, route: 'unknown-UNEXPECTED', tools: a.tools }) + '\n');
    jsonSend(res, 500, { type: 'error', error: { type: 'api_error', message: `a2c loopback: unroutable tool set ${JSON.stringify(a.tools)} — fail loud` } });
  });
});

function nonStreamText(text) {
  return { id: 'msg_a2c_loopback', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}
function nonStreamTool(name, input) {
  return { id: 'msg_a2c_loopback', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_a2c_${++toolSeq}`, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
}

server.listen(PORT, '127.0.0.1', () => {
  appendFileSync(JOURNAL, JSON.stringify({ ev: 'listening', port: PORT, programFile: PROGRAM_FILE, t: 0 }) + '\n');
  console.log(`a2c loopback listening on 127.0.0.1:${PORT} (program: ${PROGRAM_FILE})`);
});
// Hard self-exit (25 min > the 15-min dispatch budget) so no stray listener
// ever survives the experiment.
setTimeout(() => process.exit(0), 25 * 60 * 1000).unref();
