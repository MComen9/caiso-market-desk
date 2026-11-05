"""Read two public CAISO XLSX outage snapshots without altering the workbooks."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request
import openpyxl

import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", required=True, type=Path)
args = parser.parse_args()
root = args.output_dir.resolve()
root.mkdir(parents=True, exist_ok=True)
files=["curtailed-non-operational-generator-am-report-20261029.xlsx",
       "curtailed-non-operational-generator-prior-trade-date-report-20261028.xlsx"]
summaries=[]
for name in files:
    url="https://www.caiso.com/documents/"+name
    with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"CAISO-data-research/1.0"}),timeout=40) as response:
        raw=response.read(10_000_001)
        if len(raw)>10_000_000:raise ValueError("Response too large")
        receipt={"sourceUrl":url,"fetchedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),"httpStatus":response.status,
                 "bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),"lastModified":response.headers.get("Last-Modified")}
    path=root/name;path.write_bytes(raw)
    (root/(name+".receipt.json")).write_text(json.dumps(receipt,indent=2)+"\n")
    book=openpyxl.load_workbook(path,read_only=True,data_only=True)
    sheets=[]
    for sheet in book:
        rows=[[v.isoformat() if isinstance(v,(dt.datetime,dt.date)) else v for v in row] for row in sheet.iter_rows(values_only=True)]
        sheets.append({"name":sheet.title,"rowCount":len(rows),"rows":rows})
        print(json.dumps({"file":name,"sheet":sheet.title,"rows":len(rows),"firstRows":rows[:8]},ensure_ascii=False),flush=True)
    (root/(name+".extracted.json")).write_text(json.dumps({"sourceFile":name,"receipt":receipt,"sheets":sheets},ensure_ascii=False,indent=2)+"\n")
    summaries.append({"file":name,"receipt":receipt,"sheets":[{"name":s["name"],"rows":s["rowCount"]} for s in sheets]})
    book.close()
(root/"outage-samples-manifest.json").write_text(json.dumps(summaries,indent=2)+"\n")
