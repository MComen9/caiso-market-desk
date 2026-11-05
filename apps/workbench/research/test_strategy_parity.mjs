import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

// Synthetic inputs only: compare maintained Python implementation with the Site engine.
const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(root, '.sites-runtime'), {recursive: true});
const temp = await fs.mkdtemp(path.join(root, '.sites-runtime/python-parity-'));
async function compile(name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  let code = ts.transpileModule(await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const deps = [...code.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map(m => m[1]);
  code = code.replace(/from ['"]\.\/([^'"]+)['"]/g, (_, d) => `from './${d}.mjs'`);
  await fs.writeFile(path.join(temp, `${name}.mjs`), code);
  for (const dep of deps) await compile(dep, seen);
}
try {
  await compile('strategy-engine');
  await compile('strategy-types');
  const {runStrategy} = await import(pathToFileURL(path.join(temp, 'strategy-engine.mjs')));
  const {DEFAULT_CONFIG, DEFAULT_BASELINE} = await import(pathToFileURL(path.join(temp, 'strategy-types.mjs')));
  // Generate first with: python research/test_strategy_bridge.py --export-parity
  const cases = JSON.parse(await fs.readFile(path.join(root,'.sites-runtime/python-parity-fixture.json'),'utf8'));
  const close = (a,b,label) => a === null || b === null ? assert.equal(a,b,label) : assert.ok(Math.abs(a-b) < 1e-7, `${label}: ${a} vs ${b}`);
  for (const test of cases) {
    const bundle = {...test.bundle, id: 'synthetic-forecast', name: 'SYNTHETIC PARITY ONLY', source: 'synthetic-test', createdAt: '2026-10-19T16:00:00Z', warnings: []};
    const input = {mode: 'single', startDate: '2026-10-20', endDate: '2026-10-20', forecastMode: 'external', timingPolicy: 'declared', cutoffTime: '09:55', baseline: DEFAULT_BASELINE, scenario: {predictedDa: 40, predictedSpread: 5, sigma: 8},
      configs: [{...DEFAULT_CONFIG, strategy: test.strategy, feePerMWh: 1}], priceArchiveIds: ['synthetic-prices'], forecastBatchId: bundle.id, actuals: test.actuals, forecasts: bundle, generatedAt: bundle.generatedAt};
    const js = runStrategy(input).plans[0].days[0], py = test.python;
    const label = `${test.strategy}/${test.variant}`;
    assert.equal(js.status, py.status, label);
    for (const [j,p] of [['plannedMWh','gross'],['filledMWh','filled'],['settledMWh','settledMWh'],['netPnl','pnl'],['fees','fees'],['expectedPnl','expected']]) close(js[j],py[p],`${label} ${j}`);
    assert.equal(js.cells.length,py.rows.length,label);
    js.cells.forEach((c,i) => {
      const r=py.rows[i];
      assert.equal(c.node,r.n,label); assert.equal(c.startUtc,r.startUtc,label); assert.equal(c.side,r.side,label); assert.equal(c.status,r.status,label);
      close(c.quote,r.quote,label); close(c.mwh,r.qty,label); close(c.netPnl,r.pnl,label);
    });
  }
  console.log(`PASS Python / TypeScript strategy parity: ${cases.length} synthetic combinations, plans and outcomes agree.`);
} finally { await fs.rm(temp,{recursive:true,force:true}); }
