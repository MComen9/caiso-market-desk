"""Retrieve public NOAA/NWS snapshots. No historical-vintage claims are made."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request

import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", required=True, type=Path)
args = parser.parse_args()
ROOT = args.output_dir.resolve()
ROOT.mkdir(parents=True, exist_ok=True)
LOCATIONS = [
    ("sacramento", "Sacramento", 38.5816, -121.4944),
    ("fresno", "Fresno", 36.7378, -119.7871),
    ("los_angeles", "Los Angeles", 34.0522, -118.2437),
]


def fetch(url: str, stem: str) -> tuple[dict, dict]:
    if not url.startswith("https://api.weather.gov/"):
        raise ValueError("Unexpected public API origin")
    request = urllib.request.Request(url, headers={
        "User-Agent": "CAISO-market-data-research/1.0 (public-data-validation)",
        "Accept": "application/geo+json",
    })
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            raw = response.read(6_000_001)
            if len(raw) > 6_000_000:
                raise ValueError("Response too large")
            receipt = {"sourceUrl":url,"fetchedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),
                       "httpStatus":response.status,"contentType":response.headers.get("content-type"),
                       "lastModified":response.headers.get("last-modified"),
                       "bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()}
        data = json.loads(raw)
        (ROOT / f"{stem}.json").write_bytes(raw)
        (ROOT / f"{stem}.receipt.json").write_text(json.dumps(receipt, indent=2)+"\n")
        return data, receipt
    except Exception as exc:
        error = {"sourceUrl":url,"attemptedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),
                 "errorType":type(exc).__name__,"error":str(exc)}
        (ROOT / f"{stem}.error.json").write_text(json.dumps(error,indent=2)+"\n")
        raise


def main():
    locations=[]
    for ident, label, lat, lon in LOCATIONS:
        point, point_receipt=fetch(f"https://api.weather.gov/points/{lat},{lon}",ident+"-point")
        props=point["properties"]
        forecast, receipt=fetch(props["forecastHourly"],ident+"-hourly")
        forecast_props=forecast["properties"]
        rows=[]
        for period in forecast_props["periods"]:
            rows.append({"startUtc":dt.datetime.fromisoformat(period["startTime"]).astimezone(dt.timezone.utc).isoformat(),
                         "endUtc":dt.datetime.fromisoformat(period["endTime"]).astimezone(dt.timezone.utc).isoformat(),
                         "temperature":period.get("temperature"),"temperatureUnit":period.get("temperatureUnit"),
                         "relativeHumidityPercent":(period.get("relativeHumidity") or {}).get("value"),
                         "precipitationProbabilityPercent":(period.get("probabilityOfPrecipitation") or {}).get("value"),
                         "windSpeedRaw":period.get("windSpeed"),"windDirection":period.get("windDirection"),
                         "shortForecast":period.get("shortForecast")})
        locations.append({"id":ident,"label":label,"latitude":lat,"longitude":lon,
                          "scope":"Representative city point; not a CAISO hub centroid or asset location",
                          "gridId":props["gridId"],"gridX":props["gridX"],"gridY":props["gridY"],
                          "sourceUrl":props["forecastHourly"],"fetchedAtUtc":receipt["fetchedAtUtc"],
                          "sourceUpdateTimeUtc":forecast_props.get("updateTime"),
                          "generatedAtUtc":forecast_props.get("generatedAt"),
                          "forecastValidTimes":forecast_props.get("validTimes"),
                          "rows":rows})
        print(json.dumps({"location":ident,"rows":len(rows),"updateTime":forecast_props.get("updateTime"),"first":rows[0]["startUtc"],"last":rows[-1]["endUtc"]}),flush=True)
    output={"schemaVersion":1,"source":"NOAA/NWS","classification":"current_forecast_snapshot",
            "fetchedAtUtc":dt.datetime.now(dt.timezone.utc).isoformat(),
            "apiDocumentation":"https://www.weather.gov/documentation/services-web-api",
            "historicalAsOfAvailable":False,
            "notes":["Current snapshots only; cannot backfill historical issue versions from these files.",
                     "Source updateTime and local fetchedAt are different provenance fields.",
                     "City points are research weather covariates; no generation-capacity or load weights are asserted."],
            "locations":locations}
    (ROOT/"nws-weather-snapshot.json").write_text(json.dumps(output,ensure_ascii=False,indent=2)+"\n")


if __name__ == "__main__":
    main()
