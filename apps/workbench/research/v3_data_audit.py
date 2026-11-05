#!/usr/bin/env python3
"""Fetch and audit frozen hourly OASIS load/wind/solar actuals for V3 research.

Only public CAISO URLs are contacted. No credentials are required or accepted.
Raw responses and response-time metadata are cached under .sites-runtime; the
published archive preserves source URLs/digests and does not invent issue times.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import date, datetime, time as daytime, timedelta, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PT = ZoneInfo('America/Los_Angeles')
UTC = timezone.utc
ENDPOINT = 'https://oasis.caiso.com/oasisapi/SingleZip'
HUBS = ('NP15', 'SP15', 'ZP26')
REPORTS = {'load': 'SLD_FCST', 'renewables': 'SLD_REN_FCST'}
SOURCE_REFS = [
    {'name': 'CAISO OASIS FAQ', 'url': 'https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf',
     'supports': 'ACTUAL load/wind/solar query names and market parameters; report-specific date limits; most reports retained 39 months; OASIS and Outlook have different definitions'},
    {'name': 'GridStatus CAISO implementation', 'url': 'https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html',
     'supports': 'get_load_hourly and get_renewables_hourly read ACTUAL; hourly daily-forecast Publish Time is schedule-derived, not a per-record original publication timestamp'},
]


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def parse(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp must include an explicit timezone')
    return result.astimezone(UTC)


def encoded(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def digest(value: object) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def ordered_sum(values):
    # Match the existing TypeScript reduce order; Python 3.12 sum compensates.
    total = 0.
    for value in values:
        total += value
    return total


def atomic_json(path: Path, value: object):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.tmp')
    tmp.write_bytes(encoded(value) + b'\n')
    os.replace(tmp, path)


def utc_window(start: date, end_exclusive: date):
    return (datetime.combine(start, daytime(), PT).astimezone(UTC),
            datetime.combine(end_exclusive, daytime(), PT).astimezone(UTC))


def expected_hours(start: date, end_exclusive: date):
    current, end = utc_window(start, end_exclusive)
    while current < end:
        yield current
        current += timedelta(hours=1)


def query_url(family: str, start: date, end_exclusive: date) -> str:
    a, b = utc_window(start, end_exclusive)
    return ENDPOINT + '?' + urllib.parse.urlencode({
        'queryname': REPORTS[family], 'version': '1', 'market_run_id': 'ACTUAL',
        'resultformat': '6', 'startdatetime': a.strftime('%Y%m%dT%H:%M-0000'),
        'enddatetime': b.strftime('%Y%m%dT%H:%M-0000'),
    })


def csv_rows(raw: bytes):
    if not raw.startswith(b'PK'):
        raise ValueError('OASIS did not return a ZIP archive')
    rows = []
    headers = set()
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        if bundle.testzip() is not None:
            raise ValueError('OASIS ZIP CRC failed')
        if sum(x.file_size for x in bundle.infolist()) > 32 * 1024 * 1024:
            raise ValueError('Expanded response exceeds 32 MiB')
        for name in bundle.namelist():
            if name.lower().endswith('.xml'):
                raise ValueError('OASIS returned an XML error rather than requested CSV: ' + name)
            if not name.lower().endswith('.csv'):
                continue
            reader = csv.DictReader(io.StringIO(bundle.read(name).decode('utf-8-sig')))
            headers.update(reader.fieldnames or [])
            rows.extend(reader)
    if not rows:
        raise ValueError('OASIS returned no CSV records')
    required = {'INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT', 'MARKET_RUN_ID', 'MW'}
    if not required.issubset(headers):
        raise ValueError('Required OASIS fields missing')
    return rows, sorted(headers)


def numeric(value):
    if value is None or value.strip().lower() in ('', 'null', 'nan', 'n/a'):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def normalize(records, family: str, start: date, end_exclusive: date):
    """UTC-unique selected observations; conflicts become null, never averaged."""
    lower, upper = utc_window(start, end_exclusive)
    values, conflicts = {}, set()
    stats = Counter(rawRows=len(records))
    for item in records:
        if item['MARKET_RUN_ID'] != 'ACTUAL':
            stats['discardedMarketRows'] += 1
            continue
        stamp, end = parse(item['INTERVALSTARTTIME_GMT']), parse(item['INTERVALENDTIME_GMT'])
        if not lower <= stamp < upper:
            stats['discardedOutsideWindowRows'] += 1
            continue
        if end - stamp != timedelta(hours=1) or stamp.minute or stamp.second:
            raise ValueError('Actuals must contain exactly one UTC hour per interval')
        if family == 'load':
            if item.get('TAC_AREA_NAME') != 'CA ISO-TAC':
                stats['otherAreaRows'] += 1
                continue
            area, resource = 'CA ISO-TAC', 'load'
        else:
            area, resource = item.get('TRADING_HUB'), item.get('RENEWABLE_TYPE', '').lower()
            if area not in HUBS or resource not in ('solar', 'wind'):
                stats['otherAreaOrResourceRows'] += 1
                continue
        key = (iso(stamp), area, resource)
        value = numeric(item.get('MW'))
        stats['selectedSourceRows'] += 1
        if key in conflicts:
            continue
        if key in values:
            if values[key] != value:
                values[key] = None
                conflicts.add(key)
                stats['conflictingDuplicates'] += 1
            else:
                stats['identicalDuplicates'] += 1
        else:
            values[key] = value
    stats['uniqueSelectedObservations'] = len(values)
    stats['negativeValues'] = sum(v is not None and v < 0 for v in values.values())
    stats['zeroValues'] = sum(v == 0 for v in values.values())
    stats['nullValues'] = sum(v is None for v in values.values())
    return values, dict(stats)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Collector:
    def __init__(self, cache: Path, interval: float):
        self.cache, self.interval, self.last_request = cache, interval, 0.
        self.opener = urllib.request.build_opener(NoRedirect)

    def obtain(self, family: str, start: date, end_exclusive: date):
        stem = f'{family}-{start}-{end_exclusive}'
        self.cache.mkdir(parents=True, exist_ok=True)
        path, meta_path = self.cache / (stem + '.zip'), self.cache / (stem + '.json')
        url = query_url(family, start, end_exclusive)
        if path.exists() and meta_path.exists():
            raw, meta = path.read_bytes(), json.loads(meta_path.read_text())
            if meta['sourceUrl'] != url or hashlib.sha256(raw).hexdigest() != meta['rawSha256']:
                raise ValueError('Cached response fingerprint differs')
        else:
            delay = self.interval - (time.monotonic() - self.last_request)
            if delay > 0:
                time.sleep(delay)
            request = urllib.request.Request(url, headers={'Accept': 'application/zip, application/octet-stream'})
            self.last_request = time.monotonic()
            with self.opener.open(request, timeout=45) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise ValueError('Compressed OASIS response exceeds 8 MiB')
                meta = {'sourceUrl': url, 'fetchedAt': iso(datetime.now(UTC)),
                        'lastModified': response.headers.get('Last-Modified'),
                        'rawSha256': hashlib.sha256(raw).hexdigest(), 'rawBytes': len(raw),
                        'report': REPORTS[family], 'marketRunId': 'ACTUAL',
                        'startDate': str(start), 'endDateExclusive': str(end_exclusive)}
            csv_rows(raw)
            path.write_bytes(raw)
            atomic_json(meta_path, meta)
        records, headers = csv_rows(raw)
        values, counts = normalize(records, family, start, end_exclusive)
        return values, {**meta, 'headers': headers, 'counts': counts}


def assemble(start: date, end_exclusive: date, load: dict, renewables: dict):
    rows = []
    for stamp in expected_hours(start, end_exclusive):
        key, local = iso(stamp), stamp.astimezone(PT)
        hubs = {hub: {resource + 'Mw': renewables.get((key, hub, resource))
                      for resource in ('solar', 'wind')} for hub in HUBS}
        totals = {}
        for resource in ('solar', 'wind'):
            parts = [hubs[hub][resource + 'Mw'] for hub in HUBS]
            totals[resource + 'Mw'] = ordered_sum(parts) if all(v is not None for v in parts) else None
        load_mw = load.get((key, 'CA ISO-TAC', 'load'))
        complete = load_mw is not None and all(v is not None for v in totals.values())
        rows.append({'startUtc': key, 'endUtc': iso(stamp + timedelta(hours=1)),
                     'localDate': str(local.date()), 'localHour': f'{local.hour:02}:00',
                     'utcOffset': local.strftime('%z')[:3] + ':' + local.strftime('%z')[3:],
                     'loadMw': load_mw, **totals,
                     'netLoadMw': load_mw - totals['solarMw'] - totals['windMw'] if complete else None,
                     'renewablesByHub': hubs, 'publishTimeUtc': None,
                     'quality': 'complete' if complete else 'missing'})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', type=date.fromisoformat, default=date(2026, 5, 2))
    parser.add_argument('--end', type=date.fromisoformat, default=date(2026, 10, 28))
    parser.add_argument('--cache', type=Path, default=ROOT / '.sites-runtime/v3-fundamentals')
    parser.add_argument('--interval', type=float, default=5.1)
    args = parser.parse_args()
    if args.end < args.start or (args.end - args.start).days > 365:
        raise ValueError('Choose a bounded interval of 1 to 366 days')
    stop = args.end + timedelta(days=1)
    collector = Collector(args.cache, max(4., args.interval))
    indexes = {'load': {}, 'renewables': {}}
    receipts = []
    current = args.start
    while current < stop:
        until = min(current + timedelta(days=31), stop)
        for family in REPORTS:
            values, receipt = collector.obtain(family, current, until)
            if indexes[family].keys() & values.keys():
                raise ValueError('Overlapping acquisition windows')
            indexes[family].update(values)
            receipts.append(receipt)
            print(json.dumps({'report': REPORTS[family], 'start': str(current),
                              'endExclusive': str(until), 'counts': receipt['counts']}, ensure_ascii=False), flush=True)
        current = until
    rows = assemble(args.start, stop, indexes['load'], indexes['renewables'])
    complete = sum(r['quality'] == 'complete' for r in rows)
    availability = {'minimumLagDays': 2, 'publishTimeAvailable': False,
                    'originalPublicationVerified': False, 'historicalVintageVerified': False,
                    'allowedUse': 'D−2及更早实际基本面的滞后历史重建特征；不用于目标日事后实际值',
                    'limitation': '当前获取版本可能包含修订；D−2是研究信息延迟假设，不证明历史首次发布版本。'}
    archive = {'schemaVersion': 1, 'id': 'oasis-fundamentals-actual-v3',
               'classification': 'historical_actual_reconstruction', 'source': 'CAISO OASIS',
               'startDate': str(args.start), 'endDate': str(args.end),
               'fetchedAt': max(r['fetchedAt'] for r in receipts), 'timeZone': str(PT),
               'unit': 'MW', 'availability': availability, 'sourceRequests': receipts,
               'derivation': 'loadMw=CA ISO-TAC；solarMw/windMw仅由NP15/SP15/ZP26完整值求和；netLoadMw=loadMw−solarMw−windMw，为本地派生指标。',
               'rows': rows}
    archive['digest'] = digest(archive)
    archive_path = ROOT / 'data/fundamentals-history-v3.json'
    atomic_json(archive_path, archive)
    summary = {'schemaVersion': 1, 'status': 'complete' if complete == len(rows) else 'partial',
               'classification': archive['classification'], 'generatedAt': iso(datetime.now(UTC)),
               'archivePath': 'data/fundamentals-history-v3.json', 'archiveDigest': archive['digest'],
               'archiveFileSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
               'startDate': str(args.start), 'endDate': str(args.end),
               'calendarDays': (stop - args.start).days, 'expectedHours': len(rows),
               'completeHours': complete, 'missingHours': len(rows) - complete,
               'hourlyRows': len(rows), 'hourlyFields': ['loadMw', 'solarMw', 'windMw', 'netLoadMw'],
               'regionalRenewableObservations': len(indexes['renewables']),
               'negativeRegionalRenewableValues': sum(v is not None and v < 0 for v in indexes['renewables'].values()),
               'zeroRegionalRenewableValues': sum(v == 0 for v in indexes['renewables'].values()),
               'uniqueUtcHours': len({r['startUtc'] for r in rows}),
               'actualPublicationTimestampCount': 0, 'imputedValueCount': 0,
               'range': {field: {'min': min(r[field] for r in rows if r[field] is not None),
                                 'max': max(r[field] for r in rows if r[field] is not None)}
                         for field in ['loadMw', 'solarMw', 'windMw', 'netLoadMw']},
               'availability': availability, 'requests': receipts, 'references': SOURCE_REFS,
               'notes': ['负值和零值是来源中真实数值，保留且不裁剪；不将其解释为数据缺失。',
                         '负荷仅使用CA ISO-TAC；其他TAC/BAA不相加。',
                         'OASIS市场输出与Outlook遥测汇总不同，不混用为同一实际标签。',
                         '未把GridStatus依据日程推导的Publish Time当作原始发布时间证据。',
                         '补齐历史基本面不代表已改善模型；只有同窗消融后才能评价增益。']}
    atomic_json(ROOT / 'public/data/forecast-lab/v3/fundamentals-audit.json', summary)
    print(json.dumps({k: summary[k] for k in ['status', 'calendarDays', 'expectedHours', 'completeHours',
                                            'missingHours', 'archiveDigest', 'archiveFileSha256']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
