"""Download and extract CAISO's public fuel/electric-region mapping workbook."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request
import openpyxl

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir",type=Path,required=True)
args=parser.parse_args()
root=args.output_dir.resolve();root.mkdir(parents=True,exist_ok=True)
name="fuelregion_electricregiondefinitions.xlsx"
url="https://www.caiso.com/documents/"+name
with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"CAISO-data-research/1.0"}),timeout=40) as response:
    raw=response.read(10_000_001)
    if len(raw)>10_000_000:raise ValueError("Response too large")
    receipt={"sourceUrl":url,"fetchedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),"httpStatus":response.status,
             "bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),"lastModified":response.headers.get("Last-Modified")}
(root/name).write_bytes(raw)
(root/(name+".receipt.json")).write_text(json.dumps(receipt,indent=2)+"\n")
book=openpyxl.load_workbook(root/name,read_only=True,data_only=True)
sheet=book["GPI_Fuel_Region"]
rows=[[v.isoformat() if isinstance(v,(dt.datetime,dt.date)) else v for v in row] for row in sheet.iter_rows(values_only=True)]
output={"schemaVersion":1,"classification":"current_reference_mapping_retrieved_today","sheet":"GPI_Fuel_Region",
        "receipt":receipt,"rowCountIncludingHeaders":len(rows),"rawRows":rows,
        "notes":["This is the currently downloadable mapping. Historical effective-time coverage is not asserted.",
                 "Retain exact region IDs and labels; do not infer California membership from a numeric/string region ID."]}
(root/"fuel-region-mapping.raw.json").write_text(json.dumps(output,ensure_ascii=False,indent=2)+"\n")
field_map={"Fuel Region":"fuelRegionId","Pricing Hub":"pricingHub","Transportation Cost":"transportationCostDescription",
           "Fuel Reimbursement Rate":"fuelReimbursementRateDescription","Cap & Trade Credit":"capAndTradeCredit",
           "Miscellaneous Costs":"miscellaneousCostsDescription","Balancing Authority":"balancingAuthority"}
headers=rows[0]
if set(headers)!=set(field_map):raise ValueError("Fuel mapping headers changed")
records=[];seen=set()
for index,row in enumerate(rows[1:],start=2):
    if not row[0]:continue
    record={field_map[label]:row[column] for column,label in enumerate(headers)}
    record["sourceFuelRegionRaw"]=record["fuelRegionId"]
    record["fuelRegionId"]=str(record["fuelRegionId"]).strip()
    if record["fuelRegionId"] in seen:raise ValueError("Duplicate normalized fuel region")
    seen.add(record["fuelRegionId"])
    record["sourceRow"]=index
    records.append(record)
normalized={"schemaVersion":1,"classification":output["classification"],"receipt":receipt,"sheet":sheet.title,
            "effectiveStartUtc":None,"effectiveEndUtc":None,"rowCount":len(records),"rows":records,
            "notes":output["notes"]+["Fuel IDs are joined after trimming outer whitespace; original ID text is retained.",
                                       "Transportation and reimbursement fields are descriptions, not numeric adders.",
                                       "Balancing Authority PGE is distinct from CISO; PG&E Citygate is a separate Pricing Hub label."]}
(root/"fuel-region-mapping.json").write_text(json.dumps(normalized,ensure_ascii=False,indent=2)+"\n")
book.close()
print(json.dumps({"rows":len(rows),"firstRows":rows[:8]},ensure_ascii=False),flush=True)
