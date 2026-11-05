#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CAISO 交易台策略逻辑的 Python 导出版（含中文注释，仅本地计算）。

来源：已恢复网页的 frontend.js 策略函数；这是 JavaScript 的移植版，
不是找回的原始 Python 工程。保留原策略、筛选回退和模拟盈亏口径。
不含网页界面、数据采集、申报、下单或线上参数修改。

数据依赖：原网页导出的 embedded-data.json，结构为 meta / nodes / series。
用法示例（所有操作仅针对本地数据）：
    import json
    from trading_strategy import StrategyEngine
    with open("embedded-data.json", encoding="utf-8") as f:
        engine = StrategyEngine(json.load(f))
    engine.state["strat"] = "high_conf"  # 修改策略
    engine.state["k"] = 1.5             # 修改置信度门槛
    engine.apply_auto_select()          # 仅在内存中选择节点
    cfg = engine.get_config()
    result = engine.sim_day(engine.state["di"], cfg)

命令行示例（结果写到标准输出，无文件写入）：
    python trading_strategy.py --data embedded-data.json --date 2026-10-29

修改入口：
    decide             方向、门槛和报价；
    build_alloc        预算、权重和仓位上限；
    ranked_nodes       节点打分排序；
    apply_auto_select  筛选及候选不足时的补选；
    sim_day / sim_all  模拟成交、盈亏及回测统计。

重要边界：预测和节点统计来自输入数据，本文件没有重建上游预测模型。
页面日期自动延长和典型日补值不在此移植范围内，避免读取时自动改写数据。
回测沿用原有的252日年化及预计算节点统计，不代表正式结算或已成交业绩。
"""

from __future__ import annotations

import argparse
import json
import math
from copy import deepcopy
from typing import Any


STRATEGIES = {
    "normal": "常规：按预测方向，预测日前价加减报价偏移",
    "high_conf": "高确信：门槛由配置 k 控制，分支与常规相同",
    "half": "半仓：总电量预算减半",
    "aggressive": "激进：DEC报价1000，INC报价-150（仅模拟报价）",
    "always_inc": "固定 INC 方向",
    "cap_only": "固定 DEC 方向",
    "contrarian": "预测方向取反",
}

# 沿用原网页的六档置信度和节点评分权重。
CONFIDENCE_LEVELS = (0, 0.5, 1.0, 1.5, 2.0, 3.0)
DEFAULT_WEIGHTS = {"win": 3, "ev": 3, "pf": 2, "liq": 2}
# 名称沿用原意，但这里只更换排序分母，并不绕过 decide() 的 k 门槛。
NO_GATE = {"always_inc", "cap_only", "aggressive"}


def _num(value: Any) -> float:
    """兼容原 JS 数值运算：JSON 的 null 参与运算时按0处理。

    保留该行为是为了忠实移植，不代表认可把缺测行情当成零。
    原历史模拟未单独屏蔽 null，修改缺测策略可从此及 sim_day() 入手。
    """
    return 0.0 if value is None else float(value)


class StrategyEngine:
    """隔离每次计算的状态；传入的原始数据不会被本类改写。"""

    def __init__(self, data: dict[str, Any]):
        # 拷贝数据以免外部修改和引擎状态互相影响；无自动网络读取。
        self.data = deepcopy(data)
        self.meta = self.data["meta"]
        self.nodes = self.data["nodes"]
        self.series = self.data["series"]
        self.dates = self.meta["dates"]
        self.hist_end = self.meta["hist_end"]
        self.weights = dict(DEFAULT_WEIGHTS)
        today = self.meta.get("today")
        di = self.dates.index(today) if today in self.dates else self.meta["ndays"] - 1
        self.state = {
            "di": di,                 # 当前查看的日期索引
            "strat": "high_conf",    # 默认策略
            "k": 1.0,                 # |预测价差|至少达到 k 倍波动值
            "sel": [],                # 保持节点顺序，对应 JS 的有序 Set
            "mode": "auto",          # auto按EV、mine按评分、manual手选
            "nSel": 10,               # 自动选择的目标节点数
            "total": self.meta["total_mwh"],  # 每日电量预算，单位MWh
            "dp": self.meta["dp"],   # 报价相对预测DA的偏移
            "capPer": 2.0,            # 单节点单小时分配上限
            "capNode": 4.0,           # 单节点全天分配上限
            "maxCells": 12,           # 每天最多分配的节点×小时格数
            "minWin": 50,             # 节点历史胜率下限，单位百分比
            "minSpr": 5,              # 节点历史 |EV| 下限
            "maxNeg": 10,             # 与预测反向时允许的最大预测不利价差
            "w0": 0,                  # 回测起始索引，与di取较小/较大值
        }

    def is_today(self, di: int) -> bool:
        """原函数名为isToday，实际表示日期晚于历史完成日，而非自然日今天。"""
        return self.dates[di] > self.hist_end

    def get_config(self) -> dict[str, Any]:
        """将可修改状态组装成计算参数；手选节点建议使用有序列表。"""
        keys = ("sel", "total", "k", "dp", "capPer", "capNode", "maxCells", "strat", "maxNeg")
        cfg = {k: self.state[k] for k in keys}
        # 去重并保留输入顺序，保持评分相同时的分配顺序与JS一致。
        cfg["sel"] = list(dict.fromkeys(cfg["sel"]))
        return cfg

    @staticmethod
    def decide(r: list, strat: str, cfg: dict) -> dict | None:
        """单个节点、单个小时的方向及报价，尚未分配最终电量。

        r字段：r[1]=DA，r[2]=RT或其代理值，r[3]=预测RT−DA，
        r[4]=预测DA，r[5]=价差波动值。r[0]/r[6]不参与本函数。
        DEC/INC、成交和损益方向均沿用原代码，未改成另一套市场口径。
        """
        pred, sig, pda = _num(r[3]), _num(r[5]), _num(r[4])
        if strat == "always_inc":
            side = "INC"
        elif strat == "cap_only":
            side = "DEC"
        else:
            base = "DEC" if pred > 0 else "INC" if pred < 0 else None
            side = {"DEC": "INC", "INC": "DEC"}.get(base) if strat == "contrarian" else base
        if side is None:
            return None
        # 注意：所有策略均应用此门槛；high_conf没有额外隐藏判断。
        if cfg["k"] > 0 and (sig <= 0.01 or abs(pred) < sig * cfg["k"]):
            return None
        adverse = (side == "DEC" and pred < 0) or (side == "INC" and pred > 0)
        if adverse and abs(pred) > cfg["maxNeg"]:
            return None
        if strat == "aggressive":
            quote = 1000 if side == "DEC" else -150
        else:
            quote = pda + cfg["dp"] if side == "DEC" else pda - cfg["dp"]
        # qty为原决策函数返回值；实际分配由build_alloc的预算逻辑控制。
        return {"side": side, "quote": quote, "qty": 0.5 if strat == "half" else 1.0}

    def build_alloc(self, di: int, cfg: dict) -> list[dict]:
        """按信号强度排序，再按权重分配预算，同时约束单格和单节点电量。"""
        cands = []
        for node in cfg["sel"]:
            series = self.series.get(node)
            if not series:
                continue
            for hour in range(24):
                index = di * 24 + hour
                r = series[index] if index < len(series) else None
                # JS严格比较0：null不等于0；Python必须单独区分以保持原行为。
                if r is None or (r[1] is not None and r[2] is not None and r[1] == 0 and r[2] == 0):
                    continue
                decision = self.decide(r, cfg["strat"], cfg)
                if decision is None:
                    continue
                sigma = _num(r[5]) if _num(r[5]) > 0.01 else 1
                z = abs(_num(r[3])) / (8 if cfg["strat"] in NO_GATE else sigma)
                cands.append({"n": node, "h": hour, "r": r, "z": z,
                              "side": decision["side"], "quote": decision["quote"],
                              "w": max(0.12, z - cfg["k"] + 0.12)})
        cands.sort(key=lambda c: -c["z"])  # 稳定排序，平分时保留原遍历顺序
        max_cells = cfg["maxCells"] if cfg["maxCells"] > 0 else 48
        cands = cands[:int(max_cells)]
        alloc = [0.0] * len(cands)
        used: dict[str, float] = {}
        remaining = cfg["total"] * (0.5 if cfg["strat"] == "half" else 1)
        # 最多40轮；每轮把剩余预算按有效候选的权重比例分配。
        for _ in range(40):
            if remaining <= 1e-6:
                break
            active = [i for i, c in enumerate(cands)
                      if alloc[i] < cfg["capPer"] - 1e-9
                      and used.get(c["n"], 0) < cfg["capNode"] - 1e-9]
            if not active:
                break
            weight_sum = sum(cands[i]["w"] for i in active)
            if weight_sum <= 0:
                break
            taken = 0.0
            for i in active:
                c = cands[i]
                room = min(cfg["capPer"] - alloc[i], cfg["capNode"] - used.get(c["n"], 0))
                added = max(0, min(remaining * c["w"] / weight_sum, room))
                if added > 1e-9:
                    alloc[i] += added
                    used[c["n"]] = used.get(c["n"], 0) + added
                    taken += added
            remaining -= taken
            if taken < 1e-9:
                break
        return [{**c, "qty": alloc[i]} for i, c in enumerate(cands) if alloc[i] > 1e-6]

    def sim_day(self, di: int, cfg: dict) -> dict:
        """模拟单日，不发送任何交易；未完成历史日只返回预期与计划电量。"""
        allocation = self.build_alloc(di, cfg)
        pnl = pred_pnl = expected = gross = filled = 0.0
        n = hit = 0
        rows = []
        today = self.is_today(di)
        for a in allocation:
            r = a["r"]
            sign = 1 if a["side"] == "DEC" else -1
            expected += a["qty"] * sign * _num(r[3])
            gross += a["qty"]
            if today:
                rows.append({**a, "cleared": None, "pnl": None, "actual": None, "predPnl": None})
                continue
            # 原网页的简化成交判断：只比较模拟报价和DA，不含实际成交回执。
            cleared = a["quote"] >= _num(r[1]) if a["side"] == "DEC" else a["quote"] <= _num(r[1])
            actual = _num(r[2]) - _num(r[1])
            pp = a["qty"] * sign * _num(r[3]) if cleared else 0
            p = a["qty"] * actual * sign if cleared else 0
            if cleared:
                pnl += p
                pred_pnl += pp
                filled += a["qty"]
                n += 1
                hit += int(p > 0)
            rows.append({**a, "cleared": cleared, "pnl": p, "actual": actual, "predPnl": pp})
        # 返回键保持原JS命名，便于两版结果对比。
        return {"pnl": pnl, "predPnl": pred_pnl, "expected": expected, "gross": gross,
                "filled": filled, "n": n, "hit": hit, "rows": rows, "today": today}

    def sim_all(self, cfg: dict) -> dict:
        """回测w0与di之间的日期，跳过hist_end之后的预测日。

        沿用原实现：整个区间使用同一批已选节点，节点统计不逐日重算。
        因此这里只是原前端回测的移植，不额外声称其已消除前视偏差。
        """
        lo, hi = sorted((self.state["w0"], self.state["di"]))
        days = [self.sim_day(i, cfg) for i in range(lo, hi + 1) if not self.is_today(i)]
        cumulative = peak = drawdown = 0.0
        equity = []
        for day in days:
            cumulative += day["pnl"]
            peak = max(peak, cumulative)
            drawdown = min(drawdown, cumulative - peak)
            equity.append(cumulative)
        pnls = [d["pnl"] for d in days]
        mean = sum(pnls) / max(len(pnls), 1)
        sd = math.sqrt(sum((p - mean) ** 2 for p in pnls) / max(len(pnls) - 1, 1))
        filled = sum(d["filled"] for d in days)
        trades = [r["pnl"] for d in days for r in d["rows"] if r["cleared"]]
        return {"eq": equity, "daily": pnls, "total": cumulative, "maxdd": drawdown,
                "ndays": len(days), "sharpe": mean / sd * math.sqrt(252) if sd > 0 else 0,
                "winRate": sum(p > 0 for p in trades) / len(trades) * 100 if trades else 0,
                "perMWh": cumulative / filled if filled > 0 else 0,
                "filled": filled, "totalTrades": len(trades),
                "totExp": sum(d["expected"] for d in days),
                "totGross": sum(d["gross"] for d in days),
                "predTotal": sum(d["predPnl"] for d in days)}

    def node_factors(self, node: dict, strat: str) -> dict:
        """使用上游预先计算的节点胜率、EV、盈亏比及样本量，缩放到评分区间。"""
        sc = node["strat"][strat]
        max_n = max([n["strat"][strat]["n"] for n in self.nodes] + [1])
        return {"win": sc["win"] / 100,
                "ev": max(0, min(1, (sc["ev"] + 1) / 8)),
                "pf": max(0, min(1, sc["pf"] / 3)),
                "liq": max(0, min(1, math.sqrt(sc["n"] / max_n)))}

    def ranked_nodes(self) -> list[dict]:
        """auto模式按EV降序，其他模式按综合评分、再按EV降序。"""
        strat = self.state["strat"]
        weight_sum = sum(self.weights.values())
        scored = []
        for node in self.nodes:
            factors = self.node_factors(node, strat)
            score = sum(self.weights[k] * factors[k] for k in self.weights)
            scored.append({"n": node, "f": factors, "s": score / weight_sum * 100 if weight_sum > 0 else 0})
        if self.state["mode"] == "auto":
            scored.sort(key=lambda x: -x["n"]["strat"][strat]["ev"])
        else:
            scored.sort(key=lambda x: (-x["s"], -x["n"]["strat"][strat]["ev"]))
        return scored

    def pass_thresh(self, item: dict) -> bool:
        """初步筛选：历史胜率及|EV|门槛，后续补选可能放宽这些门槛。"""
        sc = item["n"]["strat"][self.state["strat"]]
        return sc["win"] >= self.state["minWin"] and abs(sc["ev"]) >= self.state["minSpr"]

    def apply_auto_select(self) -> None:
        """更新内存中的已选节点；手动模式保留原选择。

        保留原候选不足时的回退：先补其他正EV节点，仍不足则直接取完整
        排序池前nSel个。因此minWin/minSpr不是不可突破的硬约束。
        """
        if self.state["mode"] == "manual":
            return
        ranked = self.ranked_nodes()
        strat = self.state["strat"]
        target = self.state["nSel"]
        selected = [x for x in ranked if self.pass_thresh(x) and x["n"]["strat"][strat]["ev"] > 0]
        if len(selected) < target:
            selected_keys = {x["n"]["k"] for x in selected}
            selected += [x for x in ranked if x["n"]["k"] not in selected_keys and x["n"]["strat"][strat]["ev"] > 0]
        pool = selected if len(selected) >= target else ranked
        self.state["sel"] = list(dict.fromkeys(x["n"]["k"] for x in pool[:target]))


def main() -> None:
    """可选命令行入口：读取本地JSON并输出模拟结果，不修改输入文件。"""
    parser = argparse.ArgumentParser(description="CAISO策略离线计算（不执行交易）")
    parser.add_argument("--data", required=True, help="embedded-data.json本地路径")
    parser.add_argument("--date", help="查看日期，必须存在于输入数据的meta.dates")
    parser.add_argument("--start-date", help="回测起点，默认使用输入数据最早日期")
    parser.add_argument("--strategy", choices=STRATEGIES, default="high_conf", help="策略标识")
    parser.add_argument("--k", type=float, default=1.0, help="置信度倍数")
    args = parser.parse_args()
    if not math.isfinite(args.k) or args.k < 0:
        parser.error("--k必须是非负有限数")
    with open(args.data, encoding="utf-8") as f:
        engine = StrategyEngine(json.load(f))
    for date, field in ((args.date, "di"), (args.start_date, "w0")):
        if date is not None:
            if date not in engine.dates:
                parser.error(f"日期不在输入数据范围：{date}")
            engine.state[field] = engine.dates.index(date)
    engine.state.update(strat=args.strategy, k=args.k)
    engine.apply_auto_select()
    cfg = engine.get_config()
    result = {"classification": "本地策略模拟，非真实成交或正式结算",
              "date": engine.dates[engine.state["di"]], "config": cfg,
              "day": engine.sim_day(engine.state["di"], cfg), "backtest": engine.sim_all(cfg)}
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
