#!/usr/bin/env python3
"""Extend archived OASIS DA/FMM prices through an explicitly selected local API.

Start the local workbench and pass --origin http://127.0.0.1:5173.
No remote private endpoint or authentication credential is included.
Only complete contiguous PT days are published, and original v1 files are untouched.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, time as daytime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PT = ZoneInfo('America/Los_Angeles')
UTC = timezone.utc
NODES = ['TH_NP15_GEN-APND', 'TH_SP15_GEN-APND', 'TH_ZP26_GEN-APND']
FIELDS = ['node', 'startUtc', 'endUtc', 'localDate', 'localHour', 'utcOffset', 'dam', 'fmm', 'fmmCount', 'paired']


def iso(value):
    return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def parse(value):
    answer = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if answer.tzinfo is None:
        raise ValueError('Interval timestamp lacks timezone')
    return answer.astimezone(UTC)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_bytes(encoded(value))
    os.replace(temporary, path)


def expected_hours(start, end):
    current = datetime.combine(start, daytime(), PT).astimezone(UTC)
    stop = datetime.combine(end + timedelta(days=1), daytime(), PT).astimezone(UTC)
    while current < stop:
        yield current
        current += timedelta(hours=1)


def normalize_pair(dam, fmm, start, end):
    """Mirror analytics.ts: exact one valid DA slot and four valid FMM slots per UTC hour."""
    indexes = {'DAM': defaultdict(list), 'FMM': defaultdict(list)}
    for market, response in [('DAM', dam), ('FMM', fmm)]:
        if not response.get('ok') or response.get('market') != market:
            raise ValueError('Invalid market response')
        if response.get('request', {}).get('startDate') != start.isoformat() or response.get('request', {}).get('endDate') != end.isoformat():
            raise ValueError('Response date range differs from request')
        for row in response.get('intervals', []):
            if row.get('node') not in NODES:
                raise ValueError('Unexpected node')
            ts, te = parse(row['startUtc']), parse(row['endUtc'])
            local = ts.astimezone(PT)
            if not start <= local.date() <= end:
                raise ValueError('Out of range interval')
            if row.get('localDate') != local.date().isoformat() or row.get('localHour') != local.strftime('%H:%M'):
                raise ValueError('Local / UTC mismatch')
            expected_minutes = 60 if market == 'DAM' else 15
            if te - ts != timedelta(minutes=expected_minutes):
                raise ValueError('Unexpected interval duration')
            hour = ts.replace(minute=0, second=0, microsecond=0)
            indexes[market][(row['node'], hour)].append((ts, row))
    rows = []
    for hour in expected_hours(start, end):
        for node in NODES:
            values = {}
            counts = {}
            for market in ['DAM', 'FMM']:
                minutes = 60 if market == 'DAM' else 15
                groups = defaultdict(list)
                for ts, row in indexes[market].get((node, hour), []):
                    elapsed = (ts - hour).total_seconds() / (minutes * 60)
                    if elapsed.is_integer() and 0 <= elapsed < 60 / minutes:
                        groups[int(elapsed)].append(row)
                valid = [group[0]['price'] for _, group in sorted(groups.items())
                         if len(group) == 1 and group[0].get('quality') == 'ok' and finite(group[0].get('price'))]
                counts[market] = len(valid)
                # Match JavaScript Array.reduce's left-to-right IEEE-754 addition;
                # Python 3.12 sum() uses an accuracy-improving algorithm instead.
                total = 0.0
                for value in valid:
                    total += value
                values[market] = total / len(valid) if len(valid) == 60 / minutes else None
            local = hour.astimezone(PT)
            offset = local.strftime('%z')
            rows.append({'node': node, 'startUtc': iso(hour), 'endUtc': iso(hour + timedelta(hours=1)),
                         'localDate': local.date().isoformat(), 'localHour': local.strftime('%H:%M'),
                         'utcOffset': offset[:3] + ':' + offset[3:], 'dam': values['DAM'], 'fmm': values['FMM'],
                         'fmmCount': counts['FMM'], 'paired': values['DAM'] is not None and values['FMM'] is not None})
    return rows


def windows_before(start, old_start):
    """Most recent windows first so an interrupted run still extends a contiguous history."""
    end = old_start - timedelta(days=1)
    while end >= start:
        beginning = max(start, end - timedelta(days=6))
        yield beginning, end
        end = beginning - timedelta(days=1)


def assemble(args, baseline, attempts):
    rows = {(r['node'], r['startUtc']): {k: r[k] for k in FIELDS} for r in baseline['rows']}
    source_urls, fetch_times = set(baseline['sourceUrls']), [baseline['fetchedAt']]
    window_audit = []
    for start, end in windows_before(args.start, date.fromisoformat(baseline['startDate'])):
        files = [args.cache / f'{start}_{end}_{market}.json' for market in ['DAM', 'FMM']]
        if not all(p.exists() for p in files):
            window_audit.append({'start':str(start), 'end':str(end), 'status':'missing_response'})
            continue
        try:
            responses = [json.loads(p.read_bytes()) for p in files]
            new_rows = normalize_pair(*responses, start, end)
            missing = sum(not r['paired'] for r in new_rows)
            if missing:
                window_audit.append({'start':str(start),'end':str(end),'status':'incomplete','missingHourlyPairs':missing})
                continue
            for row in new_rows:
                key = row['node'], row['startUtc']
                if key in rows and rows[key] != row:
                    raise ValueError('Conflicting duplicate hourly row')
                rows[key] = row
            for response in responses:
                source_urls.add(response['sourceUrl'])
                fetch_times.append(response['fetchedAt'])
            window_audit.append({'start':str(start),'end':str(end),'status':'complete','hourlyRows':len(new_rows),
                                 'responseSha256':[hashlib.sha256(p.read_bytes()).hexdigest() for p in files]})
        except (ValueError, KeyError, TypeError) as error:
            window_audit.append({'start':str(start),'end':str(end),'status':'invalid','reason':str(error)})
    by_day = defaultdict(list)
    for row in rows.values():
        by_day[row['localDate']].append(row)
    first = date.fromisoformat(baseline['startDate'])
    while first > args.start:
        prior = first - timedelta(days=1)
        wanted = {(node, iso(hour)) for hour in expected_hours(prior, prior) for node in NODES}
        found = {(r['node'],r['startUtc']) for r in by_day[prior.isoformat()] if r['paired'] and r['fmmCount']==4}
        if found != wanted:
            break
        first = prior
    result_rows = [r for r in rows.values() if first.isoformat() <= r['localDate'] <= args.end.isoformat()]
    result_rows.sort(key=lambda r:(r['startUtc'],r['node']))
    wanted_count = len(list(expected_hours(first,args.end))) * len(NODES)
    if len(result_rows) != wanted_count or any(not r['paired'] for r in result_rows):
        raise ValueError('Published contiguous archive is incomplete')
    raw_digest = hashlib.sha256(encoded(result_rows)).hexdigest()
    updated = iso(datetime.now(UTC))
    achieved_days = (args.end-first).days+1
    archive = {'id':f'oasis-expanded-{first}-{args.end}', 'name':f'OASIS 扩展研究历史 · {achieved_days} 日 / 3 枢纽',
               'createdAt':updated,'startDate':str(first),'endDate':str(args.end),'nodes':NODES,'rows':result_rows,
               'sourceUrls':sorted(source_urls),'fetchedAt':max(fetch_times),'digest':raw_digest,
               'warnings':['真实 OASIS DA/FMM；使用本次取得的历史版本，可能包含事后修订。',
                           '仅发布连续完整小时；未填补缺失价格；本次扩展不改变原 v1 输入及结果。']}
    audit = {'schemaVersion':1,'generatedAt':updated,'requestedStart':str(args.start),'requestedEnd':str(args.end),
             'actualStart':str(first),'actualEnd':str(args.end),'requestedDays':(args.end-args.start).days+1,
             'achievedDays':achieved_days,'hourlyRows':len(result_rows),'pairedRows':len(result_rows),
             'complete':first==args.start,'baselineArchiveDigest':baseline['digest'],'archiveDigest':raw_digest,
             'negativeDaRows':sum(r['dam']<0 for r in result_rows),'negativeFmmRows':sum(r['fmm']<0 for r in result_rows),
             'windows':window_audit,'attempts':attempts,
             'provenance':'Original Sep3–Oct28 rows preserved; additional weekly API responses retained as local raw cache; source URLs and hashes retained.'}
    atomic_json(args.output,archive)
    atomic_json(args.audit,audit)
    return audit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', help='Explicit loopback workbench URL, e.g. http://127.0.0.1:5173; unnecessary with --assemble-only')
    parser.add_argument('--start',type=date.fromisoformat,default=date(2026,5,2))
    parser.add_argument('--end',type=date.fromisoformat,default=date(2026,10,28))
    parser.add_argument('--baseline',type=Path,default=ROOT/'data/strategy-history.json')
    parser.add_argument('--output',type=Path,default=ROOT/'data/strategy-history-expanded.json')
    parser.add_argument('--audit',type=Path,default=ROOT/'research/extended-history-audit.json')
    parser.add_argument('--cache',type=Path,default=ROOT/'.sites-runtime/extended-history')
    parser.add_argument('--delay',type=float,default=8)
    parser.add_argument('--max-windows',type=int)
    parser.add_argument('--assemble-only',action='store_true')
    args=parser.parse_args()
    baseline=json.loads(args.baseline.read_bytes())
    if args.end.isoformat()!=baseline['endDate'] or set(baseline['nodes'])!=set(NODES):
        raise ValueError('End date and nodes must match the preserved baseline')
    if args.start>date.fromisoformat(baseline['startDate']):
        raise ValueError('Requested start must precede the baseline')
    attempts=[]
    args.cache.mkdir(parents=True,exist_ok=True)
    if args.assemble_only:
        audit=assemble(args,baseline,attempts)
        print(json.dumps({k:audit[k] for k in ['actualStart','actualEnd','achievedDays','hourlyRows','complete']}),flush=True)
        return
    if not args.origin:
        parser.error('--origin must explicitly select a running local workbench')
    parsed_origin=urllib.parse.urlsplit(args.origin)
    if (parsed_origin.scheme not in ('http','https')
        or parsed_origin.hostname not in ('localhost','127.0.0.1','::1')
        or parsed_origin.username or parsed_origin.password
        or parsed_origin.path not in ('','/') or parsed_origin.query or parsed_origin.fragment):
        parser.error('--origin must be a loopback HTTP(S) origin without credentials, path, query or fragment')
    origin=urllib.parse.urlunsplit((parsed_origin.scheme,parsed_origin.netloc,'','',''))
    opener=urllib.request.build_opener(NoRedirect)
    sequence=list(windows_before(args.start,date.fromisoformat(baseline['startDate'])))
    if args.max_windows is not None: sequence=sequence[:args.max_windows]
    failures=0
    last_request=0.0
    for window_index,(start,end) in enumerate(sequence):
        for market in ['DAM','FMM']:
            file=args.cache/f'{start}_{end}_{market}.json'
            if file.exists():
                previous=json.loads(file.read_bytes())
                if previous.get('ok') and previous.get('intervals'): continue
            time.sleep(max(0,args.delay-(time.monotonic()-last_request)))
            query=urllib.parse.urlencode({'market':market,'start':str(start),'end':str(end),'nodes':','.join(NODES)})
            request=urllib.request.Request(origin+'/api/prices?'+query,headers={'Accept':'application/json'})
            begun=last_request=time.monotonic()
            info={'start':str(start),'end':str(end),'market':market}
            try:
                try: response=opener.open(request,timeout=90)
                except urllib.error.HTTPError as error: response=error
                body=json.loads(response.read())
                info.update(http=response.code,ok=body.get('ok'),intervals=len(body.get('intervals',[])))
                if response.code==200 and body.get('ok') and body.get('intervals'):
                    atomic_json(file,body);failures=0
                else:
                    failures+=1;info['errorCode']=body.get('error',{}).get('code')
                if response.code in [401,403]:
                    attempts.append(info);print(json.dumps(info),flush=True)
                    raise RuntimeError('Local workbench rejected the request; stopped without changing access controls')
            except (urllib.error.URLError,TimeoutError,json.JSONDecodeError) as error:
                failures+=1;info['errorType']=type(error).__name__
            info['seconds']=round(time.monotonic()-begun,2)
            attempts.append(info);print(json.dumps(info),flush=True)
            if failures>=3:
                print('Stopped after three consecutive unavailable responses.',flush=True)
                audit=assemble(args,baseline,attempts)
                print(json.dumps({k:audit[k] for k in ['actualStart','actualEnd','achievedDays','hourlyRows','complete']}),flush=True)
                return
        audit=assemble(args,baseline,attempts)
        print(json.dumps({'progress':window_index+1,'windows':len(sequence),'days':audit['achievedDays'],'hourlyRows':audit['hourlyRows']}),flush=True)
    print(json.dumps({k:audit[k] for k in ['actualStart','actualEnd','achievedDays','hourlyRows','complete']}),flush=True)

if __name__=='__main__': main()
