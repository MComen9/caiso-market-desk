#!/usr/bin/env python3
"""Import a verified OASIS research snapshot into the page contract; no network calls."""
import csv
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
data = json.loads(source.read_text())
start, end = data['range']['start'], data['range']['end']
zone = ZoneInfo('America/Los_Angeles')
def iso(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
window_start = iso(dt.datetime.fromisoformat(start).replace(tzinfo=zone))
window_end = iso((dt.datetime.fromisoformat(end) + dt.timedelta(days=1)).replace(tzinfo=zone))
bootstrap = {'label':'OASIS 官方历史快照','startDate':start,'endDate':end,'markets':{}}
provenance = {'source':'CAISO OASIS','timeZone':'America/Los_Angeles','unit':'USD/MWh','range':data['range'],'markets':{}}
csv_rows = []
for upstream, market in [('DAM','DAM'),('RTPD','FMM'),('RTM','RTD')]:
    report = data['markets'][upstream]
    intervals = []
    for row in report['rows']:
        ts = dt.datetime.fromisoformat(row['start'].replace('Z','+00:00'))
        te = dt.datetime.fromisoformat(row['end'].replace('Z','+00:00'))
        local = ts.astimezone(zone)
        offset = local.strftime('%z')
        interval = {'node':row['node'],'startUtc':iso(ts),'endUtc':iso(te),
            'localDate':local.strftime('%Y-%m-%d'),'localHour':local.strftime('%H:%M'),
            'utcOffset':offset[:3]+':'+offset[3:],'hourEnding':local.hour+1,
            'minutes':int((te-ts).total_seconds()/60),'price':row['lmp'],
            'components':row['components'],'quality':'ok' if row['lmp'] is not None else 'missing'}
        intervals.append(interval)
        csv_rows.append([market,interval['node'],interval['startUtc'],interval['endUtc'],
            interval['localDate'],interval['localHour'],interval['utcOffset'],interval['minutes'],interval['price'],
            *[interval['components'].get(k,'') for k in ['MCE','MCC','MCL','MGHG']],report['retrievedAt']])
    intervals.sort(key=lambda r:(r['node'],r['startUtc']))
    bootstrap['markets'][market] = {'ok':True,'market':market,'source':'CAISO OASIS','sourceUrl':report['url'],
        'fetchedAt':report['retrievedAt'],'cached':False,
        'request':{'startDate':start,'endDate':end,'nodes':data['nodes'],'startUtc':window_start,'endUtc':window_end},
        'intervals':intervals,'warnings':[]}
    provenance['markets'][market] = {k:v for k,v in report.items() if k != 'rows'}
    provenance['markets'][market]['normalizedCount'] = len(intervals)
(root/'data').mkdir(exist_ok=True)
(root/'public/data').mkdir(parents=True,exist_ok=True)
(root/'data/bootstrap.json').write_text(json.dumps(bootstrap,ensure_ascii=False,separators=(',',':')))
(root/'public/data/provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2))
csv_path = root/f'public/data/oasis_prices_{start}_{end}.csv'
with csv_path.open('w',encoding='utf-8-sig',newline='') as handle:
    writer = csv.writer(handle)
    writer.writerow(['market','node','interval_start_utc','interval_end_utc','date_pt','time_pt','utc_offset',
        'interval_minutes','LMP_USD_MWh','MCE_USD_MWh','MCC_USD_MWh','MCL_USD_MWh','MGHG_USD_MWh','fetched_at_utc'])
    writer.writerows(sorted(csv_rows,key=lambda r:(r[1],r[2],r[0])))
print(json.dumps({'startDate':start,'endDate':end,'records':len(csv_rows),'csv':str(csv_path)},ensure_ascii=False))
