#!/usr/bin/env python3
"""Portable, offline inspection and independent QA for the data-gap delivery.

Uses only Python's standard library. It does not import the acquisition/builder
scripts, contact an API, change source data, or approve a trading-node mapping.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = Path('public/data/data-gaps')
LIMIT_BYTES = 25 * 1024 * 1024
PT = ZoneInfo('America/Los_Angeles')
MANIFEST_NAMES = ('manifest.json', 'oasis-public-responses-manifest.json')
EVIDENCE_ARCHIVES = {
    'weather-evidence': 'weather-outage-evidence.zip',
    'settlement-evidence': 'download-evidence.zip',
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_member(name):
    path = PurePosixPath(name)
    if (not isinstance(name, str) or not name or '\\' in name or '\x00' in name
            or path.is_absolute() or ':' in name or '..' in path.parts
            or path.as_posix() != name or name.endswith('/')):
        raise ValueError('Unsafe or noncanonical archive path: ' + repr(name))
    return name


def verify_archive(path, *, maximum_bytes=LIMIT_BYTES):
    """Verify every payload member's SHA/size, ZIP CRC and canonical path."""
    path = Path(path)
    raw = path.read_bytes()
    if len(raw) >= maximum_bytes:
        raise ValueError(f'Archive must be below {maximum_bytes} bytes: {path.name}')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        names = [safe_member(info.filename) for info in infos]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate ZIP member names')
        if len(names) > 10000 or sum(info.file_size for info in infos) > 128 * 1024 * 1024:
            raise ValueError('Archive expansion/count exceeds the delivery limit')
        if any(stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1 for info in infos):
            raise ValueError('Symlinks and encrypted ZIP members are not supported')
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC mismatch')
        manifests = [name for name in MANIFEST_NAMES if name in names]
        if len(manifests) != 1:
            raise ValueError('Expected exactly one package SHA manifest')
        manifest_name = manifests[0]
        manifest = json.loads(archive.read(manifest_name))
        entries = manifest.get('files', [])
        declared = [safe_member(entry['path']) for entry in entries]
        if len(declared) != len(set(declared)) or set(declared) != set(names) - {manifest_name}:
            raise ValueError('Manifest does not cover exactly the payload members')
        for entry in entries:
            content = archive.read(entry['path'])
            if len(content) != entry['bytes'] or sha256(content) != entry['sha256']:
                raise ValueError('Manifest SHA/size mismatch: ' + entry['path'])
    return {'archive': path.name, 'bytes': len(raw), 'sha256': sha256(raw),
            'members': len(names), 'payloadFiles': len(entries), 'manifest': manifest_name,
            'snapshotLabel': manifest.get('snapshotLabel'), 'allChecksPassed': True}


def read_json(root, relative):
    relative = safe_member(Path(relative).as_posix())
    path = root / relative
    if path.is_file():
        raw = path.read_bytes()
    else:
        # Evidence is shipped once as a nested package; read JSON without extraction.
        parts = PurePosixPath(relative).parts
        base = DATA.parts
        if parts[:len(base)] != base or len(parts) <= len(base) + 1:
            raise FileNotFoundError(path)
        group = parts[len(base)]
        if group not in EVIDENCE_ARCHIVES:
            raise FileNotFoundError(path)
        inner = '/'.join(parts[len(base) + 1:])
        with zipfile.ZipFile(root / DATA / group / EVIDENCE_ARCHIVES[group]) as archive:
            raw = archive.read(safe_member(inner))
    return json.loads(gzip.decompress(raw) if relative.endswith('.gz') else raw)


def table_rows(payload):
    rows = payload.get('rows', [])
    fields = payload.get('fields')
    for row in rows:
        if isinstance(row, list):
            if not fields or len(row) != len(fields):
                raise ValueError('Row length differs from the declared schema')
            yield dict(zip(fields, row))
        elif isinstance(row, dict):
            yield row
        else:
            raise ValueError('Unsupported normalized row format')


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Expected an explicit source timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def numeric(value):
    if value is None or str(value).strip().lower() in ('', 'null', 'nan', 'n/a'):
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Non-finite price')
    return result


def public_csv_reports(root, dataset):
    """Independently decode only named successful public CSV receipts."""
    cache = root / '.sites-runtime/gap-acquisition'
    found = 0
    for path in sorted(cache.glob(dataset + '_*.json')):
        meta = json.loads(path.read_text())
        if meta.get('dataset') != dataset or meta.get('status') != 'downloaded':
            continue
        raw_name = safe_member(meta['rawFile'])
        if '/' in raw_name:
            raise ValueError('Raw response must be a direct cache member')
        raw = (cache / raw_name).read_bytes()
        if sha256(raw) != meta['sha256'] or len(raw) != meta['bytes']:
            raise ValueError('Raw source/receipt mismatch: ' + path.name)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 160 * 1024 * 1024:
                raise ValueError('Source ZIP exceeds the expansion limit')
            if archive.testzip() is not None:
                raise ValueError('Source ZIP CRC mismatch')
            observed = 0
            rows = []
            for name in archive.namelist():
                safe_member(name)
                if name.lower().endswith('.xml'):
                    raise ValueError('XML/error unexpectedly present in a successful CSV report')
                if name.lower().endswith('.csv'):
                    with archive.open(name) as stream:
                        for row in csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig', newline='')):
                            rows.append(row)
                            observed += 1
            if observed != meta['rowCount']:
                raise ValueError('Raw CSV row count differs from receipt')
        found += 1
        yield meta, rows
    if not found:
        raise ValueError('No archived reports for ' + dataset + '; extract the companion OASIS ZIP first')


def qa_nodes(root):
    """Recompute the known node/calendar conflicts without importing the builder."""
    reference = read_json(root, DATA / 'price-components-180d.json.gz')
    prices = {(row['market'], row['node'], iso(timestamp(row['startUtc']))): row['lmp']
              for row in table_rows(reference)}
    calendar, source_ids = {}, set()
    calendar_duplicates = 0
    for meta, rows in public_csv_reports(root, 'peak_history'):
        source_ids.add(meta['id'])
        for row in rows:
            start, end = timestamp(row['INTERVALSTARTTIME_GMT']), timestamp(row['INTERVALENDTIME_GMT'])
            if end - start != timedelta(hours=1) or row['PEAK_FLAG'] not in ('ON', 'OFF'):
                raise ValueError('Invalid official peak calendar interval')
            key, value = iso(start), row['PEAK_FLAG']
            if key in calendar:
                if calendar[key] != value:
                    raise ValueError('Conflicting official calendar flags')
                calendar_duplicates += 1
            calendar[key] = value

    expected, hour_grid = set(), set()
    current = datetime.combine(date.fromisoformat(reference['startDate']), datetime.min.time(), PT).astimezone(timezone.utc)
    stop = datetime.combine(date.fromisoformat(reference['endDate']) + timedelta(days=1), datetime.min.time(), PT).astimezone(timezone.utc)
    while current < stop:
        hour_grid.add(iso(current))
        for node in reference['nodes']:
            expected.add(('DAM', node, iso(current)))
            for quarter in range(4):
                expected.add(('FMM', node, iso(current + timedelta(minutes=15 * quarter))))
        current += timedelta(hours=1)

    actual, original_keys, conflicts = {}, set(), []
    duplicates, source_time_mismatches = 0, 0
    stats = {market: Counter() for market in ('DAM', 'FMM')}
    for dataset, market, field, minutes in [('cb_history_dam', 'DAM', 'MW', 60), ('cb_history_fmm', 'FMM', 'PRC', 15)]:
        for meta, rows in public_csv_reports(root, dataset):
            source_ids.add(meta['id'])
            for row in rows:
                if row['LMP_TYPE'] != 'LMP':
                    continue
                start, end = timestamp(row['INTERVALSTARTTIME_GMT']), timestamp(row['INTERVALENDTIME_GMT'])
                node = re.fullmatch(r'TH_(NP15|SP15|ZP26)_GEN_(ON|OFF)PEAK-APND', row['NODE'])
                if node is None or row['MARKET_RUN_ID'] != ('DAM' if market == 'DAM' else 'RTPD'):
                    raise ValueError('Unexpected eligible-node or market identity')
                if end - start != timedelta(minutes=minutes) or start.minute % minutes or start.second or start.microsecond:
                    raise ValueError('Invalid native interval')
                local = start.astimezone(PT)
                source_time_mismatches += (row['OPR_DT'] != local.date().isoformat()
                                           or int(row['OPR_HR']) != local.hour + 1)
                generic = 'TH_' + node[1] + '_GEN-APND'
                key, original_key = (market, generic, iso(start)), (market, row['NODE'], iso(start))
                if original_key in original_keys:
                    duplicates += 1
                original_keys.add(original_key)
                actual.setdefault(key, set()).add(row['NODE'])
                flag = calendar.get(iso(start.replace(minute=0)))
                if flag is None:
                    raise ValueError('Price hour missing from official calendar')
                price, generic_price = numeric(row[field]), prices.get(key)
                stat = stats[market]
                stat['nativeRows'] += 1
                stat['missingTradablePrice'] += price is None
                stat['missingGenericPrice'] += generic_price is None
                if price is not None and generic_price is not None:
                    difference = abs(price - generic_price)
                    stat['priceComparisons'] += 1
                    stat['exactPriceMatches'] += price == generic_price
                    stat['pricesBeyondTolerance'] += difference > 0.000100001
                    stat['maximumAbsolutePriceDifferenceUsdPerMwh'] = max(stat['maximumAbsolutePriceDifferenceUsdPerMwh'], difference)
                if flag != node[2]:
                    stat['calendarNodeMismatches'] += 1
                    conflicts.append({'market': market, 'tradableNode': row['NODE'],
                                      'startUtc': iso(start), 'datePT': local.date().isoformat(),
                                      'timePT': local.strftime('%H:%M'), 'calendarPeakFlag': flag,
                                      'nodePeak': node[2], 'priceSource': meta['id']})

    published = read_json(root, DATA / 'node-mapping-discrepancies.json')
    result = {
        'method': 'Independent stdlib ZIP/CSV parsing; no builder imports or network',
        'sourceReports': len(source_ids), 'calendarHours': len(calendar),
        'calendarIdenticalDuplicates': calendar_duplicates,
        'expectedNativeIntervals': len(expected), 'observedNativeIntervals': len(original_keys),
        'missingNativeIntervals': len(expected - set(actual)),
        'unexpectedNativeIntervals': len(set(actual) - expected),
        'missingCalendarHours': len(hour_grid - set(calendar)),
        'sameMarketHubUtcMultipleNodes': sum(len(nodes) > 1 for nodes in actual.values()),
        'duplicateNativeIntervalKeys': duplicates,
        'utcVersusSourceDateHourMismatches': source_time_mismatches,
        'calendarNodeMismatches': len(conflicts),
        'affectedDatesPT': sorted({row['datePT'] for row in conflicts}),
        'marketStatistics': {market: dict(value) for market, value in stats.items()},
        'calendarConsistencyApproved': False, 'causeConfirmed': False,
    }
    compared = ['calendarHours', 'calendarIdenticalDuplicates', 'expectedNativeIntervals',
                'observedNativeIntervals', 'missingNativeIntervals', 'unexpectedNativeIntervals',
                'sameMarketHubUtcMultipleNodes', 'duplicateNativeIntervalKeys',
                'utcVersusSourceDateHourMismatches', 'calendarNodeMismatches', 'affectedDatesPT']
    for field in compared:
        if result[field] != published[field]:
            raise ValueError('Independent node QA differs from delivered report: ' + field)
    for market, actual_stats in stats.items():
        for field, value in published['marketStatistics'][market].items():
            if actual_stats[field] != value:
                raise ValueError(f'Independent node price QA differs: {market}/{field}')
    key = lambda row: (row['market'], row['tradableNode'], row['startUtc'], row['calendarPeakFlag'])
    if {key(row) for row in conflicts} != {key(row) for row in published['discrepancies']}:
        raise ValueError('Conflict identities differ from delivered QA')
    result.update(publishedQaAgreement=True, sampleConflicts=conflicts[:6],
                  limitation='Agreement verifies the published conflict report. Price equality does not approve calendar-to-node substitution or explain the conflict.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    verify = sub.add_parser('verify', help='Verify package manifests, CRC, paths and sizes')
    verify.add_argument('archives', nargs='+', type=Path)
    sub.add_parser('list', help='List delivered normalized tables')
    head = sub.add_parser('head', help='Read rows from a dataset ID or a path inside public/data/data-gaps')
    head.add_argument('dataset')
    head.add_argument('--limit', type=int, default=3)
    sub.add_parser('qa-nodes', help='Recompute node/calendar conflicts from companion raw responses')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.command == 'verify':
        result = [verify_archive(path) for path in args.archives]
    elif args.command == 'qa-nodes':
        result = qa_nodes(root)
    elif args.command == 'list':
        result = []
        for path in sorted((root / DATA).glob('*.json.gz')):
            data = read_json(root, path.relative_to(root))
            result.append({key: data.get(key) for key in ['dataset', 'id', 'classification', 'modelStatus', 'startDate', 'endDate']}
                          | {'file': path.name, 'rows': len(data.get('rows', [])), 'fields': data.get('fields')})
    else:
        if not 0 <= args.limit <= 100:
            parser.error('--limit must be between 0 and 100')
        filename = args.dataset if args.dataset.endswith(('.json', '.json.gz')) else args.dataset + '.json.gz'
        data = read_json(root, DATA / safe_member(filename))
        rows = list(table_rows(data))
        result = {'file': filename, 'rowCount': len(rows), 'fields': data.get('fields'),
                  'classification': data.get('classification'), 'sampleRows': rows[:args.limit]}
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
