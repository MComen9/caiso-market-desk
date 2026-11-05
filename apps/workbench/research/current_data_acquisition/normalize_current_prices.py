#!/usr/bin/env python3
"""Offline append of one verified, contiguous PT day to an immutable price panel."""
from pathlib import Path
from datetime import date, datetime, time, timedelta, timezone
import argparse
import gzip
import hashlib
import json
import math

from oasis_public import ROOT, PT, NODES, decode, stamp, atomic_json


def iso(t):
    return t.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def run(baseline, input_dir, day, output):
    base_bytes = baseline.read_bytes()
    base = json.loads(gzip.decompress(base_bytes) if baseline.suffix == '.gz' else base_bytes)
    if date.fromisoformat(base['endDate']) + timedelta(days=1) != day:
        raise ValueError('The new day must immediately follow the baseline end date.')
    start = datetime.combine(day, time(), PT).astimezone(timezone.utc)
    end = datetime.combine(day + timedelta(days=1), time(), PT).astimezone(timezone.utc)
    hours = int((end - start).total_seconds() / 3600)
    prices, receipts = {}, []
    for market, dataset, column, minutes in [('DAM', 'price_dam', 'MW', 60), ('FMM', 'price_fmm', 'PRC', 15)]:
        receipt = json.loads((input_dir / f'{dataset}_{day}_{day + timedelta(days=1)}.json').read_text())
        body = (input_dir / receipt['rawFile']).read_bytes()
        if receipt['status'] != 'downloaded' or hashlib.sha256(body).hexdigest() != receipt['sha256']:
            raise ValueError('Unsuccessful or mismatched source receipt.')
        records, error = decode(body)
        if error:
            raise ValueError(str(error))
        receipts.append(receipt)
        for row in records:
            if row['LMP_TYPE'] != 'LMP':
                continue
            ts, te = (datetime.fromisoformat(row[k].replace('Z', '+00:00')) for k in ['INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT'])
            if row['NODE'] not in NODES or te - ts != timedelta(minutes=minutes) or not start <= ts < end:
                raise ValueError('Unexpected source interval or node.')
            key = market, row['NODE'], iso(ts)
            value = float(row[column])
            if key in prices or not math.isfinite(value):
                raise ValueError('Duplicate or non-finite price.')
            prices[key] = value
    if len(prices) != hours * len(NODES) * 5:
        raise ValueError('Incomplete native price intervals.')
    fields = base['fields']
    base_rows = base['rows']
    old_dicts = [dict(zip(fields, row, strict=True)) for row in base_rows]
    regime = max(old_dicts, key=lambda r: r['startUtc']).get('marketRegime', 'unspecified')
    new = []
    for h in range(hours):
        ts = start + timedelta(hours=h)
        local = ts.astimezone(PT)
        offset = local.strftime('%z')
        for node in NODES:
            quarters = [prices['FMM', node, iso(ts + timedelta(minutes=15 * i))] for i in range(4)]
            total = 0.0
            for value in quarters:
                total += value
            row = {'node': node, 'startUtc': iso(ts), 'endUtc': iso(ts + timedelta(hours=1)),
                   'localDate': str(day), 'localHour': local.strftime('%H:%M'), 'utcOffset': offset[:3] + ':' + offset[3:],
                   'dam': prices['DAM', node, iso(ts)], 'fmm': total / 4, 'fmmCount': 4, 'paired': True, 'marketRegime': regime}
            new.append([row[k] for k in fields])
    combined = base_rows + new
    keys = [(r[fields.index('node')], r[fields.index('startUtc')]) for r in combined]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate combined price intervals.')
    source_keys = ['id', 'dataset', 'url', 'fetchedAt', 'sha256', 'bytes', 'rowCount']
    sources = [{k: r.get(k) for k in source_keys} for r in receipts]
    days = (day - date.fromisoformat(base['startDate'])).days + 1
    payload = {**base, 'dataset': f'price-history-{days}d-current', 'generatedAt': stamp(), 'endDate': str(day),
               'rows': combined, 'expectedNodeHours': len(combined), 'sources': base['sources'] + sources,
               'baselineArchiveSha256': hashlib.sha256(base_bytes).hexdigest(), 'modelStatus': 'available_for_current_run'}
    output.mkdir(parents=True, exist_ok=True)
    packed = gzip.compress(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode(), mtime=0)
    (output / 'price-history-current.json.gz').write_bytes(packed)
    atomic_json(output / 'price-addendum.json', {'schemaVersion': 1, 'fields': fields, 'rows': new,
                'startDate': str(day), 'endDate': str(day), 'classification': 'historical_prices_current_vintage', 'sources': sources})
    audit = {'generatedAt': stamp(), 'status': 'complete', 'newTradingDate': str(day), 'newNodeHours': len(new),
             'nativeDamLmpIntervals': hours * len(NODES), 'nativeFmmLmpIntervals': hours * len(NODES) * 4,
             'combinedTradingDays': days, 'combinedNodeHours': len(combined), 'oldRowsPreservedExactly': combined[:len(base_rows)] == base_rows,
             'sourcePublishedAt': None, 'timeEvidenceType': 'current_download_only', 'receivedAt': max(r['fetchedAt'] for r in receipts),
             'sourceReceipts': [r['id'] for r in receipts], 'unit': 'USD/MWh', 'utcStart': iso(start), 'utcEndExclusive': iso(end),
             'priceArchiveSha256': hashlib.sha256(packed).hexdigest(),
             'limitations': ['Historical versions may contain corrections; current receipt does not prove historical first availability.',
                            'Market regime marker is inherited from the baseline; a new rule change requires explicit review.',
                            'Only complete four-quarter FMM hours were accepted; no missing prices filled.']}
    atomic_json(output / 'current-prices-audit.json', audit)
    print(json.dumps(audit, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=ROOT / 'public/data/data-gaps/price-history-365d.json.gz')
    parser.add_argument('--input-dir', type=Path, default=ROOT / 'public/data/current-inputs/oasis')
    parser.add_argument('--date', type=date.fromisoformat, default=date(2026, 10, 29))
    parser.add_argument('--output', type=Path, default=ROOT / 'public/data/current-inputs')
    args = parser.parse_args()
    run(args.baseline, args.input_dir, args.date, args.output)


if __name__ == '__main__':
    main()
