"""Bounded public OASIS requests, exact raw receipts, and ZIP/XML decoding."""
from __future__ import annotations
from datetime import date,datetime,time as dtime,timedelta,timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import csv,hashlib,io,json,re,time,urllib.error,urllib.parse,urllib.request,zipfile
from xml.etree import ElementTree
ROOT=Path(__file__).resolve().parents[2]
PT=ZoneInfo('America/Los_Angeles')
NODES=['TH_NP15_GEN-APND','TH_SP15_GEN-APND','TH_ZP26_GEN-APND']
CACHE=ROOT/'public/data/current-inputs/oasis'
MAX_BYTES=32*1024*1024

def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    temporary.replace(path)

def utc(day):
    return datetime.combine(day, dtime(), PT).astimezone(timezone.utc).strftime('%Y%m%dT%H:%M-0000')

def request_spec(name, start, end, query=None, group=None, version=1, **parameters):
    params = {'resultformat': '6', 'version': str(version), 'startdatetime': utc(start), 'enddatetime': utc(end)}
    params['groupid' if group else 'queryname'] = group or query
    params.update(parameters)
    url = 'https://oasis.caiso.com/oasisapi/' + ('GroupZip' if group else 'SingleZip') + '?' + urllib.parse.urlencode(params)
    return {'id': f'{name}_{start}_{end}', 'dataset': name, 'startDate': str(start),
            'endDateExclusive': str(end), 'url': url, 'parameters': params}

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
