"""Build the evidence catalog and download package from already retrieved files."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
from pathlib import Path
import zipfile
from verify_weather_evidence import verify

repo=Path(__file__).resolve().parents[1]
root=repo/"public/data/data-gaps/weather-evidence"
base="/data/data-gaps/weather-evidence/"
read=lambda name:json.loads((root/name).read_text())
nws=read("nws-weather-snapshot.json")
run=read("open-meteo-single-run-20261014-sacramento.json")
am=read("generator-outages-am-20261029.json")
prior=read("generator-outages-prior-20261028.json")
fuel=read("fuel-region-mapping.json")
verification=verify(root)
(root/"verification.json").write_text(json.dumps(verification,ensure_ascii=False,indent=2)+"\n")
all_nws_rows=[row for location in nws["locations"] for row in location["rows"]]
datasets=[
 {"id":"nws-current-weather","title":"NWS 当前逐小时天气预测","status":"snapshot_verified","classification":"current_forecast_snapshot",
  "source":"NOAA / NWS","recordCount":len(all_nws_rows),"entityCount":3,"entityUnit":"城市点位",
  "coverage":{"startUtc":min(r["startUtc"] for r in all_nws_rows),"endUtc":max(r["endUtc"] for r in all_nws_rows),"hoursPerLocation":156},
  "fetchedAtUtc":nws["fetchedAtUtc"],"sourceUrls":[loc["sourceUrl"] for loc in nws["locations"]],
  "documentationUrl":"https://www.weather.gov/documentation/services-web-api",
  "dataUrl":base+"nws-weather-snapshot.json","fields":["locationId","startUtc","endUtc","temperature","temperatureUnit","relativeHumidityPercent","precipitationProbabilityPercent","windSpeedRaw","windDirection","sourceUpdateTimeUtc","generatedAtUtc","fetchedAtUtc"],
  "units":{"temperature":"source temperatureUnit, F in this snapshot","relativeHumidityPercent":"%","precipitationProbabilityPercent":"%","windSpeedRaw":"原始 mph 字符串"},
  "examples":[{"locationId":loc["id"],"locationLabel":loc["label"],**loc["rows"][0]} for loc in nws["locations"]],
  "limitations":["只有当前快照，不能回填过去180日每个决策截点的预报。","三个城市是研究采样点，尚无CAISO负荷/装机权重，不能当节点中心。","源更新时间、生成时间与获取时间分别保留；进入未来模型仍需逐区间检查截点。"],
  "access":{"requiresKey":False,"commercialUse":"官方开放数据，可免费用于任何用途，遵守合理限流。"}},
 {"id":"gfs-historical-single-run","title":"GFS 历史单次运行样本","status":"sample_verified","classification":"historical_model_run_retrieved_today",
  "source":"Open-Meteo / NOAA GFS global","recordCount":len(run["rows"]),"entityCount":1,"entityUnit":"指定初始化批次及点位",
  "coverage":{"startUtc":run["rows"][0]["validTimeUtc"],"endUtc":run["rows"][-1]["validTimeUtc"],"runInitializationUtc":"2026-10-14T00:00:00Z","leadHoursStart":0,"leadHoursEnd":71},
  "fetchedAtUtc":run["receipt"]["fetchedAtUtc"],"sourceUrls":[run["receipt"]["sourceUrl"]],"documentationUrl":"https://open-meteo.com/en/docs/single-runs-api",
  "dataUrl":base+"open-meteo-single-run-20261014-sacramento.json","fields":["validTimeUtc","runInitializationUtc","leadHours","temperature_2m","relative_humidity_2m","wind_speed_10m","cloud_cover","shortwave_radiation"],
  "units":run["units"],"examples":[run["rows"][i] for i in [0,1,24,48,71]],
  "limitations":["已核验一个点位、一个批次72小时，尚未批量回填180天。","run来自保留的请求参数，响应不另给run字段；初始化时间不等于公开可用时间，sourceAvailabilityUtc为空。","lead0云量与辐射各缺失1值，保留null；其余358数值完整。","历史批次今天可下载不等于当时已经归档，也未纳入V3重训。"],
  "access":{"requiresKey":False,"commercialUse":"本次为一个非商业研究样本；免费托管仅限非商业，商用需相应商业方案或自建。","termsUrl":"https://open-meteo.com/en/terms"}},
 {"id":"generator-outage-am","title":"CAISO 发电停运 AM 快照","status":"sample_verified","classification":am["classification"],
  "source":"CAISO 公开XLSX","recordCount":am["recordCount"],"entityCount":am["distinctResources"],"entityUnit":"资源",
  "coverage":{"tradeDatePt":am["tradeDatePt"],"sourceGeneratedTimeRaw":am["sourceGeneratedTimeRaw"]},"fetchedAtUtc":am["receipt"]["fetchedAtUtc"],
  "sourceUrls":[am["receipt"]["sourceUrl"]],"documentationUrl":"https://www.caiso.com/market-operations/outages/curtailed-and-non-operational-generators",
  "dataUrl":base+"generator-outages-am-20261029.json","fields":am["columns"]+["sourceRow"],"units":{"capacityMw":"MW","curtailedMw":"MW"},
  "examples":am["rows"][:4],"balancingAreaRowCounts":am["balancingAreaRowCounts"],
  "limitations":["含535条CISO行和其他平衡区，不能将628行全部当作CAISO。","37个资源ID跨多行出现，不能直接求和成同时停运容量。","文件生成时间与官网发布日程不同；首次公开时间未验证。"],"access":{"requiresKey":False}},
 {"id":"generator-outage-prior","title":"CAISO 前一交易日停运明细","status":"sample_verified","classification":prior["classification"],
  "source":"CAISO 公开XLSX","recordCount":prior["recordCount"],"entityCount":prior["distinctResources"],"entityUnit":"资源",
  "coverage":{"tradeDatePt":prior["tradeDatePt"]},"fetchedAtUtc":prior["receipt"]["fetchedAtUtc"],"sourceUrls":[prior["receipt"]["sourceUrl"]],
  "documentationUrl":"https://www.caiso.com/market-operations/outages","dataUrl":base+"generator-outages-prior-20261028.json",
  "fields":prior["columns"]+["sourceRow"],"units":{"curtailmentMw":"MW","resourcePmaxMw":"MW","netQualifyingCapacityMw":"MW"},
  "examples":prior["rows"][:4],"outageCount":prior["distinctOutageMrids"],
  "limitations":["事后发布，不能作为10月28日申报前已知输入。","2235行涉及614个停运MRID，含区间断点与重叠事件，不能直接累加MW。","469行结束时间为空；保留源本地时间，未编造结束时间或UTC偏移。","公开发电报告不含联络线，详细输电停运仍需证书。"],"access":{"requiresKey":False}},
 {"id":"fuel-region-map","title":"燃料区与电力区域映射","status":"reference_verified","classification":fuel["classification"],
  "source":"CAISO GPI_Fuel_Region","recordCount":fuel["rowCount"],"entityCount":fuel["rowCount"],"entityUnit":"燃料区",
  "coverage":{"effectiveStartUtc":None,"effectiveEndUtc":None,"cisoFuelRegionCount":57},"fetchedAtUtc":fuel["receipt"]["fetchedAtUtc"],
  "sourceUrls":[fuel["receipt"]["sourceUrl"]],"documentationUrl":"https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html#CAISO.get_fuel_regions",
  "dataUrl":base+"fuel-region-mapping.json","fields":["fuelRegionId","sourceFuelRegionRaw","pricingHub","balancingAuthority","transportationCostDescription","fuelReimbursementRateDescription","capAndTradeCredit","miscellaneousCostsDescription","sourceRow"],
  "units":{},"examples":[row for row in fuel["rows"] if row["fuelRegionId"] in {"FRPGE","FRPGE1","FRPGE1GHG","FRSDG1"}],
  "limitations":["仅当前下载的映射，原表无生效日期，不能证明180天映射不变。","57条BA=CISO，其中PG&E Citygate 13条、SoCal Citygate 37条；FRPGE本身属于BA=PGE，不可按前缀猜加州。","运输和补偿字段为描述，不是可直接相加的数值；未匹配ID保持未映射。"],"access":{"requiresKey":False}}
]
audit={"schemaVersion":1,"version":"caiso-weather-outage-evidence-1.0","generatedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),
       "title":"天气、停运与燃料区证据","downloadUrl":base+"weather-outage-evidence.zip","verificationUrl":base+"verification.json",
       "datasetCount":len(datasets),"datasets":datasets,"verification":verification,
       "modelAdmission":"新增样本尚未纳入V3训练，数据存在不等于历史截点已可用。",
       "remainingGaps":["连续历史天气运行批次及其可用时间证据","负荷及风光装机的空间权重","详细输电停运证书授权","停运区间重叠的容量口径","历史燃料映射生效版本"]}
(root/"weather-audit.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2)+"\n")
members={p.name:p.read_bytes() for p in root.iterdir() if p.is_file() and p.suffix in {".json",".xlsx"} and p.name not in {"weather-release.json"}}
for name in ["fetch_weather_nws.py","fetch_weather_single_run.py","fetch_generator_outage_samples.py","normalize_generator_outage_samples.py","fetch_fuel_region_mapping.py","verify_weather_evidence.py","WEATHER_DATA_GAPS.md"]:
    members[name]=(repo/"research"/name).read_bytes()
manifest={"schemaVersion":1,"files":[{"path":name,"bytes":len(content),"sha256":hashlib.sha256(content).hexdigest()} for name,content in sorted(members.items())]}
members["manifest.json"]=(json.dumps(manifest,indent=2)+"\n").encode()
archive=root/"weather-outage-evidence.zip"
with zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED,compresslevel=9) as zipped:
    for name,content in sorted(members.items()):zipped.writestr(name,content)
with zipfile.ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    for entry in manifest["files"]:
        assert hashlib.sha256(zipped.read(entry["path"])).hexdigest()==entry["sha256"]
release={"schemaVersion":1,"archive":archive.name,"bytes":archive.stat().st_size,"sha256":hashlib.sha256(archive.read_bytes()).hexdigest(),
         "members":len(members),"allChecksPassed":True}
(root/"weather-release.json").write_text(json.dumps(release,indent=2)+"\n")
print(json.dumps(release))
