#!/usr/bin/env python3
"""Independently replay frozen V3 research orders with Python's standard library.

This is a decision-plan contract, not the price/spread contract consumed by
trading_strategy.py. It never retrains a model or chooses a winning policy.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from copy import deepcopy
from datetime import date as CalendarDate, datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

VERSION = 'caiso-decision-replay-1.0.0'
PT = ZoneInfo('America/Los_Angeles')
EPS = 1e-8


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('UTC timestamp must be a string')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.utcoffset() is None:
        raise ValueError('Timestamp must include a timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def input_digest(value):
    content = deepcopy(value)
    content['meta'].pop('inputDigest', None)
    return digest(content)


def parse_day(value):
    if not isinstance(value,str):
        raise ValueError('PT date must use YYYY-MM-DD')
    try:
        parsed = CalendarDate.fromisoformat(value)
    except ValueError as error:
        raise ValueError('PT date must be a valid YYYY-MM-DD calendar date') from error
    if parsed.isoformat() != value:
        raise ValueError('PT date must use YYYY-MM-DD without a time component')
    return parsed


def day_hours(day):
    start = datetime.combine(parse_day(day),datetime.min.time(),tzinfo=PT)
    finish = (start + timedelta(days=1)).astimezone(timezone.utc)
    current = start.astimezone(timezone.utc)
    result = []
    while current < finish:
        result.append((iso(current), iso(current + timedelta(hours=1))))
        current += timedelta(hours=1)
    return result


def cutoff(day):
    previous = datetime.combine(parse_day(day),datetime.min.time()) - timedelta(days=1)
    return previous.replace(hour=9, minute=55, tzinfo=PT).astimezone(timezone.utc)


def validate(data):
    if data.get('schemaVersion') != 1 or data.get('inputKind') != 'frozen_decision_plans':
        raise ValueError('Expected frozen_decision_plans schemaVersion 1, not price/spread input')
    meta = data['meta']
    if meta.get('classification') != 'historical_decision_reconstruction':
        raise ValueError('This release accepts historical decision research only; V3 has no forward batch')
    if meta.get('inputDigest') != input_digest(data):
        raise ValueError('Input digest differs: frozen data or plans were changed')
    generated = timestamp(meta['generatedAt'])
    dates, nodes, policies = data['dates'], data['nodes'], data['policyIds']
    if not dates or dates != sorted(set(dates)) or not nodes or len(nodes) != len(set(nodes)):
        raise ValueError('Dates must be unique and ordered; nodes must be unique and nonempty')
    for day in dates:
        parse_day(day)
    if not policies or len(policies) != len(set(policies)):
        raise ValueError('Policy IDs must be unique and nonempty')
    bounds = data['constraints']
    for name in ('dailyMWh', 'perCellMWh', 'perNodeMWh', 'maxCells'):
        if not finite(bounds.get(name)) or bounds[name] < 1:
            raise ValueError('Invalid allocation constraint: ' + name)
    if int(bounds['maxCells']) != bounds['maxCells'] or bounds.get('tieFill') is not False:
        raise ValueError('This release uses integer maxCells and conservative no-fill on equal quotes')
    allowed = {(node, start): end for date in dates for start, end in day_hours(date) for node in nodes}
    actuals = {}
    for row in data['actuals']:
        key = (row['node'], iso(timestamp(row['startUtc'])))
        if key not in allowed or key in actuals or iso(timestamp(row['endUtc'])) != allowed[key]:
            raise ValueError('Duplicate, unexpected, or non-hourly actual price row')
        if any(row.get(name) is not None and not finite(row[name]) for name in ('dam', 'fmm')):
            raise ValueError('Actual prices must be finite or null; zero and negative prices are valid')
        actuals[key] = row
    plans = {}
    for plan in data['plans']:
        key = (plan['policyId'], plan['date'])
        if key[0] not in policies or key[1] not in dates or key in plans:
            raise ValueError('Unexpected or duplicate policy/date plan')
        date = plan['date']
        if timestamp(day_hours(date)[-1][1]) > generated:
            raise ValueError('Historical input cannot include a trading day that had not ended at generation')
        if timestamp(plan['decisionAsOfUtc']) != cutoff(date):
            raise ValueError('Decision cutoff differs from the declared D−1 09:55 PT boundary')
        latest_day = parse_day(date) - timedelta(days=2)
        latest = latest_day.isoformat()
        if parse_day(plan['latestLabelDate']) > latest_day:
            raise ValueError('Plan uses unavailable target or D−1 labels')
        label_end = timestamp(day_hours(latest)[-1][1])
        if timestamp(plan['trainingEndUtc']) > label_end:
            raise ValueError('Training end exceeds D−2 actual-data availability')
        orders = plan['orders']
        if len(orders) > bounds['maxCells']:
            raise ValueError('Too many allocated node/hour cells')
        seen = set()
        node_volume = defaultdict(float)
        total = 0.
        for order in orders:
            order_key = (order['node'], iso(timestamp(order['startUtc'])))
            if order_key not in allowed or order_key in seen:
                raise ValueError('Order has unexpected node/hour or duplicates both directions in one cell')
            if timestamp(order['startUtc']).astimezone(PT).date().isoformat() != date:
                raise ValueError('Order is outside its PT trading day')
            if iso(timestamp(order['endUtc'])) != allowed[order_key]:
                raise ValueError('Order duration is not its exact UTC hour')
            if order.get('side') not in ('INC', 'DEC') or not finite(order.get('quote')):
                raise ValueError('Order direction or quote is invalid')
            quantity = order.get('mwh')
            if not finite(quantity) or quantity < 1-EPS or quantity > bounds['perCellMWh']+EPS:
                raise ValueError('Order volume violates the 1 MWh floor or per-cell cap')
            predicted = order.get('predictedNetPayoffPerSubmittedMWh')
            if predicted is not None and not finite(predicted):
                raise ValueError('Predicted payoff must be a finite amount or null, not a probability')
            seen.add(order_key)
            node_volume[order['node']] += quantity
            total += quantity
        if total > bounds['dailyMWh']+EPS or any(v > bounds['perNodeMWh']+EPS for v in node_volume.values()):
            raise ValueError('Daily or node volume constraint exceeded')
        plans[key] = plan
    if set(plans) != {(policy, date) for policy in policies for date in dates}:
        raise ValueError('Every policy must contain every evaluation date, including empty plans')
    return actuals, plans


def settle(order, actual, fee):
    result = {**order, 'status': 'missing_actual', 'filled': None,
              'actualDa': None, 'actualFmm': None, 'grossPnl': None, 'fees': None, 'netPnl': None}
    if not actual or not finite(actual.get('dam')):
        return result
    da = actual['dam']
    fmm = actual.get('fmm') if actual.get('paired') is True and actual.get('fmmCount') == 4 else None
    result.update(actualDa=da, actualFmm=fmm)
    difference = order['quote']-da if order['side'] == 'DEC' else da-order['quote']
    if abs(difference) <= EPS or difference < -EPS:
        result.update(status='tie_excluded' if abs(difference) <= EPS else 'not_filled',
                      filled=False, grossPnl=0., fees=0., netPnl=0.)
    elif finite(fmm):
        direction = 1 if order['side'] == 'DEC' else -1
        gross = order['mwh'] * direction * (fmm-da)
        cost = order['mwh'] * fee
        result.update(status='filled', filled=True, grossPnl=gross, fees=cost, netPnl=gross-cost)
    else:
        result['filled'] = True
    return result


def replay(data, policy, fee=1., start=None, end=None):
    if not finite(fee) or fee < 0:
        raise ValueError('Fee must be a nonnegative finite number')
    actuals, plans = validate(data)
    if policy not in data['policyIds']:
        raise ValueError('Unknown policy ID')
    start, end = start or data['dates'][0], end or data['dates'][-1]
    if start not in data['dates'] or end not in data['dates'] or start > end:
        raise ValueError('Evaluation date range must be within the frozen input')
    days = []
    cumulative = peak = drawdown = 0.
    equity = []
    for date in data['dates']:
        if not start <= date <= end:
            continue
        plan = plans[(policy, date)]
        rows = [settle(order, actuals.get((order['node'], iso(timestamp(order['startUtc'])))), fee)
                for order in plan['orders']]
        expected = [(node, stamp) for stamp, _ in day_hours(date) for node in data['nodes']]
        covered = sum(key in actuals and finite(actuals[key].get('dam')) and finite(actuals[key].get('fmm'))
                      and actuals[key].get('paired') is True and actuals[key].get('fmmCount') == 4 for key in expected)
        complete = covered == len(expected) and all(row['netPnl'] is not None for row in rows)
        net = sum(row['netPnl'] for row in rows) if complete else None
        planned = sum(row['mwh'] for row in rows)
        day = {'date':date, 'status':('no_signals' if not rows else 'complete') if complete else 'partial',
               'plannedMWh':planned, 'unallocatedMWh':max(0., data['constraints']['dailyMWh']-planned),
               'filledMWh':sum(row['mwh'] for row in rows if row['filled'] is True),
               'grossPnl':sum(row['grossPnl'] for row in rows) if complete else None,
               'fees':sum(row['fees'] for row in rows) if complete else None, 'netPnl':net,
               'expectedActualHours':len(expected), 'availableActualHours':covered, 'orders':rows}
        days.append(day)
        if net is None:
            equity.append({'date':date, 'cumulative':None})
        else:
            cumulative += net
            peak = max(peak, cumulative)
            drawdown = max(drawdown, peak-cumulative)
            equity.append({'date':date, 'cumulative':cumulative})
    complete = [day for day in days if day['netPnl'] is not None]
    fills = [row for day in complete for row in day['orders'] if row['status'] == 'filled']
    volume = sum(row['mwh'] for row in fills)
    return {'schemaVersion':1, 'engineVersion':VERSION, 'executedAt':iso(datetime.now(timezone.utc)),
            'inputDigest':data['meta']['inputDigest'], 'experimentVersion':data['meta']['experimentVersion'],
            'classification':'historical_decision_reconstruction', 'policyId':policy, 'feePerMWh':fee,
            'startDate':start, 'endDate':end,
            'metrics':{'days':len(days), 'evaluatedDays':len(complete), 'incompleteDays':len(days)-len(complete),
                       'noSignalDays':sum(day['status']=='no_signals' for day in days),
                       'netPnl':cumulative if complete else None, 'grossPnl':sum(day['grossPnl'] for day in complete) if complete else None,
                       'fees':sum(day['fees'] for day in complete) if complete else None,
                       'plannedMWh':sum(day['plannedMWh'] for day in days), 'filledMWh':volume,
                       'trades':len(fills), 'winRate':100*sum(row['netPnl']>0 for row in fills)/len(fills) if fills else None,
                       'perFilledMWh':cumulative/volume if volume else None, 'maxDrawdown':drawdown if complete else None},
            'equity':equity, 'days':days,
            'notes':['重放冻结订单，不重新训练或按收益选择策略。',
                     '成本敏感性只改变已成交电量的费用，不改变订单、报价、方向和电量。',
                     '收益预测表示每提交 MWh 的扣费收益估计（包含未成交为0），不是价差或获利概率。',
                     '历史重建使用当前取得的价格版本，不能证明当时原始发布值；不含完整官方结算和真实成交。']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    parser.add_argument('--policy', default='ridge_payoff')
    parser.add_argument('--fee-per-mwh', type=float, default=1.)
    parser.add_argument('--start-date')
    parser.add_argument('--end-date')
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        data = json.loads(Path(args.data).read_text(encoding='utf-8'))
        result = replay(data, args.policy, args.fee_per_mwh, args.start_date, args.end_date)
        content = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n'
        if args.output:
            destination = Path(args.output)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding='utf-8')
        else:
            print(content, end='')
    except (KeyError, TypeError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
