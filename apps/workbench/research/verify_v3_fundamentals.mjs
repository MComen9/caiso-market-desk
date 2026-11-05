// Independently normalize all cached raw CAISO actuals through the existing Site code.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { unzipSync, strFromU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = await fs.mkdtemp(path.join(root, '.sites-runtime/v3-fundamentals-verify-'));
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
  const archive = JSON.parse(await fs.readFile(path.join(root, 'data/fundamentals-history-v3.json'), 'utf8'));
  const rows = new Map(archive.rows.map(r => [r.startUtc, r]));
  let selectedHours = 0, valuesChecked = 0;
  for (const receipt of archive.sourceRequests) {
    const family = receipt.report === 'SLD_FCST' ? 'load' : 'renewables';
    const name = `${family}-${receipt.startDate}-${receipt.endDateExclusive}.zip`;
    const files = unzipSync(await fs.readFile(path.join(root, '.sites-runtime/v3-fundamentals', name)));
    const texts = Object.entries(files).filter(([name]) => name.endsWith('.csv')).map(([, v]) => strFromU8(v));
    for (let day = receipt.startDate; day < receipt.endDateExclusive;
      day = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) {
      const feed = normalizeFundamentalCsv(texts, family === 'load' ? 'load_actual' : 'renewables_actual', day, receipt.fetchedAt);
      assert.equal(feed.status, 'ok', `${family}/${day}: expected complete report`);
      for (const actual of feed.rows) {
        const saved = rows.get(actual.startUtc);
        assert(saved, 'Missing saved UTC hour');
        assert.equal(saved.endUtc, actual.endUtc);
        assert.equal(actual.publishTimeUtc, null);
        if (family === 'load') {
          assert.equal(saved.loadMw, actual.values.load__CA_ISO_TAC);
          valuesChecked++;
        } else {
          for (const resource of ['solar', 'wind']) {
            assert.equal(saved[resource + 'Mw'], actual.values[resource + '__CAISO']);
            valuesChecked++;
            for (const hub of ['NP15', 'SP15', 'ZP26']) {
              assert.equal(saved.renewablesByHub[hub][resource + 'Mw'], actual.values[resource + '__' + hub]);
              valuesChecked++;
            }
          }
        }
        selectedHours++;
      }
    }
  }
  assert.equal(selectedHours, archive.rows.length * 2);
  for (const row of archive.rows) {
    assert.equal(row.netLoadMw, row.loadMw - row.solarMw - row.windMw);
    valuesChecked++;
  }
  const result = { verifiedAt: new Date().toISOString(), archiveDigest: archive.digest,
    independentNormalizer: 'lib/fundamentals.ts normalizeFundamentalCsv',
    utcHours: archive.rows.length, feedHours: selectedHours, valuesChecked,
    exactNumericAgreement: true, nullIssueTimesPreserved: true };
  await fs.writeFile(path.join(root, 'public/data/forecast-lab/v3/fundamentals-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
