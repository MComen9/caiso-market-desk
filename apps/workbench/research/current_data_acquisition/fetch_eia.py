#!/usr/bin/env python3
"""Optional public EIA workbook download; the large raw file stays in ignored local cache."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://www.eia.gov/electricity/gridmonitor/knownissues/xls/CISO.xlsx'


def stamp():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-cache', type=Path, default=ROOT / '.sites-runtime/current-inputs/eia')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/data/current-inputs/eia')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.raw_cache.mkdir(parents=True, exist_ok=True)
    result = {'url': URL, 'requestedAt': stamp(), 'source': 'EIA-930 CISO', 'sourcePublishedAt': None,
              'timeEvidenceType': 'current_download_only', 'status': 'unavailable', 'rawFileIncluded': False,
              'rawFileDelivery': 'Raw workbook remains in local cache; only normalized inputs are published.'}
    try:
        request = urllib.request.Request(URL, headers={'User-Agent': 'CAISO-open-data-research/1.0'})
        with urllib.request.urlopen(request, timeout=50) as response:
            result.update(httpStatus=response.status, contentType=response.headers.get('Content-Type'),
                          lastModified=response.headers.get('Last-Modified'))
            body = response.read(160 * 1024 * 1024 + 1)
        if len(body) > 160 * 1024 * 1024 or not body.startswith(b'PK'):
            raise ValueError('Not an XLSX archive within the size limit.')
        (args.raw_cache / 'CISO.xlsx').write_bytes(body)
        result.update(receivedAt=stamp(), bytes=len(body), sha256=hashlib.sha256(body).hexdigest(),
                      status='downloaded', rawFile='CISO.xlsx', normalizedFile='eia930-ciso-current.json.gz')
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        result.update(receivedAt=stamp(), error={'type': type(error).__name__, 'message': str(error)[:300]})
        if isinstance(error, urllib.error.HTTPError):
            result['httpStatus'] = error.code
    (args.output / 'receipt.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
