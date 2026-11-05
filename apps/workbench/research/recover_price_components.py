#!/usr/bin/env python3
"""Recover native DA/FMM LMP components from existing, public OASIS responses.

Reads only the explicitly named price caches and bootstrap file. Does not fetch,
change frozen studies, aggregate FMM intervals, or infer publication timestamps.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PT = ZoneInfo('America/Los_Angeles')
COMPONENTS = ('MCE', 'MCC', 'MCL', 'MGHG')
MINUTES = {'DAM': 60, 'FMM': 15}
COMPONENT_TOLERANCE = 0.0001


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError('Timestamp must be a timezone-aware string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Naive timestamp is not allowed')
    return parsed.astimezone(timezone.utc)


def canonical_time(value: str) -> str:
    return timestamp(value).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def numeric_or_null(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Price/component must be a finite number or null')
    return value


def normalize_record(market: str, row: dict) -> dict:
    """Validate timing and preserve null, negative, and zero component values."""
    if market not in MINUTES:
        raise ValueError('Unsupported source market')
    start, end = timestamp(row['startUtc']), timestamp(row['endUtc'])
    minutes = MINUTES[market]
    if (end - start).total_seconds() != minutes * 60 or row['minutes'] != minutes:
        raise ValueError('Native interval duration differs from its market')
    if start.second or start.microsecond or start.minute % minutes:
        raise ValueError('Source interval is not aligned to its native grid')
    local = start.astimezone(PT)
    offset = local.strftime('%z')
    expected_offset = offset[:3] + ':' + offset[3:]
    if (row['localDate'], row['localHour'], row['utcOffset']) != (
            local.date().isoformat(), local.strftime('%H:%M'), expected_offset):
        raise ValueError('Source PT labels conflict with the UTC interval')
    if not isinstance(row['node'], str) or not row['node']:
        raise ValueError('Missing node')
    return {
        'market': market, 'node': row['node'],
        'startUtc': canonical_time(row['startUtc']), 'endUtc': canonical_time(row['endUtc']),
        'localDate': row['localDate'], 'localTime': row['localHour'], 'utcOffset': row['utcOffset'],
        'intervalMinutes': minutes, 'hourEnding': row.get('hourEnding'),
        'lmp': numeric_or_null(row.get('price')),
        'components': {key: numeric_or_null(row.get('components', {}).get(key)) for key in COMPONENTS},
        'quality': row.get('quality', 'unknown'), 'publishTimeUtc': None,
    }


def merge_record(records: dict, record: dict, source_id: str, fetched_at: str) -> bool:
    """Return True for a semantic duplicate, and reject conflicting observations."""
    key = record['market'], record['node'], record['startUtc']
    previous = records.get(key)
    if previous is not None:
        original = {k: v for k, v in previous.items() if k not in ('sourceReportIds', 'fetchedAt')}
        if original != record:
            raise ValueError(f'Conflicting duplicate price interval: {key}')
        if source_id not in previous['sourceReportIds']:
            previous['sourceReportIds'].append(source_id)
        # Earliest observed fetch is retained; all source times remain in sources.
        previous['fetchedAt'] = min(previous['fetchedAt'], fetched_at)
        return True
    records[key] = record | {'fetchedAt': fetched_at, 'sourceReportIds': [source_id]}
    return False


def component_identity(row: dict):
    values = list(row['components'].values())
    if row['lmp'] is None or any(v is None for v in values):
        return None
    return abs(sum(values) - row['lmp'])


def market_audit(market: str, rows: list[dict], start: date, end: date, nodes: list[str], duplicates: int):
    keys = {(r['node'], r['startUtc']) for r in rows}
    expected = 0
    missing = []
    current = start
    while current <= end:
        point = datetime.combine(current, datetime.min.time(), tzinfo=PT).astimezone(timezone.utc)
        stop = datetime.combine(current + timedelta(days=1), datetime.min.time(), tzinfo=PT).astimezone(timezone.utc)
        while point < stop:
            label = point.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            for node in nodes:
                expected += 1
                if (node, label) not in keys:
                    missing.append({'node': node, 'startUtc': label})
            point += timedelta(minutes=MINUTES[market])
        current += timedelta(days=1)
    diffs = [component_identity(r) for r in rows]
    measured = [v for v in diffs if v is not None]
    counts = {}
    for component in COMPONENTS:
        values = [r['components'][component] for r in rows]
        finite = [v for v in values if v is not None]
        counts[component] = {'nonNull': len(finite), 'missing': len(values)-len(finite),
                             'negative': sum(v < 0 for v in finite), 'zero': sum(v == 0 for v in finite),
                             'minimum': min(finite) if finite else None, 'maximum': max(finite) if finite else None}
    return {'market': market, 'marketRun': 'DAM' if market == 'DAM' else 'RTPD',
            'intervalMinutes': MINUTES[market], 'rowCount': len(rows), 'nodeCount': len(nodes),
            'expectedIntervalCount': expected, 'missingIntervals': len(missing), 'missingExamples': missing[:6],
            'identicalDuplicates': duplicates, 'conflictingDuplicates': 0,
            'lmpMissing': sum(r['lmp'] is None for r in rows),
            'lmpNegative': sum(r['lmp'] is not None and r['lmp'] < 0 for r in rows),
            'lmpZero': sum(r['lmp'] == 0 for r in rows),
            'qualityCounts': dict(Counter(r['quality'] for r in rows)), 'components': counts,
            'componentIdentity': {'checkedRows': len(measured), 'uncheckableRows': len(rows)-len(measured),
                                  'absoluteToleranceUsdPerMwh': COMPONENT_TOLERANCE,
                                  'maximumAbsoluteDifferenceUsdPerMwh': max(measured) if measured else None,
                                  'outsideTolerance': sum(v > COMPONENT_TOLERANCE for v in measured)}}


def recover(repo: Path, output: Path):
    reference = json.loads((repo / 'data/strategy-history-expanded.json').read_text())
    start, end = date.fromisoformat(reference['startDate']), date.fromisoformat(reference['endDate'])
    nodes = reference['nodes']
    records, sources, duplicates = {}, [], Counter()

    def accept(report: dict, path: Path, file_sha: str):
        market = report.get('market')
        if market not in MINUTES or report.get('ok') is not True:
            raise ValueError(f'Unexpected public price cache: {path.name}')
        source_url = report['sourceUrl']
        url = urlsplit(source_url)
        if url.scheme != 'https' or url.netloc != 'oasis.caiso.com' or url.path != '/oasisapi/SingleZip':
            raise ValueError('Cached report does not identify the expected public OASIS endpoint')
        fetched_at = canonical_time(report['fetchedAt'])
        source_id = market + '-' + file_sha[:20]
        sources.append({'id': source_id, 'file': str(path.relative_to(repo)), 'sha256': file_sha,
                        'sourceUrl': source_url, 'fetchedAt': fetched_at,
                        'market': market, 'intervalRows': len(report['intervals'])})
        for original in report['intervals']:
            record = normalize_record(market, original)
            if record['node'] not in nodes or not reference['startDate'] <= record['localDate'] <= reference['endDate']:
                raise ValueError('Unexpected node or interval outside the declared archive')
            duplicates[market] += merge_record(records, record, source_id, fetched_at)

    for relative in ('.sites-runtime/extended-history', '.sites-runtime/strategy-history'):
        files = sorted((repo / relative).glob('*.json'))
        if not files:
            raise ValueError(f'Missing original public cache: {relative}')
        for path in files:
            raw = path.read_bytes()
            accept(json.loads(raw), path, sha256(raw))
    bootstrap_path = repo / 'data/bootstrap.json'
    raw = bootstrap_path.read_bytes()
    bootstrap = json.loads(raw)
    for market in MINUTES:
        accept(bootstrap['markets'][market], bootstrap_path, sha256(raw))

    ordered = sorted(records.values(), key=lambda r: (r['market'], r['startUtc'], r['node']))
    audits = [market_audit(m, [r for r in ordered if r['market'] == m], start, end, nodes, duplicates[m]) for m in MINUTES]
    if any(a['componentIdentity']['outsideTolerance'] for a in audits):
        raise ValueError('LMP component identity exceeds the declared tolerance')
    if any(a['missingIntervals'] for a in audits):
        raise ValueError('Existing public caches do not cover the declared complete price window')
    generated_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    semantics = {
        'MCE': 'Marginal cost of energy', 'MCC': 'Marginal cost of congestion',
        'MCL': 'Marginal cost of losses', 'MGHG': 'Marginal greenhouse gas component',
        'fetchedAt': 'Actual retrieval timestamp of an existing source response, not first publication time.',
        'publishTimeUtc': 'Null: original publication/version availability is not proven by these historical responses.',
        'sourceReportIds': 'References to source URL, source cache SHA-256 and original retrieval metadata.',
    }
    dataset = {'schemaVersion': 1, 'id': 'oasis-native-price-components-180d', 'generatedAt': generated_at,
               'classification': 'historical_actual_reconstruction', 'timeZone': 'America/Los_Angeles',
               'unit': 'USD/MWh', 'startDate': reference['startDate'], 'endDate': reference['endDate'],
               'nodes': nodes, 'fieldDefinitions': semantics, 'sourcePriceArchiveDigest': reference['digest'],
               'modelUsage': 'not_used_in_frozen_V1_V2_V3', 'historicalVintageVerified': False,
               'sources': sources, 'rows': ordered}
    encoded = json_bytes(dataset)
    compressed = gzip.compress(encoded, mtime=0)
    output.mkdir(parents=True, exist_ok=True)
    download = output / 'price-components-180d.json.gz'
    download.write_bytes(compressed)
    examples = []
    for market in MINUTES:
        examples.extend([r for r in ordered if r['market'] == market][:3])
    audit = {
        'schemaVersion': 1, 'id': dataset['id'], 'generatedAt': generated_at,
        'status': 'recovered_existing_public_cache', 'source': 'CAISO OASIS',
        'classification': dataset['classification'], 'historicalVintageVerified': False,
        'usedInCurrentModel': False, 'timeZone': dataset['timeZone'], 'unit': dataset['unit'],
        'coverage': {'startDate': reference['startDate'], 'endDate': reference['endDate'],
                     'days': (end-start).days+1, 'nodes': nodes, 'nativeRows': len(ordered)},
        'download': {'path': '/data/data-gaps/' + download.name, 'bytes': len(compressed),
                     'sha256': sha256(compressed), 'uncompressedBytes': len(encoded), 'uncompressedSha256': sha256(encoded)},
        'markets': audits, 'sourceReports': len(sources), 'sources': sources,
        'fieldDefinitions': semantics, 'sampleRows': examples,
        'limitations': [
            'Retains native 60-minute DAM and 15-minute FMM intervals; FMM has not been averaged to an hour.',
            'Source retrieval times describe when the existing response was acquired; they are not historical first-publication evidence.',
            'The three hubs are not a complete CAISO pricing-node universe; a price does not establish virtual trading eligibility.',
            'Components describe LMP construction and are not transmission limits, outages, or a complete settlement ledger.',
            'No frozen V1/V2/V3 model, result, or input was changed by this recovery.',
        ],
    }
    (output / 'price-components-audit.json').write_bytes(json_bytes(audit))
    print(json.dumps({'audit': str(output/'price-components-audit.json'), 'download': str(download),
                      'nativeRows': len(ordered), 'bytes': len(compressed), 'markets': audits}, ensure_ascii=False))
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, default=ROOT/'public/data/data-gaps')
    args = parser.parse_args()
    recover(args.repo_root.resolve(), args.output.resolve())
