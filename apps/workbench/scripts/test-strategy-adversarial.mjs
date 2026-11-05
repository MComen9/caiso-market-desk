import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import ts from 'typescript';

// Synthetic fixtures only. These tests verify accounting/time behavior, not market returns.
const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(root, '.sites-runtime'), {recursive: true});
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/strategy-adversarial-'));
let passed = 0;

async function compile(name, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8');
  let built = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const dependencies = [...built.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map(match => match[1]);
  built = built.replace(/from ['"]\.\/([^'"]+)['"]/g, (_, module) => `from './${module}.mjs'`);
  await fs.writeFile(path.join(temporary, `${name}.mjs`), built);
  for (const dependency of dependencies) await compile(dependency, seen);
}

try {
  await compile('strategy-engine');
  await compile('strategy-types');
  await compile('time');
  const {runStrategy, decisionAsOf, validateStrategyRequest} = await import(pathToFileURL(path.join(temporary, 'strategy-engine.mjs')).href);
  const {DEFAULT_CONFIG, DEFAULT_BASELINE} = await import(pathToFileURL(path.join(temporary, 'strategy-types.mjs')).href);
  const {enumerateHours, addDays} = await import(pathToFileURL(path.join(temporary, 'time.mjs')).href);
  const A = 'TH_NP15_GEN-APND', B = 'TH_SP15_GEN-APND', C = 'TH_ZP26_GEN-APND';
  const UNKNOWN = 'TH_UNKNOWN_GEN-APND';
  const target = '2026-10-28';
  const generatedAt = '2026-10-29T12:00:00.000Z';
  const config = changes => ({...structuredClone(DEFAULT_CONFIG), nodes: [A], nodeCount: 1,
    totalMWh: 24, perCellMWh: 1, perNodeMWh: 24, maxCells: 24, k: 0,
    quoteOffset: 20, ...changes});
  const actual = (start, end, nodes = [A]) => nodes.flatMap((node, ni) => enumerateHours(start, end).map((h, i) => {
    const dayIndex = Math.round((Date.parse(h.localDate) - Date.parse(start)) / 86400000);
    const hour = Number(h.localHour.slice(0, 2));
    const dam = 40 + ni + dayIndex / 10 + hour / 5;
    const spread = 5 + dayIndex % 3 + hour / 20;
    return {...h, node, dam, fmm: dam + spread, fmmCount: 4, paired: true};
  }));
  const fixture = actual('2026-10-01', target, [A, B, C]);
  const request = changes => ({mode: 'single', startDate: target, endDate: target,
    forecastMode: 'scenario', timingPolicy: 'declared', cutoffTime: '09:55',
    baseline: {...DEFAULT_BASELINE}, scenario: {predictedDa: 50, predictedSpread: 10, sigma: 2},
    configs: [config()], priceArchiveIds: ['synthetic-price-archive'], forecastBatchId: 'synthetic-forecast-1',
    actuals: structuredClone(fixture), generatedAt, ...changes});
  const run = changes => runStrategy(request(changes));
  const day = result => result.plans[0].days[0];
  const planOnly = result => result.plans.map(plan => plan.days.map(d => ({date: d.date,
    decisionAsOfUtc: d.decisionAsOfUtc, selectedNodes: d.selectedNodes,
    plannedMWh: d.plannedMWh, unallocatedMWh: d.unallocatedMWh,
    cells: d.cells.map(c => ({node: c.node, startUtc: c.startUtc, endUtc: c.endUtc,
      side: c.side, quote: c.quote, mwh: c.mwh, predictedDa: c.predictedDa,
      predictedSpread: c.predictedSpread, sigma: c.sigma, forecastIssuedAt: c.forecastIssuedAt,
      forecastModel: c.forecastModel, sampleCount: c.sampleCount, trainingEndUtc: c.trainingEndUtc}))})));
  const test = (name, check) => {check(); passed++; console.log(`PASS: ${name}`);};
  const external = (date = target) => ({id: 'synthetic-forecast-1', name: 'Synthetic forecast fixture',
    createdAt: `${addDays(date, -2)}T12:00:00.000Z`, source: 'synthetic-test', modelVersion: 'synthetic-v1',
    digest: 'synthetic-not-a-production-digest', warnings: [],
    points: enumerateHours(date, date).map(h => ({node: A, startUtc: h.startUtc,
      predictedDa: 50, predictedSpread: 10, sigma: 2,
      issuedAt: `${addDays(date, -1)}T16:00:00.000Z`, modelVersion: 'synthetic-v1'}))});

  test('Pacific decision cutoffs honor DST on the decision date', () => {
    assert.equal(decisionAsOf('2026-11-01', '09:55'), '2026-10-31T16:55:00.000Z');
    assert.equal(decisionAsOf('2026-11-02', '09:55'), '2026-11-01T17:55:00.000Z');
    assert.equal(decisionAsOf('2026-03-09', '09:55'), '2026-03-08T16:55:00.000Z');
  });

  test('23/25-hour days allocate distinct UTC intervals including both fall-back hours', () => {
    for (const [date, expected] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
      const d = day(run({startDate: date, endDate: date, actuals: actual(date, date),
        configs: [config({totalMWh: 30, perNodeMWh: 30, maxCells: 30})]}));
      assert.equal(d.expectedHours, expected);
      assert.equal(d.cells.length, expected);
      assert.equal(new Set(d.cells.map(c => c.startUtc)).size, expected);
      if (expected === 25) {
        const folds = d.cells.filter(c => c.localHour === '01:00');
        assert.equal(folds.length, 2);
        assert.notEqual(folds[0].utcOffset, folds[1].utcOffset);
      }
    }
  });

  test('changing target-day prices, including null and zero, cannot change the generated plan', () => {
    const original = run({forecastMode: 'baseline'});
    assert(day(original).cells.length > 0, 'fixture must produce a nonempty plan');
    const altered = structuredClone(fixture).map((r, index) => r.localDate === target ? {...r,
      dam: index % 2 ? null : 0, fmm: index % 2 ? 900 : 0,
      fmmCount: index % 2 ? 3 : 4, paired: index % 2 === 0} : r);
    assert.deepEqual(planOnly(run({forecastMode: 'baseline', actuals: altered})), planOnly(original));
  });

  test('future actual prices cannot affect earlier walk-forward forecasts or outcomes', () => {
    const end = '2026-10-25';
    const opts = {mode: 'backtest', forecastMode: 'baseline', startDate: '2026-10-20', endDate: end};
    const first = run(opts);
    const altered = structuredClone(fixture).map(r => r.localDate > end
      ? {...r, dam: -9999, fmm: 9999, paired: true} : r);
    assert.deepEqual(run({...opts, actuals: altered}).plans, first.plans);
  });

  test('missing DA never becomes zero or fabricates profit; partial results stay incomplete', () => {
    const rows = actual(target, target);
    rows[0] = {...rows[0], dam: null, fmm: 100, paired: false};
    const result = run({actuals: rows});
    const d = day(result), missing = d.cells.find(c => c.startUtc === rows[0].startUtc);
    assert(missing, 'missing actual must not erase its planned allocation');
    assert.equal(missing.status, 'missing_actual');
    assert.equal(missing.actualDa, null);
    assert.equal(missing.netPnl, null);
    assert.equal(d.netPnl, null);
    assert.equal(d.status, 'partial');
    assert.equal(result.plans[0].metrics.netPnl, null);
    assert(d.plannedMWh > d.settledMWh);
  });

  test('all missing actuals do not masquerade as a fully evaluated zero-profit run', () => {
    const d = day(run({actuals: []}));
    assert.equal(d.cells.length, 24);
    assert.equal(d.netPnl, null);
    assert.equal(d.settledMWh, 0);
    assert.equal(d.status, 'partial');
    assert(d.cells.every(c => c.netPnl === null));
  });

  test('genuine zero and negative prices remain valid observations', () => {
    const rows = actual(target, target).map((r, i) => ({...r, dam: i % 2 ? -20 : 0,
      fmm: i % 2 ? -10 : 0, paired: true}));
    const d = day(run({actuals: rows}));
    assert.equal(d.cells.length, 24);
    assert(d.cells.every(c => c.status === 'filled'));
    assert.equal(d.cells.filter(c => c.actualDa === 0).length, 12);
    assert.equal(d.netPnl, 120);
  });

  test('incomplete FMM hours remain unavailable even if a supplied average is numeric', () => {
    const rows = actual(target, target);
    rows[0] = {...rows[0], fmmCount: 3, paired: false};
    const d = day(run({actuals: rows}));
    assert.equal(d.cells.find(c => c.startUtc === rows[0].startUtc)?.status, 'missing_actual');
    assert.equal(d.netPnl, null);
  });

  test('latest forecast before the cutoff is used; post-cutoff revisions are excluded', () => {
    const forecasts = external();
    const old = structuredClone(forecasts.points);
    forecasts.points.push(...old.map(p => ({...p, predictedSpread: 500,
      issuedAt: '2026-10-27T16:55:00.001Z', modelVersion: 'late-revision'})));
    const d = day(run({forecastMode: 'external', forecasts}));
    assert.equal(d.cells.length, 24);
    assert(d.cells.every(c => c.predictedSpread === 10 && c.forecastModel === 'synthetic-v1'));
    const eligibleRevision = old.map(p => ({...p, predictedSpread: 12,
      issuedAt: '2026-10-27T16:54:00.000Z', modelVersion: 'eligible-revision'}));
    forecasts.points.push(...eligibleRevision);
    const latest = day(run({forecastMode: 'external', forecasts}));
    assert(latest.cells.every(c => c.predictedSpread === 12 && c.forecastModel === 'eligible-revision'));
  });

  test('strict recorded policy excludes retrospectively imported forecasts', () => {
    const forecasts = external();
    forecasts.createdAt = generatedAt;
    const declared = day(run({forecastMode: 'external', forecasts, timingPolicy: 'declared'}));
    assert(declared.cells.length > 0);
    const recorded = day(run({forecastMode: 'external', forecasts, timingPolicy: 'recorded'}));
    assert.equal(recorded.cells.length, 0);
    assert.equal(recorded.status, 'no_forecast');
  });

  test('strict archive cutoff compares instants rather than raw timezone-bearing strings', () => {
    const forecasts = external();
    // 10:00 PDT is 17:00Z, five minutes after the 16:55Z decision cutoff.
    forecasts.createdAt = '2026-10-27T10:00:00-07:00';
    const d = day(run({forecastMode: 'external', forecasts, timingPolicy: 'recorded'}));
    assert.equal(d.cells.length, 0);
    assert.equal(d.status, 'no_forecast');
  });

  test('forecasts entirely after the decision cutoff produce an explicit no-forecast day', () => {
    const forecasts = external();
    forecasts.points = forecasts.points.map(p => ({...p, issuedAt: '2026-10-27T17:00:00.000Z'}));
    const d = day(run({forecastMode: 'external', forecasts}));
    assert.equal(d.cells.length, 0);
    assert.equal(d.status, 'no_forecast');
    assert.equal(d.forecastHours, 0);
  });

  test('allocation honors daily, node, cell, count, and minimum segment constraints', () => {
    const cfg = config({nodes: [A, B, C], nodeCount: 3, totalMWh: 10.5,
      perCellMWh: 2, perNodeMWh: 3, maxCells: 9});
    const d = day(run({configs: [cfg]}));
    assert(d.plannedMWh <= 9 + 1e-9);
    assert(d.cells.length <= cfg.maxCells);
    assert(d.cells.every(c => c.mwh >= 1 - 1e-9 && c.mwh <= cfg.perCellMWh + 1e-9));
    for (const node of cfg.nodes) assert(d.cells.filter(c => c.node === node).reduce((s, c) => s + c.mwh, 0) <= cfg.perNodeMWh + 1e-9);
    assert(Math.abs(d.unallocatedMWh + d.plannedMWh - cfg.totalMWh) < 1e-8);
    const remainder = day(run({configs: [config({totalMWh: 2.5})]}));
    assert.equal(remainder.plannedMWh, 2);
    assert.equal(remainder.unallocatedMWh, 0.5);
    const half = day(run({configs: [config({strategy: 'half', totalMWh: 3, perCellMWh: 2})]}));
    assert(half.plannedMWh <= 1.5 + 1e-9);
    assert(half.cells.every(c => c.mwh >= 1 - 1e-9));
  });

  test('ranked selection never backfills unknown nodes or relaxes EV thresholds', () => {
    const ranked = config({nodes: [A, UNKNOWN], nodeCount: 2, selection: 'ranked',
      minNodeSamples: 3, minWinRate: 50, minEv: 0});
    const d = day(run({forecastMode: 'baseline', configs: [ranked]}));
    assert(!d.selectedNodes.includes(UNKNOWN));
    assert(d.nodeStats.some(n => n.node === UNKNOWN && !n.selected));
    const strict = day(run({forecastMode: 'baseline', configs: [{...ranked, minEv: 10000}]}));
    assert.equal(strict.selectedNodes.length, 0);
    assert.equal(strict.cells.length, 0);
  });

  test('same local hour repeated at DST does not count as an extra training day', () => {
    const date = '2026-11-03';
    const rows = actual('2026-10-31', '2026-11-01').filter(r => r.localHour === '01:00');
    assert.equal(rows.length, 3, 'two dates, one with two 01:00 intervals');
    const d = day(run({startDate: date, endDate: date, forecastMode: 'baseline', actuals: rows,
      baseline: {...DEFAULT_BASELINE, minSamples: 3}, generatedAt: '2026-11-04T12:00:00.000Z'}));
    assert.equal(d.forecastHours, 0);
    assert.equal(d.cells.length, 0);
  });

  test('invalid configuration values are rejected before computation', () => {
    for (const changes of [
      {configs: [config({totalMWh: -1})]},
      {configs: [config({perCellMWh: 0.5})]},
      {configs: [config({k: Number.NaN})]},
      {cutoffTime: '10:01'},
      {startDate: '2026-02-30', endDate: '2026-02-30'},
      {baseline: {...DEFAULT_BASELINE, lagDays: 1}},
    ]) assert.throws(() => validateStrategyRequest(request(changes)));
  });

  test('zero/missing sigma with a positive gate never becomes an artificial usable signal', () => {
    for (const sigma of [null, 0]) {
      const d = day(run({scenario: {predictedDa: 50, predictedSpread: 10, sigma},
        configs: [config({k: 1})]}));
      assert.equal(d.cells.length, 0);
    }
  });

  test('tie handling and fee assumptions affect evaluation transparently', () => {
    const rows = actual(target, target).map(r => ({...r, dam: 50, fmm: 60}));
    const cfg = config({quoteOffset: 0, feePerMWh: 2, tieFill: false});
    const excluded = day(run({actuals: rows, configs: [cfg]}));
    assert(excluded.cells.every(c => c.status === 'tie_excluded'));
    assert.equal(excluded.filledMWh, 0);
    const included = day(run({actuals: rows, configs: [{...cfg, tieFill: true}]}));
    assert.equal(included.grossPnl, 240);
    assert.equal(included.fees, 48);
    assert.equal(included.netPnl, 192);
  });

  test('assumed tie fills remain filled but unsettled when FMM is missing', () => {
    const rows = actual(target, target).map(r => ({...r, dam: 50, fmm: null, fmmCount: 3, paired: false}));
    const d = day(run({actuals: rows, configs: [config({quoteOffset: 0, tieFill: true})]}));
    assert(d.cells.every(c => c.status === 'missing_actual'));
    assert.equal(d.filledMWh, d.plannedMWh);
    assert.equal(d.settledMWh, 0);
    assert.equal(d.netPnl, null);
  });

  test('same immutable inputs and settings reproduce identical results', () => {
    const input = request({mode: 'backtest', forecastMode: 'baseline', startDate: '2026-10-20',
      configs: [config(), config({name: '方案 B', strategy: 'high_conf', k: 1.5})]});
    const before = structuredClone(input);
    assert.deepEqual(runStrategy(input), runStrategy(structuredClone(input)));
    assert.deepEqual(input, before, 'engine must not mutate input');
  });

  console.log(`All ${passed} independent adversarial checks passed (synthetic fixtures only).`);
} finally {
  await fs.rm(temporary, {recursive: true, force: true});
}
