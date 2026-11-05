const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {
  outputDir, publishedDataDir, downloadsDir, normalizeBasePath, siteUrl,
} = require('./site-config.cjs');

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function verifySite() {
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'site-manifest.json'), 'utf8'));
  const basePath = normalizeBasePath(manifest.basePath);
  const baseOrigin = 'https://static-test.invalid';
  const checkUrl = (value, page = 'index.html') => {
    const target = new URL(value.replaceAll('&amp;', '&'), baseOrigin + basePath + page);
    if (target.origin !== baseOrigin) return;
    assert.ok(target.pathname.startsWith(basePath), `Escaped the Pages project path: ${value}`);
    let local = decodeURIComponent(target.pathname.slice(basePath.length));
    if (!local || local.endsWith('/')) local += 'index.html';
    const file = path.resolve(outputDir, local);
    assert.ok(file.startsWith(outputDir + path.sep), `Outside built site: ${value}`);
    assert.ok(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), `Broken link in ${page}: ${value}`);
  };

  let publishedCount = 0;
  for (const source of filesBelow(publishedDataDir)) {
    const relative = path.relative(publishedDataDir, source);
    const built = path.join(outputDir, 'data', relative);
    assert.ok(fs.existsSync(built), `Missing published data: ${relative}`);
    // This presentation-only wrapper is regenerated for the target base path.
    // Its underlying CSV is still checked byte for byte below and in this loop.
    if (relative.replaceAll(path.sep, '/') !== 'forecast-lab/v4/forecast-csv.html') {
      assert.equal(hash(source), hash(built), `Published data changed while building: ${relative}`);
    }
    publishedCount++;
  }
  for (const source of filesBelow(downloadsDir)) {
    const relative = path.relative(downloadsDir, source);
    assert.equal(hash(source), hash(path.join(outputDir, 'downloads', relative)), `Download changed: ${relative}`);
  }

  let htmlLinkCount = 0;
  for (const page of ['index.html', 'quick-view.html', 'data/forecast-lab/v4/forecast-csv.html']) {
    const html = fs.readFileSync(path.join(outputDir, page), 'utf8');
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      checkUrl(match[1], page); htmlLinkCount++;
    }
  }

  const catalog = JSON.parse(fs.readFileSync(path.join(publishedDataDir, 'data-gaps/catalog.json'), 'utf8'));
  const catalogLinks = [...catalog.downloads, ...catalog.items.flatMap(item => item.downloads)];
  for (const link of catalogLinks) checkUrl(siteUrl(basePath, link.href));
  for (const version of ['', '/v2', '/v3', '/v4']) {
    const report = JSON.parse(fs.readFileSync(path.join(publishedDataDir, `forecast-lab${version}/report.json`), 'utf8'));
    for (const value of Object.values(report.artifacts || {})) if (typeof value === 'string') checkUrl(siteUrl(basePath, value));
  }

  const forecast = JSON.parse(fs.readFileSync(path.join(publishedDataDir, 'forecast-lab/v4/forecast-forward.json'), 'utf8'));
  const quick = fs.readFileSync(path.join(outputDir, 'quick-view.html'), 'utf8');
  const sections = [...quick.matchAll(/<section class="hour"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/g)];
  assert.equal(sections.length, 3, 'Lightweight view lost a hub table.');
  const hourlyRows = sections.reduce((sum, match) => sum + [...match[1].matchAll(/<tr>/g)].length, 0);
  assert.equal(hourlyRows, forecast.points.length, 'Lightweight view lost forecast rows.');
  assert.ok(quick.includes('非实时行情'), 'Snapshot notice missing.');

  const csv = fs.readFileSync(path.join(publishedDataDir, 'forecast-lab/v4/forward-predictions.csv'), 'utf8');
  const csvPage = fs.readFileSync(path.join(outputDir, 'data/forecast-lab/v4/forecast-csv.html'), 'utf8');
  const embeddedCsv = csvPage.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(embeddedCsv, csv, 'CSV view did not preserve exact source text.');
  assert.equal(csv.trim().split(/\r?\n/).length - 1, forecast.points.length);
  assert.ok(fs.existsSync(path.join(outputDir, '.nojekyll')), 'Pages output must disable Jekyll.');
  const totalBytes = filesBelow(outputDir).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.ok(totalBytes < 1_000_000_000, 'Built site exceeds the 1 GB Pages publishing limit.');

  const summary = { basePath, publishedCount, catalogDownloads: catalogLinks.length, htmlLinks: htmlLinkCount, forecastRows: forecast.points.length, totalBytes };
  console.log(JSON.stringify(summary));
  return summary;
}

module.exports = { verifySite };
if (require.main === module) {
  try { verifySite(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
