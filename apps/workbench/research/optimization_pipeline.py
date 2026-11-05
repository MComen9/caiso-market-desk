#!/usr/bin/env python3
"""Second, explicitly developmental CAISO price experiment.

The previous October evaluation was already inspected. No result in this file is
advertised as a fresh, independent holdout. All rolling predictions nevertheless
respect D-2 feature, label, selector and calibration availability. New genuinely
forward forecasts retain their actual publication timestamp.
"""
from __future__ import annotations

import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

import argparse
import csv
import hashlib
import json
import math
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import forecast_pipeline as fp

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data/forecast-lab/v2'
VERSION = 'caiso-price-forecast-2.0.0'
BASELINE = {'da': 'mean14', 'spread': 'zero'}
CANDIDATES = [
    {'id': 'zero', 'label': '零价差 / DA 14 日均值', 'family': 'baseline', 'params': {}},
    {'id': 'mean14', 'label': '同小时 14 日均值', 'family': 'baseline', 'params': {'window': 14}},
    {'id': 'median7', 'label': '同小时 7 日中位数', 'family': 'robust_location', 'params': {'window': 7}},
    {'id': 'median14', 'label': '同小时 14 日中位数', 'family': 'robust_location', 'params': {'window': 14}},
    {'id': 'median28', 'label': '同小时 28 日中位数', 'family': 'robust_location', 'params': {'window': 28}},
    {'id': 'trimmed14', 'label': '14 日截尾均值', 'family': 'robust_location', 'params': {'window': 14, 'trimEachTail': 0.15}},
    {'id': 'ewm14', 'label': '14 日指数加权 · 半衰期 3 日', 'family': 'ewm', 'params': {'window': 14, 'halfLife': 3}},
    {'id': 'ewm28', 'label': '28 日指数加权 · 半衰期 7 日', 'family': 'ewm', 'params': {'window': 28, 'halfLife': 7}},
    {'id': 'shrink14', 'label': '14 日中位数 · 价差收缩 50%', 'family': 'shrinkage', 'params': {'window': 14, 'spreadMultiplier': 0.5}},
    {'id': 'median_mix', 'label': '7 / 14 / 28 日中位数组合', 'family': 'fixed_ensemble', 'params': {'weights': [1/3, 1/3, 1/3]}},
    {'id': 'ridge28', 'label': 'Ridge · 28 日窗 · α=100', 'family': 'ridge', 'params': {'window': 28, 'alpha': 100}},
    {'id': 'ridge56', 'label': 'Ridge · 56 日窗 · α=100', 'family': 'ridge', 'params': {'window': 56, 'alpha': 100}},
]
IDS = [c['id'] for c in CANDIDATES]
DESIGN = {
    'pipelineVersion': VERSION, 'candidates': CANDIDATES,
    'informationDelayDays': 2, 'forecastWarmupDays': 28,
    'matureEvaluationWarmupDays': 49,
    'selector': {'windowDays': 14, 'minimumDays': 7, 'bestTolerance': 0.05,
                 'maxActiveCandidates': 2, 'baselineFloorWeight': 0.2,
                 'loss': 'daily mean absolute error, equal day weight, all hubs',
                 'rule': 'Select at most two candidates within 5% of lowest causal rolling MAE; inverse-MAE weights plus 20% baseline.'},
    'calibration': {'windowDays': 14, 'minimumBucketRows': 48, 'minimumNodeRows': 72,
                    'localHourBuckets': [[0,5],[6,11],[12,17],[18,23]], 'quantiles': [0.1,0.9]},
    'oldSeenComparisonWindow': {'startDate': '2026-10-15', 'endDate': '2026-10-28', 'days': 14},
    'prospectiveWindow': {'startDate': '2026-10-30', 'endDate': '2026-11-26', 'days': 28},
    'selectionDoesNotUseTradingPnl': True,
    'classification': 'developmental_historical_reconstruction',
    'knownPriorEvidence': 'v1 Oct15–28 outcomes were already inspected; this is development, not a new independent test.',
}


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    os.replace(temporary, path)


def freeze_protocol(output=OUT):
    path = output / 'protocol.json'
    if path.exists():
        saved = json.loads(path.read_text())
        if saved['design'] != DESIGN:
            raise ValueError('Protocol changed after freezing; establish a new version instead of silently retuning')
        return saved
    protocol = {'schemaVersion': 1, 'frozenAt': fp.iso(datetime.now(timezone.utc)),
                'designDigest': fp.digest(DESIGN), 'design': DESIGN}
    write_json(path, protocol)
    return protocol


def location_forecast(history, row, target):
    values = {window: np.asarray(history.same_hour(row, target, window)) for window in (7,14,28)}
    if not len(values[14]):
        raise ValueError('No causally available history')
    med = {w: float(np.median(v)) for w,v in values.items()}
    trimmed = np.sort(values[14]); trim = int(len(trimmed) * .15)
    if trim: trimmed = trimmed[trim:-trim]
    def ewm(window, half_life):
        # Build explicit lag weights, so a missing old day cannot shift age.
        pairs = [(history.value(fp.shifted(row['localDate'], -lag), row['node'], row['localHour'], target),
                  2. ** (-(lag-2)/half_life)) for lag in range(2,window+2)]
        pairs = [(v,w) for v,w in pairs if math.isfinite(v)]
        return float(sum(v*w for v,w in pairs) / sum(w for _,w in pairs))
    return {'zero': 0. if target == 'spread' else float(values[14].mean()),
            'mean14': float(values[14].mean()), **{f'median{w}': med[w] for w in med},
            'trimmed14': float(trimmed.mean()), 'ewm14': ewm(14,3), 'ewm28': ewm(28,7),
            'shrink14': med[14] * (.5 if target == 'spread' else 1.),
            'median_mix': float(np.mean(list(med.values())))}


def select_weights(records, day, target):
    start, end = fp.shifted(day,-15), fp.shifted(day,-2)
    eligible = [r for r in records if start <= r['localDate'] <= end]
    days = sorted({r['localDate'] for r in eligible})
    if len(days) < 7:
        return {BASELINE[target]: 1.}, {'startDate': start, 'endDate': end, 'days': len(days), 'fallback': True, 'losses': {}}
    # Equal day weighting avoids treating correlated hourly rows as independent days.
    key = 'actualDa' if target == 'da' else 'actualSpread'
    ids = [i for i in IDS if not (target == 'da' and i in ('zero','shrink14'))]
    losses = {identifier: float(np.mean([np.mean([abs(r[key]-r['predictions'][identifier][target])
               for r in eligible if r['localDate']==d]) for d in days])) for identifier in ids}
    best = min(losses.values())
    chosen = sorted([i for i in ids if losses[i] <= best * 1.05 + 1e-12], key=lambda i:(losses[i],IDS.index(i)))[:2]
    inverse = {i: 1./max(losses[i],.25) for i in chosen}
    denominator = sum(inverse.values())
    weights = {i: .8*w/denominator for i,w in inverse.items()}
    weights[BASELINE[target]] = weights.get(BASELINE[target],0.) + .2
    return weights, {'startDate': start, 'endDate': end, 'days': len(days), 'fallback': False, 'losses': losses}


def calibrate(records, day, node, hour, target):
    start, end = fp.shifted(day,-15), fp.shifted(day,-2)
    eligible = [r for r in records if start <= r['localDate'] <= end and r['node'] == node]
    bucket = int(hour[:2]) // 6
    local = [r for r in eligible if int(r['localHour'][:2]) // 6 == bucket]
    use = local if len(local)>=48 else eligible
    level = 'hour_bucket' if len(local)>=48 else 'node'
    if len(use) < (48 if level=='hour_bucket' else 72):
        return {'n':len(use),'sigma':None,'lower':None,'upper':None,'level':'insufficient'}
    actual = 'actualDa' if target=='da' else 'actualSpread'
    predicted = 'predictedDa' if target=='da' else 'predictedSpread'
    errors = np.asarray([r[actual]-r[predicted] for r in use])
    return {'n':len(errors),'sigma':float(np.std(errors,ddof=1)),
            'lower':float(np.quantile(errors,.1)), 'upper':float(np.quantile(errors,.9)), 'level':level}


def metrics(points, candidate=None):
    result = {}
    for target in ('da','spread'):
        actual = [p['actualDa' if target=='da' else 'actualSpread'] for p in points]
        predicted = [p['predictions'][candidate][target] if candidate else p['predictedDa' if target=='da' else 'predictedSpread'] for p in points]
        result[target] = fp.metric(actual,predicted,spread=target=='spread')
    return result


def baseline_metrics(points):
    return {target:metrics(points,BASELINE[target])[target] for target in ('da','spread')}


def improvement(previous, current):
    return 100. * (previous-current) / previous if previous else 0.


def run(input_path, output, forecast_date='2026-10-30'):
    protocol = freeze_protocol(output)
    raw = input_path.read_bytes(); archive = json.loads(raw)
    history = fp.MarketHistory(archive)
    if history.excluded:
        raise ValueError('Expanded archive includes incomplete labels; use audited complete suffix')
    # Every included day and hub must be complete; DST uses actual UTC hours.
    for d in history.dates:
        expected={(r['node'],r['startUtc']) for r in fp.hours_for_day(d,history.nodes)}
        observed={(r['node'],r['startUtc']) for r in history.rows if r['localDate']==d}
        if expected != observed: raise ValueError('Incomplete training day: '+d)
    expected_days = (datetime.fromisoformat(history.dates[-1])-datetime.fromisoformat(history.dates[0])).days+1
    if expected_days != len(history.dates): raise ValueError('Training archive has a date gap')
    source_sha = hashlib.sha256(raw).hexdigest()
    version = VERSION+'+'+fp.digest({'protocol':protocol['designDigest'],'input':source_sha})[:12]
    rows = [r for r in history.rows if r['localDate'] >= fp.shifted(history.dates[0],7)]
    matrix = np.vstack([history.features(r) for r in rows]); dates=np.asarray([r['localDate'] for r in rows])
    labels={'da':np.asarray([r['dam'] for r in rows]),'spread':np.asarray([r['spread'] for r in rows])}
    start = fp.shifted(history.dates[0],28)
    evaluation_dates = [d for d in history.dates if d>=start]
    record=[]; audit=[]; final_models={}; future=[]; future_failure=None
    try:
        if fp.parse_utc(fp.decision_cutoff(forecast_date)) <= datetime.now(timezone.utc): raise ValueError('研究截点已经过去，不能回填发布时间')
        fp.require_fresh_history(history,forecast_date)
        forward_ready=True
    except ValueError as error:
        forward_ready=False;future_failure=str(error)
    all_days=evaluation_dates+([forecast_date] if forward_ready else [])
    for day_index,day in enumerate(all_days):
        is_future = day == forecast_date
        targets=fp.hours_for_day(day,history.nodes)
        x=np.vstack([history.features(r) for r in targets])
        pred={identifier:{'da':[],'spread':[]} for identifier in IDS}
        for row in targets:
            for target in ('da','spread'):
                for identifier,value in location_forecast(history,row,target).items(): pred[identifier][target].append(value)
        model_states={}; ridge_training_rows={}
        for days_window in (28,56):
            identifier=f'ridge{days_window}'
            mask=(dates<=fp.shifted(day,-2)) & (dates>=fp.shifted(day,-days_window-1))
            ridge_training_rows[identifier]=int(np.sum(mask))
            for target in ('da','spread'):
                model=Pipeline([('impute',SimpleImputer(strategy='median',keep_empty_features=True)),
                                ('scale',StandardScaler()),('model',Ridge(alpha=100))])
                model.fit(matrix[mask],labels[target][mask]);pred[identifier][target]=model.predict(x).tolist()
                if is_future: model_states[f'{identifier}_{target}']=fp.export_fitted(model,{'id':identifier,'family':'ridge','params':{'alpha':100,'window':days_window}},history.feature_names)
        selectors={t:select_weights(record,day,t) for t in ('da','spread')}
        weights={t:selectors[t][0] for t in selectors}
        train_rows=[r for r in rows if r['localDate']<=fp.shifted(day,-2)]
        train_end=max(r['endUtc'] for r in train_rows)
        day_rows=[]
        for i,row in enumerate(targets):
            p={identifier:{target:float(pred[identifier][target][i]) for target in ('da','spread')} for identifier in IDS}
            da=sum(weight*p[identifier]['da'] for identifier,weight in weights['da'].items())
            spread=sum(weight*p[identifier]['spread'] for identifier,weight in weights['spread'].items())
            cal={t:calibrate(record,day,row['node'],row['localHour'],t) for t in ('da','spread')}
            actual=history.by_key.get((row['node'],row['startUtc'])) if not is_future else None
            point={**row,'predictedDa':float(da),'predictedSpread':float(spread),'predictedFmm':float(da+spread),
                   'sigma':cal['spread']['sigma'],'decisionAsOfUtc':fp.decision_cutoff(day),'modelVersion':version,
                   'trainingEndUtc':train_end,'sampleCount':len(train_rows),'calibrationCount':cal['spread']['n'],
                   'calibrationLevel':cal['spread']['level'],
                   'actualDa':actual['dam'] if actual else None,'actualFmm':actual['fmm'] if actual else None,
                   'actualSpread':actual['spread'] if actual else None,
                   'split':'forward' if is_future else 'development',
                   'selectionEligibleAtAsOf':True,'selectionAvailableForTargetFrom':start,
                   'classification':'forward_forecast' if is_future else 'historical_reconstruction',
                   'predictions':p}
            for t,center in [('da',da),('spread',spread)]:
                point[t+'Low80']=float(center+cal[t]['lower']) if cal[t]['lower'] is not None else None
                point[t+'High80']=float(center+cal[t]['upper']) if cal[t]['upper'] is not None else None
            day_rows.append(point)
        if is_future:
            future=day_rows;final_models={'weights':weights,'selectorAudit':{t:selectors[t][1] for t in selectors},'ridgeModels':model_states}
        else: record.extend(day_rows)
        audit.append({'targetDate':day,'latestLabelDate':fp.shifted(day,-2),'trainingEndUtc':train_end,
                      'trainingRows':len(train_rows),'ridgeTrainingRows':ridge_training_rows,'weights':weights,'selector':{t:selectors[t][1] for t in selectors},
                      'decisionAsOfUtc':fp.decision_cutoff(day)})
        if day_index%10==0 or is_future or day_index==len(all_days)-1:
            print(f'V2 causal rolling {day_index+1}/{len(all_days)} · {day} · {len(train_rows)} labels',flush=True)
    generated=fp.iso(datetime.now(timezone.utc))
    if future and fp.parse_utc(generated)>=fp.parse_utc(fp.decision_cutoff(forecast_date)):
        future=[];future_failure='运算跨越研究截点，前向预测未发布；保留开发评估。'
    for p in record+future: p['issuedAt']=generated
    mature_start=fp.shifted(history.dates[0],49)
    mature=[r for r in record if r['localDate']>=mature_start]
    if not mature: raise ValueError('Need at least 50 complete days for mature evaluation')
    seen=[r for r in record if '2026-10-15'<=r['localDate']<='2026-10-28']
    v1=json.loads((ROOT/'public/data/forecast-lab/forecast-history.json').read_text())
    prior={(p['node'],p['startUtc']):p for p in v1['points']}
    matched=[p for p in seen if (p['node'],p['startUtc']) in prior]
    v1m={t:fp.metric([p['actualDa' if t=='da' else 'actualSpread'] for p in matched],
                        [prior[(p['node'],p['startUtc'])]['predictedDa' if t=='da' else 'predictedSpread'] for p in matched],spread=t=='spread') for t in ('da','spread')}
    v2m=metrics(matched);basem=baseline_metrics(matched)
    def compare_prior(values):
        previous={t:fp.metric([p['actualDa' if t=='da' else 'actualSpread'] for p in values],
                    [prior[(p['node'],p['startUtc'])]['predictedDa' if t=='da' else 'predictedSpread'] for p in values],spread=t=='spread') for t in ('da','spread')}
        return {'v1':previous,'v2':metrics(values),'baseline':baseline_metrics(values)}
    interval_metrics={}
    for t,actual in [('da','actualDa'),('spread','actualSpread')]:
        valid=[p for p in seen if p[t+'Low80'] is not None]
        interval_metrics[t+'Coverage80']=float(np.mean([p[t+'Low80']<=p[actual]<=p[t+'High80'] for p in valid])) if valid else None
    interval_metrics['calibrationDays']=14
    def group_metric(values): return metrics(values)
    daily=[]
    for d in sorted({p['localDate'] for p in mature}):
        values=[p for p in mature if p['localDate']==d];m=metrics(values)
        daily.append({'date':d,'daMae':m['da']['mae'],'spreadMae':m['spread']['mae'],'signAccuracy':m['spread']['signAccuracy']})
    blocks=[]
    for month in sorted({p['localDate'][:7] for p in mature}):
        values=[p for p in mature if p['localDate'].startswith(month)]
        ds=sorted({p['localDate'] for p in values})
        blocks.append({'startDate':ds[0],'endDate':ds[-1],'days':len(ds),'v2':metrics(values),'baseline':baseline_metrics(values)})
    validation=[p for p in record if '2026-09-25'<=p['localDate']<='2026-10-06']
    calibration=[p for p in record if '2026-10-08'<=p['localDate']<='2026-10-13']
    if not validation: validation=mature
    if not calibration: calibration=mature
    candidates=[{**c,'validation':metrics(validation,c['id']),'calibration':metrics(calibration,c['id']),
                 'holdout':metrics(seen,c['id']),'rolling':metrics(mature,c['id'])} for c in CANDIDATES]
    selection={t:{'id':'causal_ensemble','label':'因果滚动组合 · '+('日前价' if t=='da' else '价差'),
                    'validationMae':metrics(validation)[t]['mae'],'baselineMae':baseline_metrics(validation)[t]['mae'],
                    'improvementPct':improvement(baseline_metrics(validation)[t]['mae'],metrics(validation)[t]['mae'])} for t in ('da','spread')}
    warning=[
        '第二轮开发研究：上一轮 Oct15–28 结果已被观察，这些指标不能再被称为独立测试或未见样本。',
        '历史每个预测起点的特征、标签、滚动选模误差和区间残差均限于 D−2；历史重建仍不能证明当时数据版本或预测已经存在。',
        'OASIS 归档可能含事后修订；三个枢纽与小时样本相关，不应把行数当作独立样本数。',
        '80% 区间为最近滚动残差的经验分位数；样本少或状态变化时覆盖不足，不是获利概率。',
        '新增候选和组合规则根据上一轮已见失败设计；所有后续结论仍需新的事前归档数据验证。',
        '前向验证窗口已冻结，但没有启用无人值守调度；尚未归档的未来日期不计为已完成预测。',
    ]
    report={'schemaVersion':2,'experimentId':'forecast-optimization-'+fp.digest({'protocol':protocol['designDigest'],'input':source_sha})[:16],
            'modelVersion':version,'generatedAt':generated,'classification':'developmental_reconstruction_and_forward_forecast',
            'sample':{'startDate':history.dates[0],'endDate':history.dates[-1],'days':len(history.dates),'rows':len(history.rows),'nodes':history.nodes,
                      'inputSha256':source_sha,'archiveDigest':archive['digest'],'sourceFetchedAt':archive.get('fetchedAt'),'excludedRows':history.excluded},
            'splits':fp.SPLITS,'selectedModels':selection,'candidates':candidates,
            'holdout':{'selected':v2m,'baseline':basem,'daily':[d for d in daily if d['date']>='2026-10-15'],
                       'byNode':[{'node':n,**metrics([p for p in seen if p['node']==n])} for n in history.nodes],
                       'intervals':interval_metrics,'classification':'previously_seen_development_comparison'},
            'forecast':{'targetDate':forecast_date,'issuedAt':generated if future else None,'decisionAsOfUtc':fp.decision_cutoff(forecast_date),
                        'trainingThrough':fp.shifted(forecast_date,-2) if future else history.dates[-1],
                        'trainingEndUtc':future[0]['trainingEndUtc'] if future else None,'rows':len(future),
                        'status':'before_cutoff' if future else 'blocked_no_eligible_forecast','reason':future_failure,
                        'url':'/data/forecast-lab/v2/forecast-forward.json'},
            'method':{'selectionRule':'每个预测日只使用 D−2 及更早的过去14日日均 MAE；距最低 MAE 5% 内最多选两个候选，按 MAE 倒数加权，并固定保留20%基线权重。','featureDelayDays':2,'seed':42,'featureNames':history.feature_names,
                      'calibration':'过去14日因果滚动组合残差，按枢纽及6小时段估计；不足48段样本回退枢纽池；仍不足72点则不输出区间。',
                      'training':'12个冻结候选；价格和价差分别通过D−2以前的14日样本外MAE选择至多2个候选；固定20%基线权重。Ridge限28/56日训练窗。',
                      'parameterOptimization':'候选、窗口和组合权重规则在本轮结果前冻结；不以本轮策略收益调参。',
                      'sampleCountMeaning':'sampleCount / trainingRows 是当时共同可用标签数；Ridge 实际仅用各自28/56日窗，具体数量见 fitAudit.ridgeTrainingRows；统计候选只用指定同节点同小时窗口。','fitAudit':audit},
            'featureAudit':json.loads((ROOT/'public/data/forecast-lab/report.json').read_text())['featureAudit'],
            'warnings':warning,'sources':json.loads((ROOT/'public/data/forecast-lab/report.json').read_text())['sources'],
            'artifacts':{k:'/data/forecast-lab/v2/'+f for k,f in {'forward':'forecast-forward.json','history':'forecast-history.json','walkForward':'all-walk-forward.json','csv':'predictions.csv','models':'models.json'}.items()},
            'promotionGate':{'status':'research_only','approvedForTrading':False,'passedBaselineChecks':all(v2m[t]['mae']<basem[t]['mae'] for t in ('da','spread')),
                             'reason':'已知历史的开发评估不能替代新的前向验证。'},
            'optimization':{'protocolFrozenAt':protocol['frozenAt'],'protocolDigest':protocol['designDigest'],
                            'evaluationLabel':'开发性滚动验证（已知历史）','candidateCount':len(CANDIDATES),
                            'comparisonWindow':DESIGN['oldSeenComparisonWindow'],
                            'comparison':{'v1':v1m,'v2':v2m,'baseline':basem,'maeImprovementVsV1Pct':{t:improvement(v1m[t]['mae'],v2m[t]['mae']) for t in ('da','spread')}},
                            'rollingWindow':{'startDate':mature[0]['localDate'],'endDate':mature[-1]['localDate'],'days':len({p['localDate'] for p in mature}),'rows':len(mature)},
                            'rolling':{'v2':metrics(mature),'baseline':baseline_metrics(mature)},'blocks':blocks,
                            'diagnostics':{'byHour':[{'hour':f'{h:02d}:00',**metrics([p for p in mature if int(p['localHour'][:2])==h])} for h in range(24)],
                                           'comparisonByHour':[{'hour':f'{h:02d}:00',**compare_prior([p for p in matched if int(p['localHour'][:2])==h])} for h in range(24)],
                                           'comparisonByDay':[{'date':d,**compare_prior([p for p in matched if p['localDate']==d])} for d in sorted({p['localDate'] for p in matched})],
                                           'comparisonByNode':[{'node':n,**compare_prior([p for p in matched if p['node']==n])} for n in history.nodes],
                                           'worstDays':sorted(daily,key=lambda d:d['spreadMae'],reverse=True)[:10]},
                            'finalWeights':final_models.get('weights'),
                            'prospective':{**DESIGN['prospectiveWindow'],'status':'pending_actuals','generatedForecastDays':1 if future else 0,'archivedForecastDays':0,'evaluatedDays':0},
                            'limitations':warning}}
    report['featureAudit'][0]['reason']=f'{len(history.dates)}日完整配对价格；新增长历史保持来源和摘要。'
    report['featureAudit'][1]['reason']='仅 Oct28–29 快照，缺少覆盖本次扩展训练窗并能证明决策前可用的发布批次。'
    report['featureAudit'][2]['reason']='仅两日快照，口径与发布时间不齐，无法支撑本次扩展历史训练。'
    report['featureAudit'][4]['reason']='本地仅8日归档，与扩展训练期不齐；本次研究目标为 FMM−DA。'
    def bundle(points,label):
        clean=[{k:v for k,v in p.items() if k!='predictions'} for p in points]
        return {'schemaVersion':1,'id':'v2-'+label+'-'+fp.digest(clean)[:16],
                'name':f'V2 稳健滚动预测 · {forecast_date}' if label=='forward' else 'V2 历史开发重建 · '+label,
                'source':'CAISO OASIS 真实归档 · 冻结稳健候选及因果组合','modelVersion':version,
                'createdAt':generated,'generatedAt':generated,'digest':fp.digest(clean),
                'classification':'forward_forecast' if label=='forward' else 'historical_reconstruction',
                'metadata':{'protocolDigest':protocol['designDigest'],'evaluationLabel':'development_only','informationDelayDays':2},'points':clean,'warnings':warning}
    output.mkdir(parents=True,exist_ok=True)
    write_json(output/'report.json',report)
    write_json(output/'forecast-forward.json',bundle(future,'forward'))
    write_json(output/'forecast-history.json',bundle(mature,'development'))
    write_json(output/'all-walk-forward.json',bundle(record,'walk-forward'))
    write_json(output/'candidate-predictions.json',{'modelVersion':version,'generatedAt':generated,'points':record})
    write_json(output/'models.json',{'modelVersion':version,'generatedAt':generated,'inputSha256':source_sha,
                                    'protocol':protocol,'finalModels':final_models,'featureNames':history.feature_names})
    csv_temp=output/'.predictions.csv.tmp'
    clean=bundle(mature+future,'csv')['points']
    with csv_temp.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(clean[0]));writer.writeheader();writer.writerows(clean)
    os.replace(csv_temp,output/'predictions.csv')
    print(json.dumps({'sample':report['sample'],'modelVersion':version,'comparison':report['optimization']['comparison'],
                      'rolling':report['optimization']['rolling'],'forecast':report['forecast']},ensure_ascii=False,indent=2),flush=True)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=ROOT/'data/strategy-history-expanded.json')
    parser.add_argument('--output',type=Path,default=OUT)
    parser.add_argument('--forecast-date',default='2026-10-30')
    parser.add_argument('--freeze-only',action='store_true')
    args=parser.parse_args()
    if args.freeze_only: print(json.dumps(freeze_protocol(args.output),ensure_ascii=False));return
    run(args.input,args.output,args.forecast_date)

if __name__=='__main__': main()
