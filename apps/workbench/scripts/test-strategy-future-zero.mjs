import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

// Synthetic accounting fixtures only; no market-performance claims.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/strategy-future-zero-'));
try {
  for (const name of ['time', 'strategy-types', 'strategy-forecast', 'strategy-engine']) {
    const source = await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8');
    const built = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
      .replace(/from ['"]\.\/([^'"]+)['"]/g, (_, dependency) => `from './${dependency}.mjs'`);
    await fs.writeFile(path.join(temporary, `${name}.mjs`), built);
  }
  const {runStrategy} = await import(pathToFileURL(path.join(temporary, 'strategy-engine.mjs')));
  const {DEFAULT_CONFIG, DEFAULT_BASELINE, ENGINE_VERSION} = await import(pathToFileURL(path.join(temporary, 'strategy-types.mjs')));
  const {enumerateHours} = await import(pathToFileURL(path.join(temporary, 'time.mjs')));
  const target = '2026-10-30', hours = enumerateHours(target, target);
  const nodes = DEFAULT_CONFIG.nodes;
  const points = nodes.flatMap(node => hours.map(hour => ({node, startUtc:hour.startUtc, predictedDa:40,
    predictedSpread:0, sigma:10, issuedAt:'2026-10-29T15:00:00.000Z', modelVersion:'synthetic-zero-v1'})));
  const batch = {id:'synthetic-zero', name:'Synthetic zero-signal fixture', createdAt:'2026-10-29T15:01:00.000Z',
    source:'synthetic test', modelVersion:'synthetic-zero-v1', digest:'synthetic', points, warnings:[]};
  const input = {mode:'single', startDate:target, endDate:target, forecastMode:'external', timingPolicy:'recorded',
    cutoffTime:'09:55', baseline:{...DEFAULT_BASELINE}, scenario:{predictedDa:40,predictedSpread:0,sigma:10},
    configs:[{...DEFAULT_CONFIG}], priceArchiveIds:['synthetic-price'], forecastBatchId:batch.id,
    forecasts:batch, actuals:[], generatedAt:'2026-10-29T16:00:00.000Z'};

  // 1. Both a future day and a day still in delivery retain unknown actual outcomes.
  for (const generatedAt of [input.generatedAt,'2026-10-31T06:59:59.999Z']) {
    const result = runStrategy({...input,generatedAt}), plan=result.plans[0], day=plan.days[0];
    assert.equal(result.version, ENGINE_VERSION);
    assert.equal(day.forecastHours,72);
    assert.equal(day.availableActualHours,0);
    assert.equal(day.cells.length,0);
    assert.equal(day.plannedMWh,0);
    assert.equal(day.status,'partial');
    for(const key of ['grossPnl','fees','netPnl']) {
      assert.equal(day[key],null,key);
      assert.equal(plan.metrics[key],null,key);
    }
    assert.equal(plan.metrics.evaluatedDays,0);
    assert.equal(plan.metrics.noSignalDays,0);
    assert.equal(plan.metrics.maxDrawdown,null);
    assert.deepEqual(plan.equity,[{date:target,daily:null,cumulative:null}]);
    assert(day.warnings.some(w => w.includes('冻结运行时点') && w.includes('尚未结束')));
  }
  console.log('PASS: 72 complete forecasts with no future signals keep daily/summary actual PnL and fees null');

  // 2. A completed historical day with full actuals and no signals is a valid zero day.
  const actuals = nodes.flatMap(node => hours.map(hour => ({...hour,node,dam:40,fmm:43,fmmCount:4,paired:true})));
  const completed = runStrategy({...input,actuals,generatedAt:hours.at(-1).endUtc}).plans[0];
  assert.equal(completed.days[0].status,'no_signals');
  for(const key of ['grossPnl','fees','netPnl']) assert.equal(completed.metrics[key],0,key);
  assert.equal(completed.metrics.evaluatedDays,1);
  assert.equal(completed.metrics.noSignalDays,1);
  assert.equal(completed.metrics.actualCoverage,1);
  assert.deepEqual(completed.days[0].cells,runStrategy(input).plans[0].days[0].cells);
  console.log('PASS: ended PT day keeps historical zero-signal PnL at zero; actual data never changes the plan');

  // 3. Replay must use the saved generatedAt even when the wall clock has moved on.
  const saved = runStrategy(input), RealDate=Date;
  try {
    globalThis.Date = class extends RealDate {
      constructor(...args) {super(...(args.length?args:['2040-01-01T00:00:00.000Z']));}
      static now(){return RealDate.parse('2040-01-01T00:00:00.000Z');}
    };
    assert.deepEqual(runStrategy(JSON.parse(JSON.stringify(input))),saved);
  } finally {globalThis.Date=RealDate;}
  console.log('PASS: future zero-signal replay remains identical under a later wall clock');
} finally {await fs.rm(temporary,{recursive:true,force:true});}
