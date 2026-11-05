#!/usr/bin/env python3
"""Acquire public CAISO reports with receipts; no account, key or model mutation.

Only the two fixed OASIS HTTPS endpoints are reachable. Reports are fetched
sequentially; an HTTP 200 XML error is never recorded as a successful dataset.
Historical retrieval is a current snapshot, not evidence of its original vintage.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date, datetime, time as dtime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PT = ZoneInfo('America/Los_Angeles')
NODES = ['TH_NP15_GEN-APND', 'TH_SP15_GEN-APND', 'TH_ZP26_GEN-APND']
CACHE = ROOT / '.sites-runtime/gap-acquisition'
MAX_BYTES = 32 * 1024 * 1024


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    temporary.replace(path)


def windows(start, end, days=30):
    while start < end:
        stop = min(start + timedelta(days=days), end)
        yield start, stop
        start = stop


def utc(day):
    return datetime.combine(day, dtime(), PT).astimezone(timezone.utc).strftime('%Y%m%dT%H:%M-0000')


def request_spec(name, start, end, query=None, group=None, version=1, **parameters):
    params = {'resultformat': '6', 'version': str(version), 'startdatetime': utc(start), 'enddatetime': utc(end)}
    params['groupid' if group else 'queryname'] = group or query
    params.update(parameters)
    url = 'https://oasis.caiso.com/oasisapi/' + ('GroupZip' if group else 'SingleZip') + '?' + urllib.parse.urlencode(params)
    return {'id': f'{name}_{start}_{end}', 'dataset': name, 'startDate': str(start),
            'endDateExclusive': str(end), 'url': url, 'parameters': params}


def campaign(name):
    start, end = date(2026, 5, 2), date(2026, 10, 29)
    day = date(2026, 10, 28)
    if name == 'priority':
        # Verify short, high-value report schemas before the historical backfill.
        yield request_spec('generation_outages', day, day + timedelta(days=1), group='AGGR_OUTAGE_SCH_GRP')
        yield request_spec('cb_nodes', day, day + timedelta(days=1), query='ATL_CBNODE', version=2)
        for node in NODES:
            yield request_spec('cb_limits_' + node.split('_')[1], day, day + timedelta(days=1), query='CB_NODAL_LIMITS', node_id=node)
        yield request_spec('cb_cleared', day, day + timedelta(days=1), query='ENE_CB_CLR_AWARDS')
        yield request_spec('frp_nodal', day, day + timedelta(days=1), group='RTPD_FLEX_RAMP_NODAL_PRC_GRP')
        yield request_spec('publication_log', day, day + timedelta(days=1), query='ATL_PUB')
        yield request_spec('transmission_usage', day, day + timedelta(days=1), query='TRNS_USAGE', market_run_id='DAM', ti_id='ALL', ti_direction='ALL')
        for a, b in windows(start, end):
            for market in ['DAM', '2DA', '7DA']:
                yield request_spec('load_' + market.lower(), a, b, query='SLD_FCST', market_run_id=market)
            yield request_spec('renewables_dam', a, b, query='SLD_REN_FCST', market_run_id='DAM')
            yield request_spec('fuel_prices', a, b, query='PRC_FUEL', fuel_region_id='ALL')
            yield request_spec('ghg_allowance', a, b, query='PRC_GHG_ALLOWANCE')
    elif name == 'seasonal':
        # Preserve the frozen 180-day archives; obtain the earlier seasonal window separately.
        for a, b in windows(date(2025, 10, 29), date(2026, 5, 2)):
            yield request_spec('price_dam', a, b, query='PRC_LMP', version=12, market_run_id='DAM', node=','.join(NODES))
            yield request_spec('price_fmm', a, b, query='PRC_RTPD_LMP', version=3, market_run_id='RTPD', node=','.join(NODES))
    elif name == 'vintage':
        yield request_spec('publication_log', date(2026, 10, 27), date(2026, 10, 28), query='ATL_PUB')
        for a, b in windows(start, end, days=1):
            yield request_spec('edam_history', a, b, group='EDAM_WND_SLR_FORECAST_GRP', resultformat='5')
    elif name == 'node_history':
        nodes = [f'TH_{hub}_GEN_{block}-APND' for hub in ['NP15', 'SP15', 'ZP26'] for block in ['ONPEAK', 'OFFPEAK']]
        for a, b in windows(start, end):
            yield request_spec('peak_history', a, b, query='ATL_PEAK_ON_OFF')
            yield request_spec('cb_history_dam', a, b, query='PRC_LMP', version=12, market_run_id='DAM', node=','.join(nodes))
            yield request_spec('cb_history_fmm', a, b, query='PRC_RTPD_LMP', version=3, market_run_id='RTPD', node=','.join(nodes))
    elif name == 'supplemental':
        nodes = [f'TH_{hub}_GEN_{block}-APND' for hub in ['NP15', 'SP15', 'ZP26'] for block in ['ONPEAK', 'OFFPEAK']]
        yield request_spec('edam_renewables', day, day + timedelta(days=1), group='EDAM_WND_SLR_FORECAST_GRP', resultformat='5')
        yield request_spec('frp_nodal_selected', day, day + timedelta(days=1), query='FLEX_RAMP_NODAL_PRC', market_run_id='RTPD', node=','.join(nodes))
        yield request_spec('peak_calendar', date(2026, 10, 15), day + timedelta(days=1), query='ATL_PEAK_ON_OFF')
        yield request_spec('cb_tradable_dam', date(2026, 10, 15), day + timedelta(days=1), query='PRC_LMP', version=12, market_run_id='DAM', node=','.join(nodes))
        yield request_spec('cb_tradable_fmm', date(2026, 10, 15), day + timedelta(days=1), query='PRC_RTPD_LMP', version=3, market_run_id='RTPD', node=','.join(nodes))
        for node in nodes:
            yield request_spec('cb_limit_' + node.replace('-', '_'), day, day + timedelta(days=1), query='CB_NODAL_LIMITS', node_id=node)
        yield request_spec('cb_group_limits', day, day + timedelta(days=1), query='CB_NODAL_GRP_CNSTR_PRC')
        yield request_spec('credit_reference', day, day + timedelta(days=1), query='PRC_DS_REF', version=3, market_run_id='DAM', node_id='ALL')
        yield request_spec('cb_system_awards', day, day + timedelta(days=1), query='ENE_CB_AWARDS')
        yield request_spec('frp_nodal', day, day + timedelta(days=1), group='RTPD_FLEX_RAMP_NODAL_PRC_GRP')
    else:
        raise ValueError('Unknown campaign')


def decode(raw):
    if not raw.startswith(b'PK'):
        text = raw.decode('utf-8', errors='replace')
        code = re.search(r'<(?:\w+:)?ERR_CODE[^>]*>([^<]*)', text)
        return [], {'code': code[1] if code else 'NOT_ZIP', 'message': 'No CSV archive returned'}
    records, members = [], []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(f.file_size for f in archive.infolist()) > 160 * 1024 * 1024:
            raise ValueError('Expanded report exceeds size limit')
        if archive.testzip() is not None:
            raise ValueError('Invalid ZIP checksum')
        for name in archive.namelist():
            body = archive.read(name).decode('utf-8-sig')
            members.append(name)
            if name.lower().endswith('.xml'):
                code = re.search(r'<(?:\w+:)?ERR_CODE[^>]*>([^<]*)', body)
                desc = re.search(r'<(?:\w+:)?ERR_DESC[^>]*>([^<]*)', body)
                if code:
                    return [], {'code': code[1], 'message': desc[1] if desc else 'OASIS report error', 'members': members}
                root = ElementTree.fromstring(body)
                ns = '{http://www.caiso.com/soa/EDAMWindAndSolarForecast_v1.xsd}'
                if root.tag.startswith(ns):
                    header = root.find(f'./{ns}MessageHeader/{ns}TimeDate')
                    for record in root.iter(f'{ns}REPORT_DATA'):
                        item = {child.tag.replace(ns, ''): child.text for child in record}
                        item['_SOURCE_MESSAGE_TIME'] = header.text if header is not None else None
                        item['_SOURCE_FILE'] = name
                        records.append(item)
            elif name.lower().endswith('.csv'):
                records.extend(dict(row) for row in csv.DictReader(io.StringIO(body)))
    if not records:
        return [], {'code': 'NO_CSV_ROWS', 'message': 'No CSV rows in response', 'members': members}
    return records, None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def acquire(spec, last_request, force=False, delay=8):
    receipt_path = CACHE / (spec['id'] + '.json')
    raw_path = CACHE / (spec['id'] + '.zip')
    if receipt_path.exists() and raw_path.exists() and not force:
        old = json.loads(receipt_path.read_text())
        if old.get('status') == 'downloaded' and old['url'] == spec['url'] and hashlib.sha256(raw_path.read_bytes()).hexdigest() == old['sha256']:
            return old, last_request
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(2):
        time.sleep(max(0, delay - (time.monotonic() - last_request)))
        last_request = time.monotonic()
        receipt = {**spec, 'requestedAt': stamp(), 'status': 'unavailable', 'publishTimeUtc': None,
                   'vintageEvidence': 'current_download_only', 'rawFile': raw_path.name}
        try:
            request = urllib.request.Request(spec['url'], headers={'Accept': 'application/zip', 'User-Agent': 'CAISO-research-data-audit/1.0'})
            with opener.open(request, timeout=55) as response:
                receipt['httpStatus'] = response.status
                receipt['lastModified'] = response.headers.get('Last-Modified')
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError('Compressed report exceeds size limit')
            raw_path.write_bytes(raw)
            receipt.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(), fetchedAt=stamp())
            rows, error = decode(raw)
            if error:
                receipt['error'] = error
                if error['code'] == '1015' and attempt == 0:
                    print(json.dumps({'id': spec['id'], 'status': 'upstream_processing_retry'}), flush=True)
                    time.sleep(20)
                    continue
            else:
                columns = sorted({key for row in rows for key in row})
                times = [row.get('INTERVALSTARTTIME_GMT') or row.get('INTERVAL_START_GMT') for row in rows if row.get('INTERVALSTARTTIME_GMT') or row.get('INTERVAL_START_GMT')]
                publish_fields = [key for key in columns if key in ['REPORT_DATE_GMT', 'PUBLISH_TIME_GMT', 'PUBLISH_TIME', 'PUBLICATION_DATE_GMT', '_SOURCE_MESSAGE_TIME']]
                receipt.update(status='downloaded', rowCount=len(rows), columns=columns,
                               firstIntervalUtc=min(times) if times else None, lastIntervalUtc=max(times) if times else None,
                               sourcePublishFields=publish_fields, sampleRows=rows[:3])
        except (urllib.error.URLError, TimeoutError, ValueError, zipfile.BadZipFile, UnicodeDecodeError) as error:
            receipt.update(fetchedAt=stamp(), error={'code': type(error).__name__, 'message': str(error)[:300]})
            if isinstance(error, urllib.error.HTTPError):
                receipt['httpStatus'] = error.code
                if 300 <= error.code < 400:
                    receipt['redirectLocation'] = error.headers.get('Location')
                if error.code == 429 and attempt == 0:
                    time.sleep(20)
                    continue
        atomic_json(receipt_path, receipt)
        return receipt, last_request
    raise RuntimeError('Unreachable acquisition state')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign', choices=['priority', 'seasonal', 'supplemental', 'vintage', 'node_history'], default='priority')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--delay', type=float, default=8)
    args = parser.parse_args()
    if args.delay < 5.1:
        parser.error('Public report spacing must be at least 5.1 seconds')
    CACHE.mkdir(parents=True, exist_ok=True)
    specs = list(campaign(args.campaign))[:args.limit]
    last_request = 0
    results = []
    for spec in specs:
        result, last_request = acquire(spec, last_request, args.force, args.delay)
        results.append(result)
        print(json.dumps({k: result.get(k) for k in ['id', 'status', 'rowCount', 'bytes', 'error']}, ensure_ascii=False), flush=True)
        atomic_json(CACHE / ('campaign-' + args.campaign + '.json'), {'generatedAt': stamp(), 'reports': results})
    print(json.dumps({'campaign': args.campaign, 'complete': len(results), 'downloaded': sum(r['status'] == 'downloaded' for r in results)}), flush=True)


if __name__ == '__main__':
    main()
