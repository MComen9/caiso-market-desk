#!/usr/bin/env python3
"""CAISO research simulator with the uploaded script's input and class interface.

This maintained implementation is separate from the untouched uploaded script.
It accepts ``meta / nodes / series`` and preserves ``StrategyEngine`` methods,
but uses explicit UTC hours, missing-value-safe evaluation and fixed manual node
selection. Historical reconstructed predictions are labelled as such; their
actual generation time is never changed to a fictitious historical issue time.

Run: python research/trading_strategy.py --data research/output/embedded-data.json
Only local calculation; no submission, execution or full CAISO settlement.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

VERSION = "caiso-python-strategy-3.0.0"
PT = ZoneInfo("America/Los_Angeles")
EPS = 1e-8
STRATEGIES = {
    "normal": "顺势", "high_conf": "高门槛", "half": "半仓",
    "aggressive": "积极报价", "always_inc": "固定 INC",
    "cap_only": "固定 DEC", "contrarian": "逆向",
}


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_time(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("时间字段必须是带时区的 ISO 字符串")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.utcoffset() is None:
        raise ValueError("时间字段不能省略时区")
    return result.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def hours_for_date(day: str) -> list[dict]:
    local_start = datetime.fromisoformat(day).replace(tzinfo=PT)
    start = local_start.astimezone(timezone.utc)
    end = (local_start + timedelta(days=1)).astimezone(timezone.utc)
    result = []
    while start < end:
        local = start.astimezone(PT)
        offset = local.strftime("%z")
        result.append({"startUtc": iso(start), "endUtc": iso(start + timedelta(hours=1)),
                       "localDate": day, "localHour": local.strftime("%H:%M"),
                       "utcOffset": offset[:3] + ":" + offset[3:]})
        start += timedelta(hours=1)
    return result


def decision_as_of(day: str) -> str:
    previous = datetime.fromisoformat(day) - timedelta(days=1)
    return iso(previous.replace(hour=9, minute=55, tzinfo=PT))


class StrategyEngine:
    """Read a self-contained input; plan first, evaluate outcomes second."""

    def __init__(self, data: dict[str, Any]):
        self.data = deepcopy(data)
        self.meta = self.data["meta"]
        self.nodes = self.data["nodes"]
        self.series = self.data["series"]
        self.dates = self.meta["dates"]
        self.hist_end = self.meta["hist_end"]
        if len(set(self.dates)) != len(self.dates) or self.dates != sorted(self.dates):
            raise ValueError("meta.dates 必须严格按日期排序且无重复")
        self.hours = self.data.get("hours") or [hour for day in self.dates for hour in hours_for_date(day)]
        expected_hours = [hour for day in self.dates for hour in hours_for_date(day)]
        if len(self.hours) != len(expected_hours):
            raise ValueError("UTC 小时数与日期范围不一致；不能把夏令时日强制变为 24 小时")
        for observed, expected in zip(self.hours, expected_hours):
            if parse_time(observed["startUtc"]) != parse_time(expected["startUtc"]):
                raise ValueError("UTC 小时顺序不一致或缺失")
        self.hours = expected_hours
        self.day_indices = {day: [i for i, hour in enumerate(self.hours) if hour["localDate"] == day] for day in self.dates}
        self.provenance = self.data.get("forecastProvenance", {})
        self.reconstructed = self.meta.get("classification") == "historical_reconstruction"
        node_keys = [node["k"] for node in self.nodes]
        if len(node_keys) != len(set(node_keys)):
            raise ValueError("节点不能重复")
        for node in node_keys:
            rows = self.series.get(node)
            if not isinstance(rows, list) or len(rows) != len(self.hours):
                raise ValueError(f"{node} 的序列长度必须与 UTC 小时数一致")
            for row in rows:
                if row is not None and (not isinstance(row, list) or len(row) < 6 or any(value is not None and not finite(value) for value in row[1:6])):
                    raise ValueError("价格/预测必须是有限数值或 null")
        today = self.meta.get("today")
        self.state = {"di": self.dates.index(today) if today in self.dates else len(self.dates) - 1,
                      "strat": "normal", "k": .5, "sel": node_keys, "mode": "manual",
                      "nSel": len(node_keys), "total": self.meta.get("total_mwh", 12),
                      "dp": self.meta.get("dp", 10), "capPer": 2., "capNode": 6.,
                      "maxCells": 12, "minWin": 50, "minSpr": 0, "minSamples": 12,
                      "maxNeg": 10, "feePerMWh": 0., "tieFill": False,
                      "aggressiveBuyQuote": 1000., "aggressiveSellQuote": -150., "w0": 0}

    def is_today(self, di: int) -> bool:
        return self.dates[di] > self.hist_end

    def get_config(self) -> dict:
        keys = ("sel", "total", "k", "dp", "capPer", "capNode", "maxCells", "strat", "maxNeg",
                "feePerMWh", "tieFill", "aggressiveBuyQuote", "aggressiveSellQuote")
        cfg = {key: deepcopy(self.state[key]) for key in keys}
        cfg["sel"] = list(dict.fromkeys(cfg["sel"]))
        self._validate_config(cfg)
        return cfg

    def _validate_config(self, cfg: dict) -> None:
        if cfg["strat"] not in STRATEGIES:
            raise ValueError("策略不存在")
        if any(node not in self.series for node in cfg["sel"]):
            raise ValueError("所选节点不存在")
        for key, minimum in (("total", 1), ("capPer", 1), ("capNode", 1), ("maxCells", 1),
                             ("k", 0), ("dp", 0), ("maxNeg", 0), ("feePerMWh", 0)):
            if not finite(cfg.get(key)) or cfg[key] < minimum:
                raise ValueError(f"{key} 必须是 >= {minimum} 的有限数")
        if int(cfg["maxCells"]) != cfg["maxCells"]:
            raise ValueError("maxCells 必须是整数")
        if not isinstance(cfg.get("tieFill"), bool):
            raise ValueError("tieFill 必须是布尔值")
        for key in ("aggressiveBuyQuote", "aggressiveSellQuote"):
            if not finite(cfg.get(key)):
                raise ValueError(f"{key} 必须是有限数")

    @staticmethod
    def decide(r: list, strat: str, cfg: dict) -> dict | None:
        pred, pda, sigma = r[3], r[4], r[5]
        if not finite(pred) or not finite(pda):
            return None
        if strat == "always_inc":
            side = "INC"
        elif strat == "cap_only":
            side = "DEC"
        elif pred == 0:
            return None
        else:
            side = "DEC" if pred > 0 else "INC"
            if strat == "contrarian":
                side = "INC" if side == "DEC" else "DEC"
        k = max(cfg["k"], 1.5) if strat == "high_conf" else cfg["k"]
        if k > 0 and (not finite(sigma) or sigma <= 0 or abs(pred) + EPS < k * sigma):
            return None
        if (pred if side == "DEC" else -pred) < -cfg["maxNeg"] - EPS:
            return None
        quote = (cfg["aggressiveBuyQuote"] if side == "DEC" else cfg["aggressiveSellQuote"]) if strat == "aggressive" else pda + (cfg["dp"] if side == "DEC" else -cfg["dp"])
        score = abs(pred) / (sigma if finite(sigma) and sigma > 0 else 1)
        return {"side": side, "quote": quote, "z": score, "w": max(.12, score - k + .12)}

    def _forecast_eligible(self, node: str, index: int) -> bool:
        row = self.series[node][index]
        if row is None or not finite(row[3]) or not finite(row[4]):
            return False
        records = self.provenance.get(node)
        if not records or len(records) <= index or not records[index]:
            # Older inputs can be inspected, but cannot imply timing verification.
            return self.meta.get("allowUnverifiedLegacyTiming") is True
        record = records[index]
        cutoff = parse_time(decision_as_of(self.hours[index]["localDate"]))
        training_end = record.get("trainingEndUtc")
        if not training_end or parse_time(training_end) > cutoff:
            return False
        if self.reconstructed:
            # This is a retrospective research calculation, not an archived forecast.
            return record.get("reconstructed") is True and parse_time(record["decisionAsOfUtc"]) == cutoff
        issued = record.get("issuedAt")
        return bool(issued) and parse_time(training_end) <= parse_time(issued) <= cutoff

    def build_alloc(self, di: int, cfg: dict) -> list[dict]:
        self._validate_config(cfg)
        candidates = []
        for node in cfg["sel"]:
            for index in self.day_indices[self.dates[di]]:
                if not self._forecast_eligible(node, index):
                    continue
                row = self.series[node][index]
                signal = self.decide(row, cfg["strat"], cfg)
                if signal is not None:
                    candidates.append({"n": node, "h": int(self.hours[index]["localHour"][:2]), "i": index,
                                       "startUtc": self.hours[index]["startUtc"], "r": row, **signal})
        candidates.sort(key=lambda cell: (-cell["z"], cell["startUtc"], cell["n"]))
        remaining = cfg["total"] * (.5 if cfg["strat"] == "half" else 1)
        used = defaultdict(float)
        admitted = []
        for candidate in candidates:
            if len(admitted) >= cfg["maxCells"] or remaining < 1 - EPS:
                break
            if cfg["capNode"] - used[candidate["n"]] < 1 - EPS:
                continue
            admitted.append({**candidate, "qty": 1.})
            used[candidate["n"]] += 1
            remaining -= 1
        for _ in range(150):
            active = [cell for cell in admitted if cfg["capPer"] - cell["qty"] > EPS and cfg["capNode"] - used[cell["n"]] > EPS]
            if remaining <= EPS or not active:
                break
            weight = sum(cell["w"] for cell in active)
            taken = 0.
            for cell in active:
                room = min(cfg["capPer"] - cell["qty"], cfg["capNode"] - used[cell["n"]])
                add = max(0., min(remaining * cell["w"] / weight, room))
                cell["qty"] += add
                used[cell["n"]] += add
                taken += add
            remaining -= taken
            if taken < EPS:
                break
        for cell in admitted:
            cell["qty"] = math.floor(cell["qty"] * 1e9 + .5) / 1e9
        return admitted

    def sim_day(self, di: int, cfg: dict) -> dict:
        day = self.dates[di]
        allocated = self.build_alloc(di, cfg)
        cells = []
        for allocation in allocated:
            row, sign = allocation["r"], 1 if allocation["side"] == "DEC" else -1
            hour = self.hours[allocation["i"]]
            cell = {**allocation, **hour, "cleared": None, "pnl": None, "grossPnl": None, "fees": None,
                    "actual": None, "predPnl": None, "status": "missing_actual",
                    "expectedPnl": allocation["qty"] * sign * row[3],
                    "forecast": self.provenance.get(allocation["n"], [])[allocation["i"]] if self.provenance.get(allocation["n"]) else None}
            if finite(row[1]):
                difference = allocation["quote"] - row[1] if sign == 1 else row[1] - allocation["quote"]
                tied = abs(difference) <= EPS
                if (tied and not cfg["tieFill"]) or difference < -EPS:
                    cell.update(cleared=False, pnl=0., grossPnl=0., fees=0., predPnl=0.,
                                status="tie_excluded" if tied else "not_filled")
                else:
                    cell["cleared"] = True
                    if finite(row[2]):
                        gross = allocation["qty"] * sign * (row[2] - row[1])
                        fee = allocation["qty"] * cfg["feePerMWh"]
                        cell.update(pnl=gross - fee, grossPnl=gross, fees=fee, actual=row[2] - row[1],
                                    predPnl=cell["expectedPnl"], status="filled")
            cells.append(cell)
        expected_hours = len(self.day_indices[day]) * len(cfg["sel"])
        covered = sum(self._forecast_eligible(node, index) for node in cfg["sel"] for index in self.day_indices[day])
        actual_hours = sum(self.series[node][index] is not None and finite(self.series[node][index][1]) and finite(self.series[node][index][2]) for node in cfg["sel"] for index in self.day_indices[day])
        future = self.is_today(di)
        missing = any(cell["pnl"] is None for cell in cells)
        status = "forecast_only" if future else "no_forecast" if covered == 0 else "partial" if covered < expected_hours or missing else "no_signals" if not cells else "complete"
        complete = status in ("complete", "no_signals")
        known = sum(cell["pnl"] for cell in cells if cell["pnl"] is not None)
        planned = sum(cell["qty"] for cell in cells)
        return {"date": day, "status": status, "decisionAsOfUtc": decision_as_of(day), "today": future,
                "pnl": known if complete else None, "knownNetPnl": known,
                "grossPnl": sum(cell["grossPnl"] or 0 for cell in cells) if complete else None,
                "fees": sum(cell["fees"] or 0 for cell in cells) if complete else None,
                "predPnl": sum(cell["predPnl"] or 0 for cell in cells) if complete else None,
                "expected": sum(cell["expectedPnl"] for cell in cells), "gross": planned,
                "unallocatedMWh": max(0., cfg["total"] * (.5 if cfg["strat"] == "half" else 1) - planned),
                "filled": sum(cell["qty"] for cell in cells if cell["cleared"] is True),
                "settledMWh": sum(cell["qty"] for cell in cells if cell["status"] == "filled"),
                "n": sum(cell["status"] == "filled" for cell in cells),
                "hit": sum(cell["status"] == "filled" and cell["pnl"] > 0 for cell in cells),
                "expectedHours": expected_hours, "forecastHours": covered, "availableActualHours": actual_hours, "rows": cells}

    def sim_all(self, cfg: dict) -> dict:
        lo, hi = sorted((self.state["w0"], self.state["di"]))
        days = [self.sim_day(index, cfg) for index in range(lo, hi + 1) if not self.is_today(index)]
        complete = [day for day in days if day["status"] in ("complete", "no_signals")]
        cumulative = peak = drawdown = 0.
        equity = []
        for day in days:
            if day["pnl"] is None:
                equity.append(None)
                continue
            cumulative += day["pnl"]
            peak = max(peak, cumulative)
            drawdown = max(drawdown, peak - cumulative)
            equity.append(cumulative)
        cells = [cell for day in complete for cell in day["rows"] if cell["status"] == "filled"]
        filled = sum(day["filled"] for day in complete)
        return {"classification": "事后重建研究回测" if self.reconstructed else "本地研究模拟",
                "eq": equity, "daily": [day["pnl"] for day in days], "total": cumulative if complete else None,
                "maxdd": drawdown if complete else None, "ndays": len(days), "evaluatedDays": len(complete),
                "incompleteDays": len(days) - len(complete), "noSignalDays": sum(day["status"] == "no_signals" for day in days),
                "winRate": sum(cell["pnl"] > 0 for cell in cells) / len(cells) * 100 if cells else None,
                "perMWh": cumulative / filled if filled else None, "filled": filled,
                "settledMWh": sum(day["settledMWh"] for day in complete), "totalTrades": len(cells),
                "totExp": sum(day["expected"] for day in days), "totGross": sum(day["gross"] for day in days),
                "fees": sum(day["fees"] for day in complete), "days": days,
                "warnings": ["电价×电量简化损益；不含 Forecasted Movement、uplift、信用资金及全部结算费用。",
                             "没有年化 Sharpe；预期损益假设所有计划成交，并不是实际收益。"]}

    def apply_auto_select(self) -> None:
        if self.state["mode"] == "manual":
            return
        # No use of full-period summary statistics for automatic historical selection.
        raise ValueError("维护版仅支持显式手选节点；旧版静态节点排名存在前视风险，不能自动补选")


def main() -> None:
    parser = argparse.ArgumentParser(description="CAISO 预测输入与策略研究模拟，不执行交易")
    parser.add_argument("--data", required=True)
    parser.add_argument("--date")
    parser.add_argument("--start-date")
    parser.add_argument("--strategy", choices=STRATEGIES, default="normal")
    parser.add_argument("--k", type=float, default=.5)
    parser.add_argument("--fee-per-mwh", type=float, default=0.)
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        engine = StrategyEngine(json.loads(Path(args.data).read_text(encoding="utf-8")))
        for value, field in ((args.date, "di"), (args.start_date, "w0")):
            if value is not None:
                if value not in engine.dates:
                    parser.error("日期不在输入范围")
                engine.state[field] = engine.dates.index(value)
        engine.state.update(strat=args.strategy, k=args.k, feePerMWh=args.fee_per_mwh)
        cfg = engine.get_config()
        day = engine.sim_day(engine.state["di"], cfg)
        backtest = engine.sim_all(cfg)
        executed_at = iso(datetime.now(timezone.utc))
        result = {"engineVersion": VERSION, "classification": engine.meta.get("classification"),
                  "generatedAt": executed_at, "executedAt": executed_at,
                  "forecastGeneratedAt": engine.meta.get("generatedAt"), "inputDigest": engine.meta.get("inputDigest"),
                  "date": engine.dates[engine.state["di"]], "config": cfg,
                  "day": day, "backtest": backtest}
        text = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text, encoding="utf-8")
        else:
            print(text, end="")
    except (ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
