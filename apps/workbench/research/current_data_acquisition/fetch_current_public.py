#!/usr/bin/env python3
"""Download one completed PT date of public hub prices with bounded requests.

No key, account, or paid source is used. Running this command performs network
requests; normalization is a separate, offline command.
"""
from pathlib import Path
from datetime import date, datetime, timedelta, timezone
import argparse
import json

import oasis_public as fetch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', type=date.fromisoformat, default=date(2026, 10, 29))
    parser.add_argument('--output', type=Path, default=fetch.ROOT / 'public/data/current-inputs/oasis')
    parser.add_argument('--include-frp-sample', action='store_true', help='Optional one-day sample; at most one retry for processing status.')
    args = parser.parse_args()
    if args.date >= datetime.now(timezone.utc).astimezone(fetch.PT).date():
        parser.error('Choose a completed Pacific trading date.')
    fetch.CACHE = args.output
    fetch.CACHE.mkdir(parents=True, exist_ok=True)
    end = args.date + timedelta(days=1)
    nodes = ','.join(fetch.NODES)
    specs = [
        fetch.request_spec('price_dam', args.date, end, query='PRC_LMP', version=12, market_run_id='DAM', node=nodes),
        fetch.request_spec('price_fmm', args.date, end, query='PRC_RTPD_LMP', version=3, market_run_id='RTPD', node=nodes),
    ]
    if args.include_frp_sample:
        specs.append(fetch.request_spec('frp_nodal', args.date, end, group='RTPD_FLEX_RAMP_NODAL_PRC_GRP'))
    last, results = 0, []
    for spec in specs:
        result, last = fetch.acquire(spec, last, delay=8)
        results.append(result)
        print(json.dumps({k: result.get(k) for k in ['id', 'status', 'rowCount', 'httpStatus', 'error']}, ensure_ascii=False), flush=True)
    fetch.atomic_json(args.output / 'receipts.json', {'generatedAt': fetch.stamp(), 'reports': results})


if __name__ == '__main__':
    main()
