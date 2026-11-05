const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { outputDir, basePathFromArgs } = require('./site-config.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function option(name, fallback, args = process.argv.slice(2)) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && !args[i + 1]) throw new Error(`--${name} needs a value.`);
  return i >= 0 ? args[i + 1] : fallback;
}

function startServer({ basePath = basePathFromArgs(), port = Number(option('port', process.env.PORT || '4173')), host = option('host', process.env.HOST || '127.0.0.1') } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (!fs.existsSync(path.join(outputDir, 'index.html'))) throw new Error('No built viewer. Run npm run build first.');
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Read-only viewer'); return;
    }
    const requested = new URL(request.url, 'http://localhost');
    if (basePath !== '/' && requested.pathname === basePath.slice(0, -1)) {
      response.writeHead(308, { Location: basePath + requested.search }); response.end(); return;
    }
    if (!requested.pathname.startsWith(basePath)) {
      response.writeHead(404); response.end('Outside site base path'); return;
    }
    let relative;
    try { relative = decodeURIComponent(requested.pathname.slice(basePath.length)); }
    catch { response.writeHead(400); response.end('Invalid path'); return; }
    if (relative.includes('\0') || relative.includes('\\')) {
      response.writeHead(400); response.end('Invalid path'); return;
    }
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(outputDir, relative);
    const inside = path.relative(outputDir, file);
    if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('File not found'); return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`CAISO read-only preview: http://${host}:${address.port}${basePath}`);
  });
  return server;
}

module.exports = { startServer };
if (require.main === module) {
  try { startServer(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
