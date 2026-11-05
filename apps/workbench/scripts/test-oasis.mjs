import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/oasis-test-'));
try {
  for (const file of ['types', 'oasis']) {
    const source = await fs.readFile(path.join(root, `lib/${file}.ts`), 'utf8');
    const built = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replace(/from ['"]\.\/types['"]/g, "from './types.mjs'");
    await fs.writeFile(path.join(temporary, `${file}.mjs`), built);
  }
  const mod = await import(pathToFileURL(path.join(temporary, 'oasis.mjs')).href);
  const hours = day => { const w = mod.getQueryWindow(day, day); return (Date.parse(w.endUtc) - Date.parse(w.startUtc)) / 3600000; };
  assert.equal(hours('2026-03-08'), 23);
  assert.equal(hours('2026-11-01'), 25);
  assert.equal(hours('2026-10-27'), 24);
  const first = mod.localTimeParts('2026-11-01T08:00:00Z'), second = mod.localTimeParts('2026-11-01T09:00:00Z');
  assert.equal(first.localHour, '01:00'); assert.equal(second.localHour, '01:00'); assert.notEqual(first.utcOffset, second.utcOffset);
  assert.throws(() => mod.getQueryWindow('2026-02-30', '2026-03-01'), /日期不存在/);
  assert.throws(() => mod.getQueryWindow('2026-10-01', '2026-10-08'), /最多查询/);
  assert.throws(() => mod.validateQuery({ market: 'DAM', startDate: '2026-10-27', endDate: '2026-10-27', nodes: ['https://example.com'] }), /节点代码/);
  console.log('PASS: Pacific date boundaries, DST 23/25 hours, repeated-hour offsets and input limits');

  for (const [market, column, end] of [['DAM', 'MW', '08:00'], ['FMM', 'PRC', '07:15'], ['RTD', 'VALUE', '07:05']]) {
    const header = `INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,NODE,LMP_TYPE,${column},OPR_HR`;
    const row = value => `2026-10-27T07:00:00Z,2026-10-27T${end}:00Z,TEST_NODE,LMP,${value},1`;
    assert.equal(mod.normalizeCsv(`${header}\n${row('-12.5')}`, market)[0].price, -12.5);
    assert.equal(mod.normalizeCsv(`${header}\n${row('0')}`, market)[0].quality, 'ok');
    assert.equal(mod.normalizeCsv(`${header}\n${row('')}`, market)[0].price, null);
    assert.equal(mod.normalizeCsv(`${header}\n${row('')}`, market)[0].quality, 'missing');
    const duplicate = mod.normalizeCsv(`${header}\n${row('10')}\n${row('11')}`, market)[0];
    assert.equal(duplicate.quality, 'conflict'); assert.equal(duplicate.price, null);
    assert.equal(mod.normalizeCsv(`${header}\n${row('10')}\n${row('10')}`, market).length, 1);
  }
  assert.deepEqual(mod.parseCsv('a,b\r\n"hello, world","quote"" test"\r\n"line\nwrap",x'), [['a','b'], ['hello, world','quote" test'], ['line\nwrap','x']]);
  assert.throws(() => mod.decodeOasisArchive(zipSync({ 'error.xml': strToU8('<m:ERR_CODE>1000</m:ERR_CODE><m:ERR_DESC>No data</m:ERR_DESC>') }), 'DAM'), e => e.code === 'NO_DATA');
  console.log('PASS: each market value column, negative/zero/null prices, duplicate conflicts and ZIP XML errors');

  const fixtureDir = path.resolve(root, '../oasis-probe');
  const fixtures = [
    ['DAM', 'dam_20261027_hubs.zip', 72],
    ['FMM', 'RTPD_v3_20261027_hubs.zip', 288],
    ['RTD', 'RTM_v3_20261027_hubs.zip', 864],
  ];
  for (const [market, filename, count] of fixtures) {
    let data;
    try { data = await fs.readFile(path.join(fixtureDir, filename)); } catch { console.log(`SKIP: optional real fixture ${filename}`); continue; }
    const intervals = mod.decodeOasisArchive(new Uint8Array(data), market);
    assert.equal(intervals.length, count);
    assert(intervals.every(row => row.quality === 'ok' && row.price !== null && row.localDate === '2026-10-27'));
    assert(intervals.every(row => ['MCE','MCC','MCL','MGHG'].every(key => typeof row.components[key] === 'number')));
    assert(intervals.every(row => Math.abs(row.price - Object.values(row.components).reduce((a,b) => a+b,0)) < 0.0001));
    console.log(`PASS: real CAISO ${market} fixture, ${count} prices, component identity and local-date alignment`);
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
