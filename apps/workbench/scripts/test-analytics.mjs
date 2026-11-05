import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/analytics-test-'));
try {
  for (const file of ['time', 'analytics']) {
    const source = await fs.readFile(path.join(root, `lib/${file}.ts`), 'utf8');
    const built = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
      .replace(/from ['"]\.\/time['"]/g, "from './time.mjs'");
    await fs.writeFile(path.join(temporary, `${file}.mjs`), built);
  }
  const {buildHourlyRows, mean} = await import(pathToFileURL(path.join(temporary, 'analytics.mjs')).href);
  const {enumerateHours} = await import(pathToFileURL(path.join(temporary, 'time.mjs')).href);
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'data/bootstrap.json'), 'utf8'));
  const node = 'TH_NP15_GEN-APND', day = '2026-10-27';
  const rows = buildHourlyRows(fixture.markets, node, day, day);
  assert.equal(rows.length, 24);
  assert(rows.every(r => r.paired && r.fmmCount === 4 && r.rtdCount === 12 && r.quality === 'complete'));
  assert(Math.abs(mean(rows.map(r => r.dam)) - 43.41931375) < 1e-8);
  assert(Math.abs(mean(rows.map(r => r.fmm)) - 40.445479375) < 1e-8);
  assert(Math.abs(mean(rows.map(r => r.spread)) - (-2.973834375)) < 1e-8);
  console.log('PASS: actual NP15 daily/hourly means and paired FMM−DA spreads');

  const missing = structuredClone(fixture.markets);
  const first = rows[0].startUtc;
  missing.FMM.intervals = missing.FMM.intervals.filter(r => !(r.node === node && r.startUtc === first));
  const incomplete = buildHourlyRows(missing, node, day, day)[0];
  assert.equal(incomplete.fmmCount, 3); assert.equal(incomplete.fmm, null);
  assert.equal(incomplete.spread, null); assert.equal(incomplete.paired, false);
  console.log('PASS: one missing quarter-hour prevents FMM hourly average and paired spread');

  const duplicate = structuredClone(fixture.markets);
  duplicate.FMM.intervals.push(duplicate.FMM.intervals.find(r => r.node === node && r.startUtc === first));
  assert.equal(buildHourlyRows(duplicate, node, day, day)[0].fmm, null);
  const zero = structuredClone(fixture.markets);
  zero.DAM.intervals.find(r => r.node === node && r.startUtc === first).price = 0;
  const zeroRow = buildHourlyRows(zero, node, day, day)[0];
  assert.equal(zeroRow.dam, 0); assert.equal(zeroRow.spread, zeroRow.fmm);
  assert.equal(mean([null, undefined]), null); assert.equal(mean([0, -10, null]), -5);
  console.log('PASS: duplicate timestamps do not fake completeness; valid zero and negative prices remain valid');

  assert.equal(enumerateHours('2026-03-08','2026-03-08').length, 23);
  const fall = buildHourlyRows({},node,'2026-11-01','2026-11-01');
  assert.equal(fall.length, 25);
  const repeated = fall.filter(r => r.localHour === '01:00');
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].startUtc,repeated[1].startUtc);
  assert.notEqual(repeated[0].utcOffset,repeated[1].utcOffset);
  assert(fall.every(r => r.dam === null && r.fmm === null && r.spread === null));
  console.log('PASS: 23/25-hour dates and repeated Pacific hours retain unique UTC keys');
} finally { await fs.rm(temporary, {recursive:true, force:true}); }
