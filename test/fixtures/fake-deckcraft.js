#!/usr/bin/env node
/* DeckCraft tiruan untuk tes: mendengarkan `--control <port>` dan menjawab seperti control protocol asli. */
'use strict';
const net = require('net');
const fs = require('fs');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--control') + 1]);
const file = args.find((a, i) => i > 0 && args[i - 1] !== '--control' && a !== '--control');
const log = process.env.FAKE_DC_LOG;
const srv = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (log) fs.appendFileSync(log, JSON.stringify(req) + '\n');
      let result = {};
      if (req.method === 'app.save') fs.appendFileSync(req.params.path || file, '');
      if (req.method === 'app.save') { const t = new Date(); fs.utimesSync(req.params.path || file, t, t); }
      sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
      if (req.method === 'app.quit') setTimeout(() => process.exit(0), 50);
    }
  });
});
setTimeout(() => srv.listen(port, '127.0.0.1'), 300); // pura-pura butuh waktu untuk siap
