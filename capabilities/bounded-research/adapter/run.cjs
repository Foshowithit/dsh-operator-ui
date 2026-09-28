#!/usr/bin/env node
// capabilities/bounded-research/adapter/run.cjs — bounded cited-research adapter.
//
// kernel:  RCOS_INPUT=<input.json> RCOS_OUTPUT=<out.json> RCOS_EVIDENCE_DIR=<dir> run.cjs
//   (or --input/--out/--evidence-dir flags; --evidence-dir defaults to a tmp dir)
//
// Fetches 1-5 operator-named URLs whose hosts are all on the input allowlist
// (exact match, case-insensitive; https required except loopback http for
// bounded evals) and returns cited passages with digests plus explicit
// refusals. A 200 with an empty body, a timeout, a non-text payload, or an
// off-allowlist host is a RECORDED REFUSAL, never a citation and never fatal:
// exit 0 on valid input even when every fetch is refused. Exit 2 on malformed
// input or an unusable evidence dir. No search, no crawl, no cookies, no POST.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const SCHEMA = 'bounded-research-observation/1';
const MAX_QUERY = 280;
const MAX_URLS = 5;
const MAX_HOSTS = 16;
const MAX_BYTES = 262144;
const EXCERPT = 500;

const die = (code, message) => { console.error('bounded-research: ' + message); process.exit(code); };

function isLoopback(host) {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost';
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be a JSON object';
  if (typeof input.query !== 'string' || input.query.trim().length === 0) return 'input.query must be a non-empty string';
  if (input.query.trim().length > MAX_QUERY) return `input.query exceeds ${MAX_QUERY} chars`;
  if (!Array.isArray(input.urls) || input.urls.length === 0 || input.urls.length > MAX_URLS) {
    return `input.urls must list 1-${MAX_URLS} URLs`;
  }
  for (const u of input.urls) {
    if (typeof u !== 'string' || u.length === 0) return 'every url must be a non-empty string';
  }
  if (!Array.isArray(input.allowlist) || input.allowlist.length === 0 || input.allowlist.length > MAX_HOSTS) {
    return `input.allowlist must list 1-${MAX_HOSTS} hosts`;
  }
  for (const h of input.allowlist) {
    if (typeof h !== 'string' || h.trim().length === 0) return 'every allowlist host must be a non-empty string';
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 20000)) {
    return 'input.timeoutMs must be an integer 500-20000 when supplied';
  }
  return null;
}

function allowed(url, allowlist) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'unparseable-url' };
  }
  const host = parsed.hostname.toLowerCase();
  const listed = allowlist.some((h) => h.toLowerCase() === host);
  if (!listed) return { ok: false, reason: 'off-allowlist', host };
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(host))) {
    return { ok: false, reason: 'insecure-scheme', host };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials-in-url', host };
  return { ok: true, parsed, host };
}

function fetchOnce(url, timeoutMs, maxBytes, redirectsLeft) {
  return new Promise((resolvePromise) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolvePromise({ ok: false, reason: 'unparseable-url' });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          resolvePromise({ ok: false, reason: 'bad-redirect' });
          return;
        }
        fetchOnce(next, timeoutMs, maxBytes, redirectsLeft - 1).then((r) => {
          if (r.finalUrl) resolvePromise(r);
          else resolvePromise({ ...r, finalUrl: next });
        });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        resolvePromise({ ok: false, reason: `http-${status}` });
        return;
      }
      const contentType = String(res.headers['content-type'] || '');
      if (contentType && !/^text\/|application\/(json|xml|xhtml\+xml)/i.test(contentType.split(';')[0].trim())) {
        res.resume();
        resolvePromise({ ok: false, reason: 'non-text-payload', contentType });
        return;
      }
      const chunks = [];
      let bytes = 0;
      let tooBig = false;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) {
          tooBig = true;
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      res.on('end', () => {
        if (tooBig) resolvePromise({ ok: false, reason: 'oversize-payload' });
        else resolvePromise({ ok: true, status, body: Buffer.concat(chunks), contentType });
      });
      res.on('error', () => resolvePromise({ ok: false, reason: 'body-error' }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => {
      resolvePromise({ ok: false, reason: /timeout/i.test(e && e.message ? e.message : '') ? 'timeout' : 'fetch-error' });
    });
  });
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[m.toLowerCase()] || ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function terms(query) {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3).slice(0, 12);
}

function excerptFor(text, queryTerms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of queryTerms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return { excerpt: text.slice(0, EXCERPT), termHit: false };
  const start = Math.max(0, at - 160);
  return { excerpt: text.slice(start, start + EXCERPT), termHit: true };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  const inputPath = process.env.RCOS_INPUT || flag('input');
  const outputPath = process.env.RCOS_OUTPUT || flag('out');
  let evidenceDir = process.env.RCOS_EVIDENCE_DIR || flag('evidence-dir');
  if (!inputPath) die(2, 'no input (set RCOS_INPUT or --input)');
  const outPath = outputPath || path.join(process.cwd(), 'bounded-research-observation.json');
  if (!evidenceDir) evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-research-'));
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
  } catch (e) {
    die(2, 'evidence dir unusable: ' + e.message);
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    die(2, 'input is not readable JSON: ' + e.message);
  }
  const problem = validate(input);
  if (problem) die(2, problem);
  const query = input.query.trim();
  const queryTerms = terms(query);
  const timeoutMs = input.timeoutMs ?? 8000;
  fs.writeFileSync(path.join(evidenceDir, 'input.json'), JSON.stringify(input, null, 2) + '\n');
  const passages = [];
  const refused = [];
  const log = [];
  for (let i = 0; i < input.urls.length; i += 1) {
    const url = input.urls[i];
    const gate = allowed(url, input.allowlist);
    if (!gate.ok) {
      refused.push({ url, reason: gate.reason });
      log.push({ url, outcome: 'refused', reason: gate.reason });
      continue;
    }
    // Redirects that leave the allowlist are refused after the fetch reports them.
    const fetched = await fetchOnce(url, timeoutMs, MAX_BYTES, 3);
    const finalHost = (() => { try { return new URL(fetched.finalUrl || url).hostname.toLowerCase(); } catch { return ''; } })();
    if (fetched.finalUrl && !input.allowlist.some((h) => h.toLowerCase() === finalHost)) {
      refused.push({ url, reason: 'redirect-off-allowlist' });
      log.push({ url, outcome: 'refused', reason: 'redirect-off-allowlist' });
      continue;
    }
    if (!fetched.ok) {
      refused.push({ url, reason: fetched.reason });
      log.push({ url, outcome: 'refused', reason: fetched.reason });
      continue;
    }
    const raw = fetched.body.toString('utf8');
    if (raw.trim().length === 0) {
      refused.push({ url, reason: 'empty-body' });
      log.push({ url, outcome: 'refused', reason: 'empty-body' });
      continue;
    }
    const text = stripTags(raw);
    if (text.length === 0) {
      refused.push({ url, reason: 'no-extractable-text' });
      log.push({ url, outcome: 'refused', reason: 'no-extractable-text' });
      continue;
    }
    const { excerpt, termHit } = excerptFor(text, queryTerms);
    const sha256 = crypto.createHash('sha256').update(fetched.body).digest('hex');
    const fetchedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidenceDir, `body-${i}.bin`), fetched.body);
    passages.push({
      url, host: finalHost || gate.host,
      scheme: new URL(fetched.finalUrl || url).protocol.replace(':', ''),
      status: fetched.status, bytes: fetched.body.length, sha256, fetchedAt,
      excerpt, termHit,
    });
    log.push({ url, outcome: 'cited', bytes: fetched.body.length, sha256, termHit });
  }
  fs.writeFileSync(path.join(evidenceDir, 'fetch-log.json'), JSON.stringify(log, null, 2) + '\n');
  const doc = { schema: SCHEMA, query, passages, refused };
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`cited\t${passages.length}\trefused\t${refused.length}`);
  for (const r of refused) console.log(`refused\t${r.url}\t${r.reason}`);
  console.log('observation: ' + outPath);
  process.exit(0);
}

main().catch((e) => die(2, 'adapter failure: ' + (e && e.message ? e.message : e)));
