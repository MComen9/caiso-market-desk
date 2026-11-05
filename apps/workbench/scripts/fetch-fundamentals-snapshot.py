#!/usr/bin/env python3
"""Download public OASIS reports, preserve evidence, and build the Site snapshot.

Uses only Python standard library and the project's existing TypeScript parser.
No API key, local secret, or dependency installation is required.
"""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[1]
FEEDS = {
    'load_dam': ('SLD_FCST', 'DAM', None),
    'load_rtpd': ('SLD_FCST', 'RTM', 'RTPD'),
    'load_rtd': ('SLD_FCST', 'RTM', 'RTD'),
    'load_2da': ('SLD_FCST', '2DA', None),
    'load_7da': ('SLD_FCST', '7DA', None),
    'load_actual': ('SLD_FCST', 'ACTUAL', None),
    'renewables_dam': ('SLD_REN_FCST', 'DAM', None),
    'renewables_rtpd': ('SLD_REN_FCST', 'RTPD', None),
    'renewables_rtd': ('SLD_REN_FCST', 'RTD', None),
    'renewables_hasp': ('SLD_REN_FCST', 'HASP', None),
    'renewables_actual': ('SLD_REN_FCST', 'ACTUAL', None),
}

BUILD_SCRIPT = r'''
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(root, '.sites-runtime/fundamentals-build-'));
try {
  const names = ['types', 'oasis', 'data-types', 'fundamentals-types', 'fundamentals'];
  for (const name of names) {
    const source = await fs.readFile(path.join(root, 'lib', `${name}.ts`), 'utf8');
    let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const dep of names) compiled = compiled.replaceAll(`from './${dep}'`, `from './${dep}.mjs'`);
    await fs.writeFile(path.join(temporary, `${name}.mjs`), compiled);
  }
  const { decodeFundamentalArchive, emptyFundamental } = await import(pathToFileURL(path.join(temporary, 'fundamentals.mjs')).href);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data/fundamentals-raw/manifest.json'), 'utf8'));
  const archive = { generatedAt: new Date().toISOString(), byDate: {} };
  const records = [];
  for (const item of manifest.reports) {
    let feed;
    try {
      if (item.error) throw new Error(item.error);
      feed = decodeFundamentalArchive(new Uint8Array(await fs.readFile(path.join(root, item.file))), item.id, item.date, item.fetchedAt);
      feed.lastModified = item.lastModified;
    } catch (e) {
      feed = emptyFundamental(item.id, item.date, item.fetchedAt);
      feed.status = e.code === 'NO_DATA' ? 'unavailable' : 'error';
      feed.error = { code: e.code || 'FETCH_ERROR', message: e.message };
    }
    const bundle = archive.byDate[item.date] ||= { ok: false, date: item.date, fetchedAt: archive.generatedAt, feeds: {}, warnings: [] };
    bundle.feeds[item.id] = feed;
    bundle.ok ||= feed.status === 'ok' || feed.status === 'partial';
    if (feed.error) bundle.warnings.push(`${feed.title}：${feed.error.message}`);
    for (const row of feed.rows) for (const col of feed.columns.filter(col => col.primary)) records.push([
      item.date, item.id, row.startUtc, row.endUtc, col.area, col.resource,
      row.values[col.key], col.unit, row.publishTimeUtc, feed.fetchedAt,
    ]);
  }
  const json = JSON.stringify(archive);
  await fs.writeFile(path.join(root, 'data/fundamentals-bootstrap.json'), json);
  await fs.mkdir(path.join(root, 'public/data'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/data/fundamentals-snapshot.json'), json);
  const escape = v => v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  const csv = [['date_pt','feed','interval_start_utc','interval_end_utc','area','resource','value','unit','publish_time_utc','fetched_at'], ...records].map(row => row.map(escape).join(',')).join('\r\n');
  await fs.writeFile(path.join(root, 'public/data/fundamentals-caiso.csv'), '\ufeff' + csv);
  await fs.writeFile(path.join(root, 'public/data/fundamentals-provenance.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ snapshotBytes: Buffer.byteLength(json), exportedCells: records.length, feeds: Object.fromEntries(Object.entries(archive.byDate).map(([date, bundle]) => [date, Object.values(bundle.feeds).map(f => ({ id:f.id, status:f.status, rows:f.rows.length, columns:f.columns.length, error:f.error }))])) }, null, 2));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
'''

def main():
    today = dt.datetime.now(ZoneInfo('America/Los_Angeles')).date()
    parser = argparse.ArgumentParser()
    parser.add_argument('--dates', nargs='+', default=[str(today - dt.timedelta(days=1)), str(today)])
    parser.add_argument('--feeds', nargs='+', choices=FEEDS, default=list(FEEDS))
    parser.add_argument('--reuse', action='store_true', help='Reuse preserved reports for an interrupted download')
    parser.add_argument('--build-only', action='store_true')
    args = parser.parse_args()
    raw_dir = ROOT / 'data/fundamentals-raw'
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_file = raw_dir / 'manifest.json'
    manifest = {'source': 'CAISO OASIS', 'reports': []}
    if args.reuse and manifest_file.exists():
        manifest = json.loads(manifest_file.read_text())
    indexed = {(r['date'], r['id']): r for r in manifest['reports']}
    last_request = 0
    if not args.build_only:
        for date_string in args.dates:
            date = dt.date.fromisoformat(date_string)
            zone = ZoneInfo('America/Los_Angeles')
            start = dt.datetime.combine(date, dt.time(), zone).astimezone(dt.timezone.utc)
            end = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), zone).astimezone(dt.timezone.utc)
            for id in args.feeds:
                if args.reuse and (date_string, id) in indexed and not indexed[(date_string, id)].get('error'):
                    continue
                report, market, execution = FEEDS[id]
                params = dict(queryname=report, version='1', market_run_id=market, resultformat='6', startdatetime=start.strftime('%Y%m%dT%H:%M-0000'), enddatetime=end.strftime('%Y%m%dT%H:%M-0000'))
                if execution:
                    params['execution_type'] = execution
                url = 'https://oasis.caiso.com/oasisapi/SingleZip?' + urllib.parse.urlencode(params)
                folder = raw_dir / date_string
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / (id + '.zip')
                item = dict(id=id, date=date_string, sourceUrl=url, fetchedAt=dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'))
                for attempt in range(2):
                    time.sleep(max(0, 8 - (time.monotonic() - last_request)))
                    last_request = time.monotonic()
                    try:
                        request = urllib.request.Request(url, headers={'Accept': 'application/zip, application/octet-stream, */*'})
                        with urllib.request.urlopen(request, timeout=25) as response:
                            content = response.read(8 * 1024 * 1024 + 1)
                            if len(content) > 8 * 1024 * 1024:
                                raise ValueError('Compressed report exceeds 8 MB')
                            item.update(httpStatus=response.status, lastModified=response.headers.get('last-modified'))
                        target.write_bytes(content)
                        item.update(file=str(target.relative_to(ROOT)), sha256=hashlib.sha256(content).hexdigest(), bytes=len(content))
                        break
                    except urllib.error.HTTPError as error:
                        if error.code == 429 and attempt == 0:
                            continue
                        item['error'] = f'HTTP {error.code}'
                        break
                    except Exception as error:
                        item['error'] = f'{type(error).__name__}: {error}'
                        break
                indexed[(date_string, id)] = item
                item['fetchedAt'] = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
                manifest['reports'] = list(indexed.values())
                manifest['generatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
                manifest_file.write_text(json.dumps(manifest, indent=2))
                print(json.dumps({key: item.get(key) for key in ['date','id','httpStatus','bytes','error']}), flush=True)
    (ROOT / '.sites-runtime').mkdir(exist_ok=True)
    subprocess.run(['node', '--input-type=module', '-'], input=BUILD_SCRIPT, text=True, cwd=ROOT, check=True)

if __name__ == '__main__':
    main()
