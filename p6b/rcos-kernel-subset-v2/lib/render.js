'use strict';

const STATUS_ORDER = { promoted: 0, candidate: 1, retired: 2 };

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verdictDot(v) {
  if (v === 'ship') return '<span class="dot ship" title="ship">&#9679;</span>';
  if (v === 'fix') return '<span class="dot fix" title="fix">&#9681;</span>';
  return '<span class="dot blocked" title="blocked">&#9675;</span>';
}

function renderDashboard(reg) {
  const caps = [...reg.capabilities].sort((a, b) =>
    (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.id < b.id ? -1 : 1));
  const counts = { promoted: 0, candidate: 0, retired: 0 };
  for (const c of caps) counts[c.status] += 1;
  const rows = caps.map((c) => {
    const dots = c.evals.map((e) => verdictDot(e.verdict)).join(' ') || '<span class="none">no evals yet</span>';
    return '    <tr>' +
      '<td><span class="status ' + c.status + '">' + c.status + '</span></td>' +
      '<td><strong>' + esc(c.id) + '</strong><br><span class="muted">' + esc(c.name) + '</span></td>' +
      '<td>' + esc(c.kind) + '</td>' +
      '<td>v' + esc(c.version) + '</td>' +
      '<td>' + c.reuse_count + '</td>' +
      '<td>' + esc(c.last_eval === null ? '-' : c.last_eval) + '</td>' +
      '<td>' + dots + '</td>' +
      '<td class="muted">' + esc(c.lineage || '') + '</td>' +
      '</tr>';
  }).join('\n');
  return '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head><meta charset="utf-8">\n' +
    '<title>zcode-rcos — capability registry</title>\n' +
    '<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#111}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top;font-size:14px}' +
    'th{background:#f5f5f5}.muted{color:#666;font-size:12px}.status{font-size:12px;padding:2px 8px;border-radius:10px}' +
    '.promoted{background:#dff5df}.candidate{background:#fff3cd}.retired{background:#eee}' +
    '.dot.ship{color:#1a7f1a}.dot.fix{color:#b8860b}.dot.blocked{color:#c00}.none{color:#999;font-size:12px}</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<h1>zcode-rcos — capability registry</h1>\n' +
    '<p>' + counts.promoted + ' promoted &middot; ' + counts.candidate + ' candidates &middot; ' + counts.retired + ' retired</p>\n' +
    '<table>\n' +
    '  <tr><th>status</th><th>capability</th><th>kind</th><th>version</th><th>reuse</th><th>last eval</th><th>evals</th><th>lineage</th></tr>\n' +
    rows + '\n' +
    '</table>\n' +
    '</body>\n' +
    '</html>\n';
}

module.exports = { renderDashboard };
