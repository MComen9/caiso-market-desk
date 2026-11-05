import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(root, '.sites-runtime'), { recursive: true });
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/fundamentals-test-'));
try {
  const names = ['types', 'oasis', 'data-types', 'fundamentals-types', 'fundamentals'];
  for (const name of names) {
    const source = await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8');
    let built = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const dep of names) built = built.replaceAll(`from './${dep}'`, `from './${dep}.mjs'`);
    await fs.writeFile(path.join(temporary, `${name}.mjs`), built);
  }
  const api = await import(pathToFileURL(path.join(temporary, 'fundamentals.mjs')));
  const { FUNDAMENTAL_IDS } = await import(pathToFileURL(path.join(temporary, 'fundamentals-types.mjs')));
  const date = '2026-10-28', fetched = '2026-10-29T10:00:00Z';
  const start = '2026-10-28T07:00:00-00:00', end = '2026-10-28T08:00:00-00:00';
  const loadHeader = 'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,TAC_AREA_NAME,MW,MARKET_RUN_ID,EXECUTION_TYPE';
  const loads = `${loadHeader}\n${start},${end},CA ISO-TAC,24000,DAM,DAM\n${start},${end},AVA,1000,DAM,DAM\n`;
  const load = api.normalizeFundamentalCsv(loads, 'load_dam', date, fetched);
  assert.equal(load.source, 'oasis');
  assert.equal(load.rows[0].publishTimeUtc, null);
  assert.equal(load.columns.filter(c => c.primary).length, 1);
  assert.equal(load.columns.find(c => c.primary).area, 'CA ISO-TAC');
  assert.equal(load.rows[0].values.load__CA_ISO_TAC, 24000, 'must not sum external BAA load');
  assert.equal(load.rows[0].values.load__AVA, 1000);
  assert.equal(load.status, 'partial', 'one source hour must not be marked complete day');

  const renHeader = 'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,TRADING_HUB,RENEWABLE_TYPE,MW,MARKET_RUN_ID';
  const renRows = [
    `${start},${end},NP15,Solar,100,DAM`, `${start},${end},SP15,Solar,200,DAM`, `${start},${end},ZP26,Solar,-5,DAM`,
    `${start},${end},AVA_,Solar,9000,DAM`,
    `${start},${end},NP15,Wind,0,DAM`, `${start},${end},SP15,Wind,10,DAM`, `${start},${end},ZP26,Wind,,DAM`,
  ];
  const renewables = api.normalizeFundamentalCsv([renHeader, ...renRows].join('\n'), 'renewables_dam', date, fetched);
  assert.equal(renewables.rows[0].values.solar__CAISO, 295, 'only three CAISO hubs; preserve negative measurements');
  assert.equal(renewables.rows[0].values.wind__CAISO, null, 'missing hub must not become zero in an aggregate');
  assert.equal(renewables.rows[0].values.wind__NP15, 0, 'real zero must remain zero');
  const conflict = api.normalizeFundamentalCsv([renHeader, ...renRows, `${start},${end},NP15,Solar,101,DAM`].join('\n'), 'renewables_dam', date);
  assert.equal(conflict.rows[0].values.solar__NP15, null);
  assert.equal(conflict.rows[0].values.solar__CAISO, null);
  assert(conflict.warnings.some(w => w.includes('冲突')));
  const duplicate = api.normalizeFundamentalCsv([renHeader, ...renRows, renRows[0]].join('\n'), 'renewables_dam', date);
  assert.equal(duplicate.rows.length, 1);
  assert.equal(duplicate.rows[0].values.solar__CAISO, 295);
  assert(!duplicate.warnings.some(w => w.includes('冲突')));

  assert.throws(() => api.normalizeFundamentalCsv(loads.replaceAll('-00:00', ''), 'load_dam', date), /UTC/);
  assert.equal(api.normalizeFundamentalCsv(loads, 'load_rtpd', date).status, 'unavailable', 'must filter an unintended market');
  assert.throws(() => api.normalizeFundamentalCsv(loads.replaceAll(',DAM,DAM', ',RTM,RTPD'), 'load_rtpd', date), error => error.code === 'INVALID_INTERVAL');
  assert.throws(() => api.normalizeFundamentalCsv('Time,MW\n00:00,1', 'load_dam', date), /必要字段/);
  const zip = zipSync({ 'report.csv': strToU8(loads) });
  assert.equal(api.decodeFundamentalArchive(zip, 'load_dam', date).rows[0].values.load__CA_ISO_TAC, 24000);
  const xml = zipSync({ 'error.xml': strToU8('<m:ERR><m:ERR_CODE>1000</m:ERR_CODE><m:ERR_DESC>No data</m:ERR_DESC></m:ERR>') });
  assert.throws(() => api.decodeFundamentalArchive(xml, 'load_dam', date), error => error.code === 'NO_DATA');
  assert.throws(() => api.decodeFundamentalArchive(strToU8('<html>maintenance</html>'), 'load_dam', date), error => error.code === 'INVALID_RESPONSE');

  const spring = new URL(api.buildFundamentalUrl('load_dam', '2026-03-08'));
  const fall = new URL(api.buildFundamentalUrl('load_dam', '2026-11-01'));
  assert.equal(spring.searchParams.get('startdatetime'), '20260308T08:00-0000');
  assert.equal(spring.searchParams.get('enddatetime'), '20260309T07:00-0000');
  assert.equal(fall.searchParams.get('startdatetime'), '20261101T07:00-0000');
  assert.equal(fall.searchParams.get('enddatetime'), '20261102T08:00-0000');
  assert.throws(() => api.fundamentalQuery(new URLSearchParams('date=2026-02-30')), /不存在/);
  assert.throws(() => api.fundamentalQuery(new URLSearchParams('feed=unknown')), /不支持/);
  assert.throws(() => api.fundamentalQuery(new URLSearchParams('url=https://example.com')), /不支持参数/);
  assert.throws(() => api.fundamentalQuery(new URLSearchParams('feed=load_dam,load_2da,load_7da,load_actual')), /最多/);
  assert.deepEqual(api.fundamentalQuery(new URLSearchParams(`date=${date}`)).ids, ['load_dam', 'renewables_dam']);
  assert.equal(new URL(api.buildFundamentalUrl('load_rtd', date)).searchParams.get('execution_type'), 'RTD');

  let checked = 0, snapshot;
  try { snapshot = JSON.parse(await fs.readFile(path.join(root, 'data/fundamentals-bootstrap.json'), 'utf8')); } catch {}
  if (snapshot) for (const [day, bundle] of Object.entries(snapshot.byDate)) {
    assert.equal(Object.keys(bundle.feeds).length, FUNDAMENTAL_IDS.length);
    for (const feed of Object.values(bundle.feeds)) {
      const seen = new Set();
      for (const row of feed.rows) {
        const key = row.startUtc + '|' + row.endUtc;
        assert(!seen.has(key), `${day}/${feed.id} duplicate interval`); seen.add(key);
        assert.equal((Date.parse(row.endUtc) - Date.parse(row.startUtc)) / 60000, feed.intervalMinutes);
        assert.equal(row.publishTimeUtc, null, 'must not invent source publication times');
        for (const value of Object.values(row.values)) assert(value === null || Number.isFinite(value));
        if (feed.id.startsWith('renewables')) for (const resource of ['solar', 'wind']) {
          const values = ['NP15', 'SP15', 'ZP26'].map(area => row.values[`${resource}__${area}`]);
          const aggregate = row.values[`${resource}__CAISO`];
          assert.equal(aggregate, values.every(v => typeof v === 'number') ? values.reduce((sum, v) => sum + v, 0) : null);
        }
      }
      checked++;
    }
  }
  if (process.argv.includes('--live')) {
    const live = await api.queryFundamental('load_dam', date);
    assert.equal(live.status, 'ok', JSON.stringify(live.error));
    assert.equal(live.rows.length, 24);
    assert(live.columns.some(column => column.area === 'CA ISO-TAC' && column.primary));
    console.log(`LIVE PASS: load_dam ${date}, ${live.rows.length} intervals, ${live.columns.length} areas, fetched ${live.fetchedAt}`);
  }
  console.log(`PASS: OASIS fundamentals schema, regional scope, null/zero/negative, conflicts, DST, ZIP/XML, query validation; ${checked} snapshot feeds verified.`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
