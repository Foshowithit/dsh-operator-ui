// Fixture HTTP server for bounded-research evals/tests. Loopback only,
// canned pages, no external egress. Prints "PORT <n>" on stdout when ready.
// Optional argv[2] === 'perturbed' serves term-free page-a (negative control).
const http = require('node:http');

const TERMS = 'bounded research citations';
const perturbed = process.argv[2] === 'perturbed';
const pageA = perturbed
  ? '<html><body><p>Unrelated filler about weather and lunch menus, nothing matching.</p></body></html>'
  : `<html><body><h1>Bounded research</h1><p>Passages with citations for ${TERMS} stay honest.</p></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/page-a') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageA);
  } else if (req.url === '/page-b') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Second source on ${TERMS}; fetched for the eval only.`);
  } else if (req.url === '/empty') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('');
  } else if (req.url === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('gone');
  } else if (req.url === '/slow') {
    setTimeout(() => { try { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('late'); } catch {} }, 3000);
  } else if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 3, 4]));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  console.log('PORT ' + server.address().port);
});
