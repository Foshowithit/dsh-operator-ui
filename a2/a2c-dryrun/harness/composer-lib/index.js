// A2-c composer — TEST-ONLY scratch harness (dsh-a0-boot), loopback-only.
//
// Boots nothing itself: the dsh launcher boots the composition (profile
// layers + the --patch overlay); the overlay disables the one-shot headless
// rows and inserts this plugin. apply() then drives ONE idea-chat preset
// session through two live turns against the loopback provider:
//
//   turn 1 (brainstorm)  — must stay conversational: the dispatch audit file
//                          must not grow (every dispatch, including refusals,
//                          appends one line — so zero new lines is proof).
//   turn 2 (procedural)  — the scripted model turn calls dispatch_seat, and
//                          the REAL dsh-seat-dispatch code composes the WM
//                          seat, drives it (seat turns served by the same
//                          loopback; the seat's model-visible tool list is
//                          run_code only under ptc presentation), collects
//                          the receipt submitted from inside the program, and
//                          appends the audit line.
//
// Model turns are SCRIPTED by the loopback (zero real inference, zero spend);
// the dispatch -> seat -> PTC -> receipt -> audit chain is production code.
// The harness receipt states this explicitly. Session-driving primitives are
// the same ones dsh-headless's one-shot runner uses (loader await, agents.
// create with meta+setup, followup/whenIdle, sessions.flush, appExit).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { brandString } from '@deepseek-ai/dsh-brand';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'a2c-composer';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'sessions'];

export const Config = z.object({
  workDir: z.string().required().description('absolute caller working directory; the session header carries it as cwd'),
  evidenceFile: z.string().required().description('absolute path for the harness receipt JSON written at the end'),
  auditFile: z.string().required().description('absolute path of the dispatcher audit jsonl; line counts are the dispatch proof'),
  brainstormMessage: z.string().required().description('turn-1 user text; must stay conversational (zero dispatch)'),
  proceduralMessage: z.string().required().description('turn-2 user text; the loopback answers it with a dispatch_seat call'),
});

function emit(out, type, payload) {
  out.write(JSON.stringify({ type, ...payload }) + '\n');
}

async function countLines(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length === 0 ? 0 : text.trimEnd().split('\n').length;
  } catch {
    return 0;
  }
}

async function readRecords(path, fromIndex) {
  try {
    const text = await readFile(path, 'utf8');
    const lines = text.length === 0 ? [] : text.trimEnd().split('\n');
    const records = [];
    for (let i = fromIndex; i < lines.length; i += 1) {
      try { records.push(JSON.parse(lines[i])); } catch { records.push({ unparseable: lines[i].slice(0, 200) }); }
    }
    return records;
  } catch {
    return [];
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run(ctx, config, exit) {
  await ctx.get('loader')?.await?.();
  const agents = ctx.get('agents');
  const presets = ctx.get('agentPresets');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  const fs = ctx.get('fs');
  if (agents === undefined || presets === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('a2c-composer: core services absent (agents/agentPresets/agentDefaultModel/sessions)');
  }

  const workDir = fs !== undefined ? fs.processPath(await fs.resolve(config.workDir)) : config.workDir;
  const selection = defaultModel.currentSelection();
  const agentOptions = { provider: selection.provider, model: selection.model };
  const sessionId = brandString('session-' + randomUUID());
  const auditBefore = await countLines(config.auditFile);

  emit(process.stdout, 'composer/start', {
    session_id: String(sessionId),
    provider: agentOptions.provider,
    model: agentOptions.model,
    workDir,
    preset: 'idea-chat',
    audit_before: auditBefore,
  });

  const handle = await agents.create({
    sessionId,
    meta: { cwd: workDir, agentPreset: 'idea-chat' },
    agentOptions,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, 'idea-chat');
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  });
  const agent = handle.agent;
  await agent.whenIdle();

  // Live-scope proof: this is the read readCallerPreset performs — the scope
  // read beats the header projection, so a live idea-chat mount here is what
  // yields authority_basis 'no-parent-root' for the dispatch.
  let composedPreset = null;
  try {
    composedPreset = presets.composedPreset(agent.ctx) ?? null;
  } catch { /* record-only; not load-bearing */ }
  emit(process.stdout, 'composer/preset', { composed_preset: composedPreset === null ? null : String(composedPreset) });

  let header = null;
  try { header = plain(agent.session.header); } catch { /* record-only */ }
  emit(process.stdout, 'composer/header', { header });

  // ── turn 1: brainstorm — conversational, zero dispatch ────────────────────
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.brainstormMessage }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  const auditAfterBrainstorm = await countLines(config.auditFile);
  emit(process.stdout, 'composer/turn1-brainstorm', {
    audit_after: auditAfterBrainstorm,
    dispatch_delta: auditAfterBrainstorm - auditBefore,
  });
  if (auditAfterBrainstorm !== auditBefore) {
    throw new Error(`brainstorm turn must not dispatch: audit grew ${auditBefore} -> ${auditAfterBrainstorm}`);
  }

  // ── turn 2: procedural — dispatch_seat -> WM seat -> receipt -> audit ─────
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.proceduralMessage }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  const auditAfterProcedural = await countLines(config.auditFile);
  const newRecords = await readRecords(config.auditFile, auditAfterBrainstorm);
  emit(process.stdout, 'composer/turn2-procedural', {
    audit_after: auditAfterProcedural,
    dispatch_delta: auditAfterProcedural - auditAfterBrainstorm,
    records: newRecords,
  });
  if (auditAfterProcedural - auditAfterBrainstorm < 1) {
    throw new Error(`procedural turn produced no dispatch audit record (${auditAfterBrainstorm} -> ${auditAfterProcedural})`);
  }

  await sessions.flush(agent.session);

  const receipt = {
    schema: 'a2c-composer-run/1',
    ok: true,
    caller_session_id: String(sessionId),
    preset: 'idea-chat',
    composed_preset: composedPreset === null ? null : String(composedPreset),
    agent: agentOptions,
    turns: [
      { kind: 'brainstorm', dispatch_delta: auditAfterBrainstorm - auditBefore },
      { kind: 'procedural', dispatch_delta: auditAfterProcedural - auditAfterBrainstorm, audit_records: newRecords },
    ],
    audit_file: config.auditFile,
    honesty: 'model turns on both sessions were scripted by the a2c loopback (127.0.0.1, dummy key, zero inference, zero spend; the model id is a label); the dispatch_seat execution, WM seat composition, ptc run_code lane, receipt validation, and audit append are the real production code paths',
    ts: new Date().toISOString(),
  };
  await mkdir(dirname(config.evidenceFile), { recursive: true });
  await writeFile(config.evidenceFile, JSON.stringify(receipt, null, 2) + '\n');
  emit(process.stdout, 'composer/done', { evidence: config.evidenceFile });

  try { await handle.dispose?.(); } catch { /* best-effort disposal */ }
  exit(0);
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (exit === undefined) {
    throw new Error('a2c-composer: ctx.appExit is required — boot through the dsh launcher');
  }
  run(ctx, config, exit).catch((error) => {
    emit(process.stdout, 'composer/fatal', { error: String(error?.stack ?? error) });
    exit(1);
  });
}
