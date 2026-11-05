#!/usr/bin/env python3
"""Fetch only official observed Today's Outlook files, preserve original bytes and provenance.

Usage: python scripts/fetch-outlook-snapshot.py [YYYY-MM-DD ...]
Then: node scripts/test-outlook.mjs --write-snapshot
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
IDS = ['demand', 'netdemand', 'fuelsource', 'storage', 'hybrids', 'co2', 'rtm_forecast', 'rtm_forecast_7day', 'wind_solar_wo_hybrids', 'stats', 'peak_and_daily', 'peak_and_daily_hybrids', 'peak_and_daily_storage']
today = datetime.now(ZoneInfo('America/Los_Angeles')).date()
dates = sys.argv[1:] or [(today-timedelta(days=1)).isoformat(), today.isoformat()]
for date in dates:
    if datetime.strptime(date, '%Y-%m-%d').date().isoformat() != date:
        raise ValueError('Invalid date')

def fetch(pair):
    date, feed_id = pair
    filename = 'stats.txt' if feed_id == 'stats' else feed_id + '.csv'
    directory = 'current' if date == today.isoformat() else 'history/' + date.replace('-', '')
    url = f'https://www.caiso.com/outlook/{directory}/{filename}'
    item = {'id':feed_id, 'date':date, 'sourceUrl':url, 'fetchedAt':datetime.now(ZoneInfo('UTC')).isoformat().replace('+00:00','Z')}
    if feed_id == 'stats' and date != today.isoformat():
        return {**item,'status':0,'error':'CAISO 系统摘要仅提供当前状态。'}
    try:
        with urlopen(Request(url,headers={'Accept':'text/csv,text/plain,application/json'}), timeout=25) as response:
            raw=response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024: raise ValueError('Response too large')
            target=ROOT/'public'/'data'/'outlook_raw'/date/filename
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(raw)
            item.update(status=response.status, lastModified=response.headers.get('Last-Modified'), text=raw.decode('utf-8-sig'), sha256=sha256(raw).hexdigest(), bytes=len(raw), rawPath=f'/data/outlook_raw/{date}/{filename}')
    except HTTPError as error:
        item.update(status=error.code,error='官方尚未发布该日期数据。' if error.code==404 else f'官方返回 HTTP {error.code}')
    except Exception as error:
        item.update(status=-1,error=str(error))
    return item

with ThreadPoolExecutor(max_workers=3) as pool:
    files=list(pool.map(fetch,[(date,feed_id) for date in dates for feed_id in IDS]))
result={'generatedAt':datetime.now(ZoneInfo('UTC')).isoformat().replace('+00:00','Z'),'today':today.isoformat(),'files':files}
(ROOT/'data').mkdir(exist_ok=True)
(ROOT/'data'/'outlook-raw.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
provenance=[{key:value for key,value in entry.items() if key!='text'} for entry in files]
(ROOT/'public'/'data'/'outlook_provenance.json').write_text(json.dumps({'generatedAt':result['generatedAt'],'files':provenance},ensure_ascii=False,indent=2))
for date in dates:
    print(date, {str(status):sum(x['date']==date and x['status']==status for x in files) for status in sorted(set(x['status'] for x in files))})
print('Raw files saved; run node scripts/test-outlook.mjs --write-snapshot to normalize and verify.')
