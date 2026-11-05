"""Offline integrity checks for the acquired weather and outage evidence."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path


def verify(root: Path) -> dict:
    def read(name):
        return json.loads((root/name).read_text())

    receipt_count=0
    for path in sorted(root.glob("*.receipt.json")):
        receipt=json.loads(path.read_text())
        if path.name.endswith(".xlsx.receipt.json"):
            raw=root/path.name.removesuffix(".receipt.json")
        elif path.name.startswith("open-meteo-"):
            raw=root/path.name.replace(".receipt.json",".raw.json")
        else:
            raw=root/path.name.replace(".receipt.json",".json")
        content=raw.read_bytes()
        assert receipt["httpStatus"]==200
        assert receipt["bytes"]==len(content),raw.name
        assert receipt["sha256"]==hashlib.sha256(content).hexdigest(),raw.name
        assert receipt["sourceUrl"].startswith("https://")
        assert "apikey=" not in receipt["sourceUrl"].lower()
        receipt_count+=1

    nws=read("nws-weather-snapshot.json")
    nws_hours=0
    for location in nws["locations"]:
        source=read(location["id"]+"-hourly.json")["properties"]
        points=read(location["id"]+"-point.json")["properties"]
        assert location["sourceUrl"]==points["forecastHourly"]
        assert location["sourceUpdateTimeUtc"]==source["updateTime"]
        assert len(location["rows"])==len(source["periods"])
        starts=[]
        for row,period in zip(location["rows"],source["periods"]):
            start=dt.datetime.fromisoformat(row["startUtc"])
            end=dt.datetime.fromisoformat(row["endUtc"])
            assert start.utcoffset()==dt.timedelta(0)
            assert end-start==dt.timedelta(hours=1)
            assert start==dt.datetime.fromisoformat(period["startTime"])
            assert row["temperature"]==period["temperature"]
            assert row["temperatureUnit"]==period["temperatureUnit"]
            assert row["relativeHumidityPercent"]==period["relativeHumidity"]["value"]
            assert row["precipitationProbabilityPercent"]==period["probabilityOfPrecipitation"]["value"]
            assert row["windSpeedRaw"]==period["windSpeed"]
            starts.append(start)
        assert len(starts)==len(set(starts))
        assert all(b-a==dt.timedelta(hours=1) for a,b in zip(starts,starts[1:]))
        nws_hours+=len(starts)
    assert nws["historicalAsOfAvailable"] is False

    historical=read("open-meteo-single-run-20261014-sacramento.json")
    raw=read("open-meteo-single-run-20261014-sacramento.raw.json")
    assert historical["receipt"]["sourceAvailabilityUtc"] is None
    assert historical["units"]==raw["hourly_units"]
    for index,row in enumerate(historical["rows"]):
        assert row["leadHours"]==index
        assert dt.datetime.fromisoformat(row["validTimeUtc"])-dt.datetime.fromisoformat(row["runInitializationUtc"])==dt.timedelta(hours=index)
        assert row["validTimeUtc"].startswith(raw["hourly"]["time"][index])
        for key,value in row["values"].items():
            assert value==raw["hourly"][key][index]
    missing={key:sum(row["values"][key] is None for row in historical["rows"]) for key in historical["rows"][0]["values"]}
    assert missing=={"temperature_2m":0,"relative_humidity_2m":0,"wind_speed_10m":0,"cloud_cover":1,"shortwave_radiation":1}

    am=read("generator-outages-am-20261029.json")
    prior=read("generator-outages-prior-20261028.json")
    assert am["recordCount"]==len(am["rows"])
    assert prior["recordCount"]==len(prior["rows"])
    assert am["distinctResources"]==len({r["resourceId"] for r in am["rows"]})
    assert prior["distinctResources"]==len({r["resourceId"] for r in prior["rows"]})
    assert prior["distinctOutageMrids"]==len({r["outageMrid"] for r in prior["rows"]})
    assert prior["openEndedRecordCount"]==sum(r["curtailmentEndLocalRaw"] is None for r in prior["rows"])
    am_source=read("curtailed-non-operational-generator-am-report-20261029.xlsx.extracted.json")["sheets"][0]["rows"]
    for row in am["rows"]:
        src=am_source[row["sourceRow"]-1]
        assert row["resourceId"]==src[1] and row["balancingArea"]==src[13]
        assert row["capacityMw"]==float(str(src[9]).replace(",",""))
        assert row["curtailedMw"]==float(str(src[11]).replace(",",""))
    prior_source=read("curtailed-non-operational-generator-prior-trade-date-report-20261028.xlsx.extracted.json")["sheets"][0]["rows"]
    for row in prior["rows"]:
        src=prior_source[row["sourceRow"]-1]
        assert row["outageMrid"]==str(src[1]) and row["resourceId"]==src[4]
        assert row["curtailmentMw"]==float(src[9])
        assert row["curtailmentStartLocalRaw"]==src[7] and row["curtailmentEndLocalRaw"]==src[8]
    mapping=read("fuel-region-mapping.json")
    mapping_raw=read("fuel-region-mapping.raw.json")["rawRows"]
    assert mapping["rowCount"]==len(mapping["rows"])
    assert len({r["fuelRegionId"] for r in mapping["rows"]})==len(mapping["rows"])
    for row in mapping["rows"]:
        src=mapping_raw[row["sourceRow"]-1]
        assert row["sourceFuelRegionRaw"]==src[0]
        assert row["fuelRegionId"]==src[0].strip()
        assert row["pricingHub"]==src[1] and row["balancingAuthority"]==src[6]
        assert row["capAndTradeCredit"]==src[4]
    assert mapping["effectiveStartUtc"] is None and mapping["effectiveEndUtc"] is None
    return {"schemaVersion":1,"verified":True,"rawReceiptsVerified":receipt_count,
            "nwsLocations":len(nws["locations"]),"nwsLocationHours":nws_hours,
            "historicalRunHours":len(historical["rows"]),"historicalRunMissingValues":missing,
            "amRecords":am["recordCount"],"priorRecords":prior["recordCount"],
            "fuelRegionMappings":mapping["rowCount"],"cisoFuelRegions":sum(r["balancingAuthority"]=="CISO" for r in mapping["rows"]),
            "notes":["Offline checks prove byte integrity and source-to-normalized agreement, not historical first-publication availability.",
                     "Checks retain missing values and repeated resources; no aggregate outage MW or predictive performance is asserted."]}


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir",type=Path,default=Path(__file__).resolve().parents[1]/"public/data/data-gaps/weather-evidence")
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    result=verify(args.data_dir)
    if args.output:
        args.output.write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result,ensure_ascii=False))
