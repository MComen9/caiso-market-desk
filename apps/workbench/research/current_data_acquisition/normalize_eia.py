#!/usr/bin/env python3
"""Offline EIA normalization; requires openpyxl. All input/output paths are configurable."""
from pathlib import Path
import openpyxl,json,gzip,math,hashlib
from collections import Counter
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
import argparse
ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description='Normalize reported EIA-930 hourly data from a matching local workbook and receipt. No network calls.')
parser.add_argument('--raw-file',type=Path,default=ROOT/'.sites-runtime/current-inputs/eia/CISO.xlsx')
parser.add_argument('--receipt',type=Path,default=ROOT/'public/data/current-inputs/eia/receipt.json')
parser.add_argument('--output',type=Path,default=ROOT/'public/data/current-inputs/eia')
parser.add_argument('--start',default='2025-10-29')
parser.add_argument('--end',default='2026-10-29')
args=parser.parse_args()
P=args.output;P.mkdir(parents=True,exist_ok=True);PT=ZoneInfo('America/Los_Angeles')
START=args.start;END=args.end
if START>END:parser.error('Start must not follow end.')
chosen={'Demand':'demandMw','Net generation':'netGenerationMw','Total interchange':'netInterchangeMw','NG: BAT':'batteryGenerationMw','NG: SUN':'solarGenerationMw','NG: WND':'windGenerationMw','NG: NG':'gasGenerationMw','NG: NUC':'nuclearGenerationMw','NG: WAT':'hydroGenerationMw','NG: PS':'pumpedStorageGenerationMw'}
for ba in ['AZPS','BANC','BPAT','CEN','CFE','IID','LDWP','NEVP','PACW','SRP','TIDC','WALC']:chosen[ba]='interchange'+ba+'Mw'
fields=['startUtc','endUtc','localDate','localHour','utcOffset']+list(chosen.values())
receipt=json.loads(args.receipt.read_text())
if receipt['status']!='downloaded' or hashlib.sha256(args.raw_file.read_bytes()).hexdigest()!=receipt['sha256']:
 raise ValueError('The raw workbook does not match the successful receipt.')
w=openpyxl.load_workbook(args.raw_file,read_only=True,data_only=True)
s=w['Published Hourly Data'];iterator=s.iter_rows(values_only=True);headers=next(iterator);idx={k:i for i,k in enumerate(headers)}
rows=[];seen=set();issues=Counter();notes=[];state={k:{'count':0,'null':0,'zero':0,'negative':0,'min':None,'max':None,'lastValidStartUtc':None} for k in chosen.values()}
def iso(t):return t.isoformat(timespec='milliseconds').replace('+00:00','Z')
for n,row in enumerate(iterator):
 rawt=row[idx['UTC time']]
 if not isinstance(rawt,datetime):issues['invalidTimestamp']+=1;continue
 te=rawt.replace(tzinfo=timezone.utc);ts=te-timedelta(hours=1);local=ts.astimezone(PT);day=local.date().isoformat()
 if day<START or day>END:continue
 assert row[idx['BA']]=='CISO'
 assert ts not in seen;seen.add(ts)
 if row[idx['Local date']].date().isoformat()!=day:issues['sourceLocalDateMismatch']+=1
 vals=[]
 for source,key in chosen.items():
  value=row[idx[source]]
  if value is None or value=='':value=None
  elif isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):issues['invalidValue']+=1;value=None
  stat=state[key]
  if value is None:stat['null']+=1
  else:
   stat['count']+=1;stat['zero']+=int(value==0);stat['negative']+=int(value<0)
   stat['min']=value if stat['min'] is None else min(stat['min'],value)
   stat['max']=value if stat['max'] is None else max(stat['max'],value)
   stat['lastValidStartUtc']=iso(ts)
  vals.append(value)
 offset=local.strftime('%z');rows.append([iso(ts),iso(te),day,local.strftime('%H:%M'),offset[:3]+':'+offset[3:]]+vals)
 if n%10000==0:print('parsed',n,'selected',len(rows),flush=True)
for row in w['Notes'].iter_rows(values_only=True):
 vals=[str(x) for x in row if x is not None]
 if vals:notes.append(' | '.join(vals))
w.close()
rows.sort(key=lambda r:r[0]);first=datetime.fromisoformat(START).replace(tzinfo=PT).astimezone(timezone.utc);last=(datetime.fromisoformat(END)+timedelta(days=1)).replace(tzinfo=PT).astimezone(timezone.utc)
expected=int((last-first).total_seconds()/3600);missing=[iso(first+timedelta(hours=h)) for h in range(expected) if first+timedelta(hours=h) not in seen]
meta={'schemaVersion':1,'dataset':'eia930-ciso-current','modelStatus':'research_reference_not_used_in_v4_core','generatedAt':datetime.now(timezone.utc).isoformat(),'startDate':START,'endDate':END,'timeZone':'America/Los_Angeles','intervalMinutes':60,'unit':'MW','sourceUnit':'MWh per one-hour interval','unitConversion':'Average MW = reported MWh / intervalHours; intervalHours=1 for every normalized UTC interval, so numeric values are unchanged.','fields':fields,'rows':rows,'sourceUrl':receipt['url'],'sourceSha256':receipt['sha256'],'receivedAt':receipt['receivedAt'],'sourceLastModified':receipt.get('lastModified'),'sourcePublishedAt':None,'timeEvidenceType':'current_download_only','historicalFirstAvailabilityProven':False,'hourConvention':'Source UTC time is hour ending; normalized startUtc = source UTC time minus one hour.','interchangeConvention':'Negative = net inflow; positive = net outflow; source sign retained.','sourceColumns':chosen,'missingTimestamps':missing,'qualityIssues':dict(issues),'limitations':['Reported values only, no EIA-imputed or adjusted values substituted.','Current history may contain revisions; no historical first-availability proof.','Demand forecast and subregion demand intentionally excluded from this panel.','Each field has distinct reporting delays. Suggested initial research feature lag: >=3 PT calendar days; this is an assumption, not proof of original value publication.','Battery generation is reported net power, not state of charge or available capacity.']}
blob=gzip.compress(json.dumps(meta,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode(),mtime=0);(P/'eia930-ciso-current.json.gz').write_bytes(blob)
audit={k:v for k,v in meta.items() if k!='rows'};audit.update(rows=len(rows),expectedHours=expected,completeTimestampCoverage=len(rows)==expected and not missing,missingByField={k:v['null'] for k,v in state.items()},fieldStats=state,normalizedSha256=hashlib.sha256(blob).hexdigest(),sampleRows=[dict(zip(fields,r)) for r in rows[-3:]])
audit['excludedAllMissingFields']=[key for key,value in state.items() if value['count']==0]
(P/'eia930-ciso-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2,allow_nan=False));(P/'source-notes.txt').write_text('\n'.join(notes))
print(json.dumps({k:audit[k] for k in ['rows','expectedHours','completeTimestampCoverage','qualityIssues','missingByField','fieldStats']},ensure_ascii=False),flush=True)
