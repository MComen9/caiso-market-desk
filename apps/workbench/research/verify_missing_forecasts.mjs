// Independent full-value QA: raw public ZIPs -> established TypeScript normalizer.
// Never imports the new Python builder or changes a frozen forecast/model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { unzipSync, strFromU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.sites-runtime/gap-acquisition');
const target = path.join(root, 'public/data/data-gaps/official-forecast-history-180d.json.gz');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tmp = await fs.mkdtemp(path.join(root, '.sites-runtime/missing-forecast-verify-'));
const output = path.join(root, 'public/data/data-gaps/forecast-history-verification.json');

try {
  const names = ['types', 'oasis', 'data-types', 'fundamentals-types', 'fundamentals'];
  for (const name of names) {
    let code = ts.transpileModule(await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const dep of names) code = code.replaceAll(`from './${dep}'`, `from './${dep}.mjs'`);
    await fs.writeFile(path.join(tmp, `${name}.mjs`), code);
  }
  const { normalizeFundamentalCsv } = await import(pathToFileURL(path.join(tmp, 'fundamentals.mjs')));
  const { parseCsv, localTimeParts } = await import(pathToFileURL(path.join(tmp, 'oasis.mjs')));
  const rawTarget = await fs.readFile(target);
  const archive = JSON.parse(gunzipSync(rawTarget).toString('utf8'));
  assert.equal(archive.schemaVersion, 1);
  assert.equal(archive.dataset, 'official-forecast-history-180d');
  assert.equal(archive.startDate, '2026-05-02');
  assert.equal(archive.endDate, '2026-10-28');
  assert.equal(archive.unit, 'MW');
  assert.equal(archive.timeZone, 'America/Los_Angeles');
  assert.equal(archive.intervalMinutes, 60);
  assert.equal(archive.rows.length, 4320);
  assert.equal(archive.classification, 'historical_forecast_values_current_vintage');
  assert.equal(archive.modelStatus, 'not_integrated');
  assert.equal(archive.causalReplayApproved, false);
  assert.equal(archive.publishTimeAvailable, false);
  const expectedFields = ['startUtc', 'endUtc', 'localDate', 'localHour', 'utcOffset',
    'loadDamMw', 'load2daMw', 'load7daMw', 'solarNp15Mw', 'solarSp15Mw', 'solarZp26Mw',
    'windNp15Mw', 'windSp15Mw', 'windZp26Mw', 'solarCaisoMw', 'windCaisoMw', 'netLoadDamMw', 'publishTimeUtc'];
  assert.deepEqual(archive.fields, expectedFields);
  const values = new Map();
  const independentNetLoadInputs = new Map();
  const numericFields = expectedFields.slice(5, 17);
  const derivedFields = new Set(['solarCaisoMw', 'windCaisoMw', 'netLoadDamMw']);
  const derivedTolerance = 1e-9;
  const stats = Object.fromEntries(numericFields.map(field => [field, { compared: 0, missing: 0, negative: 0, zero: 0, exactComparisons: 0, maximumAbsoluteDifferenceMw: 0 }]));
  let previousEnd = '2026-05-02T07:00:00.000Z';
  for (const input of archive.rows) {
    assert.equal(input.length, expectedFields.length);
    const row = Object.fromEntries(expectedFields.map((field, i) => [field, input[i]]));
    assert(!values.has(row.startUtc), 'Duplicate target UTC hour');
    assert.equal(row.startUtc, previousEnd, 'Missing or overlapping target hour');
    assert.equal(Date.parse(row.endUtc) - Date.parse(row.startUtc), 3600000);
    const local = localTimeParts(row.startUtc);
    for (const field of ['localDate', 'localHour', 'utcOffset']) assert.equal(row[field], local[field]);
    assert.equal(row.publishTimeUtc, null);
    for (const field of numericFields) {
      assert(row[field] === null || Number.isFinite(row[field]), 'Nonfinite data cell');
      if (row[field] === null) stats[field].missing++;
      else { if (row[field] < 0) stats[field].negative++; if (row[field] === 0) stats[field].zero++; }
    }
    values.set(row.startUtc, row);
    previousEnd = row.endUtc;
  }
  assert.equal(previousEnd, '2026-10-29T07:00:00.000Z');
  const compare = (row, field, actual) => {
    if (row[field] === null || actual === null || !derivedFields.has(field)) {
      assert.equal(row[field], actual, `${row.startUtc}: ${field} does not match the existing normalizer`);
    } else {
      const difference = Math.abs(row[field] - actual);
      stats[field].maximumAbsoluteDifferenceMw = Math.max(stats[field].maximumAbsoluteDifferenceMw, difference);
      assert(difference <= derivedTolerance, `${row.startUtc}: ${field} exceeds the derived-value tolerance`);
    }
    stats[field].exactComparisons += row[field] === actual ? 1 : 0;
    stats[field].compared++;
  };
  const configs = [
    { id: 'load_dam', market: 'DAM', field: 'loadDamMw' },
    { id: 'load_2da', market: '2DA', field: 'load2daMw' },
    { id: 'load_7da', market: '7DA', field: 'load7daMw' },
    { id: 'renewables_dam', market: 'DAM', field: null },
  ];
  const receipts = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  const evidence = [];
  let sourceRows = 0, wrongMarketRows = 0, feedHours = 0;
  const datasetResults = [];
  const csvCell = value => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  for (const config of configs) {
    const byDay = new Map();
    let reports = 0, rawRows = 0;
    for (const name of receipts.filter(name => name.startsWith(config.id + '_')).sort()) {
      const meta = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (meta.dataset !== config.id || meta.status !== 'downloaded') continue;
      assert.equal(meta.parameters.market_run_id, config.market);
      assert.equal(meta.publishTimeUtc, null);
      assert.equal(meta.vintageEvidence, 'current_download_only');
      const bytes = await fs.readFile(path.join(directory, meta.rawFile));
      assert.equal(hash(bytes), meta.sha256, 'Receipt hash differs from raw source');
      let observed = 0;
      const files = unzipSync(bytes);
      for (const [filename, content] of Object.entries(files)) {
        assert(!/\.xml$/i.test(filename), 'Unexpected XML in a successful CSV forecast response');
        if (!/\.csv$/i.test(filename)) continue;
        const parsed = parseCsv(strFromU8(content));
        const header = parsed[0], at = field => header.indexOf(field);
        assert(at('INTERVALSTARTTIME_GMT') >= 0 && at('MARKET_RUN_ID') >= 0);
        const groups = new Map();
        for (const row of parsed.slice(1)) {
          observed++; sourceRows++; rawRows++;
          if (row[at('MARKET_RUN_ID')] !== config.market) wrongMarketRows++;
          assert.equal(row[at('MARKET_RUN_ID')], config.market, 'Market/horizon mixing found in source file');
          const start = new Date(row[at('INTERVALSTARTTIME_GMT')]).toISOString();
          const expected = values.get(start);
          assert(expected, 'Forecast raw source contains a target outside the declared complete window');
          const day = expected.localDate;
          if (!groups.has(day)) groups.set(day, []);
          groups.get(day).push(row);
        }
        for (const [day, rows] of groups) {
          const text = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
          if (!byDay.has(day)) byDay.set(day, []);
          byDay.get(day).push(text);
        }
      }
      assert.equal(observed, meta.rowCount);
      assert(archive.sources.some(source => source.id === meta.id && source.sha256 === meta.sha256 && source.fetchedAt === meta.fetchedAt), 'Source provenance not carried into delivered dataset');
      evidence.push({ id: meta.id, dataset: meta.dataset, sha256: meta.sha256, rawRows: observed });
      reports++;
    }
    assert.equal(reports, 6, 'Expected six fixed windows for each forecast family');
    assert.equal(byDay.size, 180);
    const observed = new Set();
    for (const [day, texts] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      const normalized = normalizeFundamentalCsv(texts, config.id, day, archive.generatedAt);
      assert.equal(normalized.status, 'ok', `${config.id}/${day}: not complete`);
      assert.equal(normalized.rows.length, 24);
      assert(normalized.columns.every(column => column.kind === 'forecast'));
      for (const actual of normalized.rows) {
        assert(!observed.has(actual.startUtc));
        observed.add(actual.startUtc);
        const row = values.get(actual.startUtc);
        assert.equal(actual.endUtc, row.endUtc);
        assert.equal(actual.publishTimeUtc, null);
        if (!independentNetLoadInputs.has(actual.startUtc)) independentNetLoadInputs.set(actual.startUtc, {});
        const independent = independentNetLoadInputs.get(actual.startUtc);
        if (config.field) {
          compare(row, config.field, actual.values.load__CA_ISO_TAC);
          if (config.id === 'load_dam') independent.load = actual.values.load__CA_ISO_TAC;
        }
        else {
          for (const resource of ['solar', 'wind']) {
            for (const hub of ['NP15', 'SP15', 'ZP26']) {
              const label = hub[0] + hub.slice(1).toLowerCase();
              compare(row, `${resource}${label}Mw`, actual.values[`${resource}__${hub}`]);
            }
            compare(row, `${resource}CaisoMw`, actual.values[`${resource}__CAISO`]);
            independent[resource] = actual.values[`${resource}__CAISO`];
          }
        }
        feedHours++;
      }
    }
    assert.equal(observed.size, 4320);
    datasetResults.push({ id: config.id, market: config.market, sourceReports: reports, sourceRows: rawRows, days: byDay.size, utcHours: observed.size });
  }
  for (const row of values.values()) {
    const independent = independentNetLoadInputs.get(row.startUtc);
    const complete = [independent.load, independent.solar, independent.wind].every(value => value != null);
    compare(row, 'netLoadDamMw', complete ? independent.load - independent.solar - independent.wind : null);
  }
  assert.equal(evidence.length, 24);
  assert.equal(archive.sources.length, 24);
  assert.equal(feedHours, 17280);
  for (const field of numericFields) {
    assert.equal(stats[field].compared, 4320);
    assert.equal(archive.missingByField[field], stats[field].missing);
  }
  const result = {
    schemaVersion: 1, verifiedAt: new Date().toISOString(), verified: true,
    dataset: archive.dataset, compressedFileSha256AtVerification: hash(rawTarget),
    normalizedFieldsAndRowsSha256: hash(Buffer.from(JSON.stringify({ fields: archive.fields, rows: archive.rows }))),
    independentNormalizer: 'Existing lib/fundamentals.ts normalizeFundamentalCsv; no import of new Python builder',
    normalizerSourceSha256: hash(await fs.readFile(path.join(root, 'lib/fundamentals.ts'))),
    intervalSourceSha256: hash(await fs.readFile(path.join(root, 'lib/oasis.ts'))),
    utcHours: values.size, days: 180, feedHours, comparedValues: Object.values(stats).reduce((sum, row) => sum + row.compared, 0),
    sourceReports: evidence.length, sourceRows, wrongMarketRows,
    sourceValuesExactAgreement: true, derivedValuesWithinTolerance: true,
    derivedAbsoluteToleranceMw: derivedTolerance,
    exactNumericAgreement: Object.values(stats).every(row => row.exactComparisons === row.compared),
    utcAndPacificAlignment: true,
    missingValuesPreserved: true, nullIssueTimesPreserved: true, marketAndAreaIsolationChecked: true,
    classification: archive.classification, causalReplayApproved: false,
    datasetResults, fieldStatistics: stats, sourceHashes: evidence,
    limitation: 'This verifies normalization and archive consistency. Derived sums allow 1e-9 MW for Python/JavaScript floating-point summation differences; source values match exactly. It does not prove original historical publication vintages or make the panel eligible for causal replay.',
  };
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ verified: true, utcHours: result.utcHours, comparedValues: result.comparedValues, feedHours, sourceReports: evidence.length, sourceRows, wrongMarketRows, fieldStatistics: stats, output }));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
