"""Preserve public outage rows. Do not infer concurrent unavailable capacity."""
import collections
import json
from pathlib import Path

import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", required=True, type=Path)
args = parser.parse_args()
root = args.output_dir.resolve()
root.mkdir(parents=True, exist_ok=True)

def load(name):
    data=json.loads((root/(name+".extracted.json")).read_text())
    return data,data["sheets"][0]["rows"]

name="curtailed-non-operational-generator-am-report-20261029.xlsx"
raw,rows=load(name)
header_index=next(i for i,row in enumerate(rows) if "Resource ID" in row and "Capacity (MW)" in row)
columns={value:index for index,value in enumerate(rows[header_index]) if value}
mapping={"Resource ID":"resourceId","Resource Name":"resourceName","Outage Type":"outageType",
         "Capacity (MW)":"capacityMw","Curtailed (MW)":"curtailedMw","Zone Name":"zoneName","BA":"balancingArea"}
records=[]
for index,row in enumerate(rows[header_index+1:],start=header_index+2):
    if len(row)<=columns["Resource ID"]:continue
    if not isinstance(row[columns["Resource ID"]],str) or not row[columns["Resource ID"]].strip():continue
    if len(row)<=columns["BA"] or not row[columns["BA"]]:continue
    record={target:row[columns[source]] if len(row)>columns[source] else None for source,target in mapping.items()}
    for key in ("capacityMw","curtailedMw"):
        record[key]=float(str(record[key]).replace(",","")) if record[key] is not None else None
    record["sourceRow"]=index;records.append(record)
resource_counts=collections.Counter(r["resourceId"] for r in records)
am={"schemaVersion":1,"classification":"historical_report_retrieved_today","reportType":"am_snapshot",
    "tradeDatePt":"2026-10-29","sourceGeneratedTimeRaw":rows[1][-1],"sourcePublishTimeUtc":None,
    "receipt":raw["receipt"],"columns":list(mapping.values()),"rows":records,
    "recordCount":len(records),"distinctResources":len(resource_counts),
    "resourceIdsWithMultipleRows":sum(v>1 for v in resource_counts.values()),
    "balancingAreaRowCounts":dict(collections.Counter(r["balancingArea"] for r in records)),
    "notes":["Different zone labels may repeat the same resource; no MW aggregation has been applied.",
             "Generated time printed in workbook is not a verified first-publication timestamp.",
             "Contains multiple balancing areas; do not treat all rows as CAISO."]}
(root/"generator-outages-am-20261029.json").write_text(json.dumps(am,ensure_ascii=False,indent=2)+"\n")

name="curtailed-non-operational-generator-prior-trade-date-report-20261028.xlsx"
raw,rows=load(name)
header_index=next(i for i,row in enumerate(rows) if "OUTAGE MRID" in row)
columns={value:index for index,value in enumerate(rows[header_index]) if value}
mapping={"OUTAGE MRID":"outageMrid","RESOURCE NAME":"resourceName","RESOURCE ID":"resourceId",
         "OUTAGE TYPE":"outageType","NATURE OF WORK":"natureOfWork",
         "CURTAILMENT START DATE TIME":"curtailmentStartLocalRaw","CURTAILMENT END DATE TIME":"curtailmentEndLocalRaw",
         "CURTAILMENT MW":"curtailmentMw","RESOURCE PMAX MW":"resourcePmaxMw",
         "NET QUALIFYING CAPACITY MW":"netQualifyingCapacityMw"}
records=[]
for index,row in enumerate(rows[header_index+1:],start=header_index+2):
    if len(row)<=columns["OUTAGE MRID"] or not str(row[columns["OUTAGE MRID"]]).isdigit():continue
    record={target:row[columns[source]] if len(row)>columns[source] else None for source,target in mapping.items()}
    record["outageMrid"]=str(record["outageMrid"])
    for key in ("curtailmentMw","resourcePmaxMw","netQualifyingCapacityMw"):
        record[key]=float(str(record[key]).replace(",","")) if record[key] is not None else None
    record["sourceRow"]=index;records.append(record)
prior={"schemaVersion":1,"classification":"historical_report_retrieved_today","reportType":"prior_trade_date",
       "tradeDatePt":"2026-10-28","sourcePublishTimeUtc":None,"receipt":raw["receipt"],
       "columns":list(mapping.values()),"rows":records,"recordCount":len(records),
       "distinctOutageMrids":len({r["outageMrid"] for r in records}),"distinctResources":len({r["resourceId"] for r in records}),
       "openEndedRecordCount":sum(r["curtailmentEndLocalRaw"] is None for r in records),
       "notes":["Records include interval breakpoints and overlapping outage cards; no concurrent MW total is inferred.",
                "Empty end date is preserved as null; source says this may indicate an outage extends beyond trade date.",
                "Local timestamps are preserved without inventing UTC offsets in this sample extraction.",
                "Prior trade date report is retrospective and cannot be used as same-date pre-decision input."]}
(root/"generator-outages-prior-20261028.json").write_text(json.dumps(prior,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"am":{k:v for k,v in am.items() if k in {"recordCount","distinctResources","resourceIdsWithMultipleRows","balancingAreaRowCounts"}},
                  "prior":{k:v for k,v in prior.items() if k in {"recordCount","distinctOutageMrids","distinctResources","openEndedRecordCount"}}},ensure_ascii=False))
