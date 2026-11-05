import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(root, '.sites-runtime'), {recursive: true});
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/strategy-engine-test-'));
try {
  for (const name of ['time', 'strategy-types', 'strategy-forecast', 'strategy-engine']) {
    const source = await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8');
    const output = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]\.\/([^'"]+)['"]/g, (_, dependency) => `from './${dependency}.mjs'`);
    await fs.writeFile(path.join(temporary, `${name}.mjs`), output);
  }
  const {parseForecastImport, normalizeForecastPoints} = await import(pathToFileURL(path.join(temporary, 'strategy-forecast.mjs')));
  const {runStrategy} = await import(pathToFileURL(path.join(temporary, 'strategy-engine.mjs')));
  const {DEFAULT_CONFIG, DEFAULT_BASELINE} = await import(pathToFileURL(path.join(temporary, 'strategy-types.mjs')));
  const metadata = {name: 'Synthetic import verification', source: 'Synthetic test fixture, not a production forecast', modelVersion: 'fixture-v1'};
  const generatedAt = '2026-10-29T12:00:00.000Z';
  const header = 'node,startUtc,predictedDa,predictedSpread,sigma,issuedAt,modelVersion';
  const line = 'TH_NP15_GEN-APND,2026-10-28T00:00:00-07:00,-10,0,,2026-10-27T09:00:00-07:00,fixture-v1';
  const valid = parseForecastImport(`\uFEFF${header}\r\n${line}\r\n`, metadata, generatedAt);
  assert.equal(valid.points[0].startUtc, '2026-10-28T07:00:00.000Z');
  assert.equal(valid.points[0].issuedAt, '2026-10-27T16:00:00.000Z');
  assert.equal(valid.points[0].predictedDa, -10); assert.equal(valid.points[0].predictedSpread, 0); assert.equal(valid.points[0].sigma, null);
  assert(valid.warnings.some(warning => warning.includes('sigma')));
  console.log('PASS: CSV import preserves negative/zero values, optional sigma and explicit timezone instants');

  for (const text of [
    `${header}\n${line}\n${line}`,
    `${header}\n${line.replace('2026-10-28T00:00:00-07:00', '2026-10-28T00:00:00')}`,
    `${header}\n${line.replace('2026-10-28T00:00:00-07:00', '2026-02-30T00:00:00-07:00')}`,
    `${header}\n${line.replace('2026-10-28T00:00:00-07:00', '2026-10-28T00:15:00-07:00')}`,
    `${header}\n${line.replace(',-10,0,', ',NaN,0,')}`,
    `${header}\n${line.replace(',-10,0,', ',,0,')}`,
    `${header}\n${line.replace('2026-10-27T09:00:00-07:00', '2026-10-29T09:00:00-07:00')}`,
    `node,startUtc\nA,B`,
    `${header}\n"TH_NP15_GEN-APND"garbage,2026-10-28T07:00:00Z,40,5,2,2026-10-27T15:00:00Z,v1`,
  ]) assert.throws(() => parseForecastImport(text, metadata, generatedAt));
  console.log('PASS: malformed CSV, duplicate versions, ambiguous times, invalid dates/prices and hindsight timestamps reject');

  const basePoint = {...valid.points[0], sigma: 2};
  const nextPoint = {...basePoint, issuedAt: '2026-10-27T16:30:00.000Z', modelVersion: 'fixture-v2', predictedSpread: 8};
  const jsonImport = parseForecastImport(JSON.stringify({points: [nextPoint, basePoint]}), metadata, generatedAt);
  assert.equal(jsonImport.points.length, 2);
  assert.equal(jsonImport.points[0].modelVersion, 'fixture-v1');
  assert.throws(() => normalizeForecastPoints([{...basePoint, trainingEndUtc: '2026-10-27T16:01:00.000Z'}]));
  assert.throws(() => normalizeForecastPoints([{...basePoint, sigma: -1}]));
  assert.throws(() => parseForecastImport(JSON.stringify([{...basePoint, issuedAt: '2026-10-29T13:00:00.000Z', startUtc: '2026-10-30T07:00:00.000Z'}]), metadata, generatedAt));
  const provenance = normalizeForecastPoints([{...basePoint, trainingEndUtc: '2026-10-27T15:00:00.000Z', sampleCount: 24}])[0];
  assert.equal(provenance.sampleCount, 24);
  console.log('PASS: JSON supports multiple issued versions and rejects impossible training/issuance provenance');

  const archive = JSON.parse(await fs.readFile(path.join(root, 'data/strategy-bootstrap.json'), 'utf8'));
  const input = {
    mode: 'backtest', startDate: '2026-10-26', endDate: '2026-10-28', forecastMode: 'baseline', timingPolicy: 'declared', cutoffTime: '09:55',
    baseline: {...DEFAULT_BASELINE}, scenario: {predictedDa: 40, predictedSpread: 5, sigma: 8},
    configs: [{...DEFAULT_CONFIG, nodes: archive.nodes, k: 0, totalMWh: 150, perCellMWh: 1, perNodeMWh: 50, maxCells: 150}],
    priceArchiveIds: [archive.id], actuals: archive.rows, generatedAt,
  };
  const started = performance.now();
  const result = runStrategy(input), elapsed = performance.now() - started;
  const plan = result.plans[0];
  assert.equal(plan.days.length, 3); assert(plan.days.every(day => day.status === 'complete'));
  assert.equal(plan.metrics.forecastCoverage, 1); assert.equal(plan.metrics.actualCoverage, 1);
  const lastDay = plan.days.at(-1), cell = lastDay.cells.find(cell => cell.node === archive.nodes[0] && cell.localHour === '00:00');
  assert(cell);
  const training = archive.rows.filter(row => row.node === cell.node && row.localHour === cell.localHour && row.localDate <= '2026-10-26');
  assert.equal(training.length, 5); assert.equal(cell.sampleCount, 5);
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const spreads = training.map(row => row.fmm - row.dam), predictedSpread = mean(spreads);
  assert(Math.abs(cell.predictedDa - mean(training.map(row => row.dam))) < 1e-10);
  assert(Math.abs(cell.predictedSpread - predictedSpread) < 1e-10);
  assert(Math.abs(cell.sigma - Math.sqrt(spreads.reduce((total, value) => total + (value - predictedSpread) ** 2, 0) / 4)) < 1e-10);
  assert.equal(cell.forecastIssuedAt, generatedAt);
  assert(cell.trainingEndUtc <= lastDay.decisionAsOfUtc);
  assert(result.timingLabel.includes('重建'));
  console.log(`PASS: verified OASIS snapshot produces chronological baseline with independently checked means/sample SD (${elapsed.toFixed(0)} ms)`);

  const withFees = runStrategy({...input, configs: [{...input.configs[0], feePerMWh: 1.5}]}).plans[0];
  assert.equal(withFees.metrics.grossPnl, plan.metrics.grossPnl);
  assert.equal(withFees.metrics.expectedPnl, plan.metrics.expectedPnl);
  assert(Math.abs(withFees.metrics.netPnl - (plan.metrics.netPnl - 1.5 * plan.metrics.settledMWh)) < 1e-7);
  assert(!Object.hasOwn(withFees.metrics, 'sharpe'));
  assert(withFees.metrics.maxDrawdown >= 0);
  console.log('PASS: explicit per-filled-MWh cost changes net results only; metrics omit unsupported annualized Sharpe');

  const partialForecasts = runStrategy({...input, startDate: '2026-10-22'}).plans[0];
  assert.equal(partialForecasts.metrics.incompleteDays, 4);
  assert.equal(partialForecasts.metrics.evaluatedDays, 3);
  assert.equal(partialForecasts.metrics.netPnl, plan.metrics.netPnl);
  assert(partialForecasts.equity.slice(0, 4).every(point => point.daily === null && point.cumulative === null));
  console.log('PASS: warmup dates remain missing and cannot inflate evaluated days or become zero-profit observations');
} finally {
  await fs.rm(temporary, {recursive: true, force: true});
}
