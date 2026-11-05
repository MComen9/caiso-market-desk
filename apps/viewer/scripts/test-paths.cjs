const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const esbuild = require('esbuild');
const { buildSite } = require('./build.cjs');
const { startServer } = require('./serve.cjs');
const { verifySite } = require('./verify.cjs');
const { projectDir, outputDir, normalizeBasePath } = require('./site-config.cjs');

function publicUrlFor(basePath) {
  const { code } = esbuild.transformSync(fs.readFileSync(path.join(projectDir, 'lib/public-url.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', define: { '__PUBLIC_BASE_PATH__': JSON.stringify(basePath) },
  });
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, sandbox, { timeout: 1000 });
  return sandbox.module.exports.publicUrl;
}

async function checkHttp(basePath) {
  const server = startServer({ basePath, port: 0, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const actualBase = origin + basePath;
    for (const file of [
      '', 'assets/viewer.js', 'assets/viewer.css', 'quick-view.html',
      'data/prices-bootstrap.json', 'data/outlook_snapshot_2026-10-28_2026-10-29.json',
      'data/fundamentals-snapshot.json', 'data/forecast-lab/v4/forecast-forward.json',
      'data/forecast-lab/v4/caiso-current-forecast.zip',
    ]) {
      const response = await fetch(actualBase + file, { method: 'HEAD' });
      assert.equal(response.status, 200, `HTTP resource missing: ${basePath}${file}`);
    }
    const csvFile = 'data/forecast-lab/v4/forward-predictions.csv';
    const response = await fetch(actualBase + csvFile);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(outputDir, csvFile)));
    assert.equal((await fetch(actualBase + 'data/does-not-exist.json')).status, 404);
    assert.equal((await fetch(actualBase, { method: 'POST', body: 'no writes' })).status, 405);
    if (basePath !== '/') {
      assert.equal((await fetch(origin + '/data/forecast-lab/v4/forecast-forward.json')).status, 404);
      assert.equal((await fetch(origin + basePath.slice(0, -1), { redirect: 'manual' })).status, 308);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  assert.equal(normalizeBasePath('/caiso-market-desk'), '/caiso-market-desk/');
  for (const value of ['https://host/', '/../../', '/repo?key=value', '//other/', '/repo\\nested/']) {
    assert.throws(() => normalizeBasePath(value));
  }
  for (const basePath of ['/', '/caiso-market-desk/']) {
    const url = publicUrlFor(basePath);
    assert.equal(url('/data/forecast-lab/v4/report.json'), basePath + 'data/forecast-lab/v4/report.json');
    assert.equal(url(basePath + 'data/forecast-lab/v4/report.json'), basePath + 'data/forecast-lab/v4/report.json');
    assert.equal(url('/#prices/prediction'), basePath + '#prices/prediction');
    assert.equal(url('/data/a%2Fb.json?download=1#section'), basePath + 'data/a%2Fb.json?download=1#section');
    for (const preserved of ['#prices/prediction', './data/file.json', 'https://www.caiso.com/todays-outlook', '//www.caiso.com/source', 'blob:https://example.invalid/id']) {
      assert.equal(url(preserved), preserved);
    }
    await buildSite({ basePath });
    verifySite();
    await checkHttp(basePath);
  }
  console.log('Root and GitHub Pages project paths passed static, data-integrity and HTTP checks.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
