"""A single non-commercial research request against a documented archive run."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", required=True, type=Path)
args = parser.parse_args()
root = args.output_dir.resolve()
root.mkdir(parents=True, exist_ok=True)
params={"latitude":"38.5816","longitude":"-121.4944","models":"gfs_global",
        "run":"2026-10-14T00:00","forecast_days":"3","timezone":"GMT",
        "hourly":"temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,shortwave_radiation"}
url="https://single-runs-api.open-meteo.com/v1/forecast?"+urllib.parse.urlencode(params)
request=urllib.request.Request(url,headers={"User-Agent":"CAISO-noncommercial-research-sample/1.0","Accept":"application/json"})
try:
    with urllib.request.urlopen(request,timeout=50) as response:
        raw=response.read(2_000_001); status=response.status; content_type=response.headers.get("Content-Type")
except urllib.error.HTTPError as response:
    raw=response.read(2_000_001);status=response.code;content_type=response.headers.get("Content-Type")
if len(raw)>2_000_000: raise ValueError("Response too large")
receipt={"sourceUrl":url,"fetchedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),"httpStatus":status,
         "contentType":content_type,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),
         "requestPurpose":"one non-commercial source-availability research sample; not a commercial platform data feed",
         "requestedRunInitializationUtc":"2026-10-14T00:00:00Z","requestedModel":"gfs_global",
         "sourceAvailabilityUtc":None,
         "notes":["run is model initialization, not public availability or observed fetched-at time.",
                  "A backtest must still apply model distribution lag and distinguish reconstructed historical input from pre-archived own observations.",
                  "Open-Meteo hosted free tier is non-commercial only; commercial production requires appropriate plan or self-hosting."]}
(root/"open-meteo-single-run-20261014-sacramento.raw.json").write_bytes(raw)
(root/"open-meteo-single-run-20261014-sacramento.receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
data=json.loads(raw)
if status!=200:
    print(json.dumps({"status":status,"error":data,"receipt":receipt},ensure_ascii=False))
    raise SystemExit(0)
hourly=data["hourly"]
rows=[]
init=dt.datetime(2026,10,14,tzinfo=dt.timezone.utc)
for index,time in enumerate(hourly["time"]):
    valid=dt.datetime.fromisoformat(time).replace(tzinfo=dt.timezone.utc)
    row={"validTimeUtc":valid.isoformat(),"runInitializationUtc":init.isoformat(),
         "leadHours":(valid-init).total_seconds()/3600,
         "values":{key:values[index] for key,values in hourly.items() if key!="time"}}
    rows.append(row)
output={"schemaVersion":1,"classification":"historical_model_run_retrieved_today",
        "provider":"Open-Meteo / NOAA GFS","location":{"id":"sacramento","requestedLatitude":38.5816,"requestedLongitude":-121.4944,
        "returnedLatitude":data.get("latitude"),"returnedLongitude":data.get("longitude")},
        "receipt":receipt,"units":data.get("hourly_units"),"rows":rows,
        "rawResponseMetadata":{key:value for key,value in data.items() if key not in {"hourly","hourly_units"}}}
(root/"open-meteo-single-run-20261014-sacramento.json").write_text(json.dumps(output,indent=2)+"\n")
print(json.dumps({"status":status,"rows":len(rows),"first":rows[0],"last":rows[-1],"metadata":output["rawResponseMetadata"]},ensure_ascii=False),flush=True)
