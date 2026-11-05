#!/usr/bin/env python3
"""V3: causal development study of per-submitted-MWh simulated payoff.

No future forecast is generated here. Existing V2 price forecasts are immutable
anchors, and this newly designed policy is only reconstructed on seen history.
"""
from __future__ import annotations

import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

import argparse
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import forecast_pipeline as fp
from build_strategy_input import build_input
from trading_strategy import StrategyEngine, EPS

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'public/data/forecast-lab/v3'
VERSION = 'caiso-decision-study-3.0.0'
FEES = [0, 1, 2, 5]
POLICIES = [
    {'id':'no_trade','label':'不交易参照','kind':'reference','description':'固定零暴露；零收益不表示预测优势。'},
    {'id':'v2_original','label':'V2 原固定规则','kind':'reference','description':'原 normal、k=0.5、V2 DA±10 报价与原电量分配。'},
    {'id':'ridge_payoff','label':'Ridge · 扣费收益','kind':'candidate','description':'56 日窗、α=100；分别估计 INC/DEC 每提交 MWh 的扣费收益。'},
    {'id':'hist_payoff_price','label':'浅层提升树 · 价格','kind':'candidate','description':'与 Ridge 使用相同价格信息；固定浅层参数。'},
    {'id':'hist_payoff_fundamentals','label':'浅层提升树 · 价格＋基本面','kind':'candidate','description':'相同提升树加入 D−2 及更早实际负荷、光伏、风电滞后。'},
]
CONSTRAINTS = {'dailyMWh':12, 'perCellMWh':2, 'perNodeMWh':6, 'maxCells':12,
               'tieFill':False, 'quoteOffset':10}
TREE_PARAMS = {'loss':'squared_error','learning_rate':.05,'max_iter':100,
               'max_leaf_nodes':7,'max_depth':3,'min_samples_leaf':72,
               'l2_regularization':20,'early_stopping':False,'random_state':42}
DESIGN = {
    'version':VERSION, 'policies':POLICIES, 'defaultPolicyId':'ridge_payoff',
    'trainingWindowDays':56, 'informationDelayDays':2,
    'commonWindowStart':'first V2 out-of-sample origin plus 57 calendar days',
    'trainingFeePerMWh':1, 'evaluationFeesPerMWh':FEES,
    'target':'fill × (signed actual FMM−DA minus 1 USD/MWh); unfilled actions have zero payoff',
    'quotes':'INC=causal V2 predicted DA−10; DEC=causal V2 predicted DA+10',
    'decisionBufferPerSubmittedMWh':1,
    'decisionRule':'At each node/hour choose the higher estimated net-payoff side; require strictly >1 USD/MWh, then rank by estimated net payoff.',
    'allocation':'Same 1-MWh minimum admission and weighted residual allocation as the existing simulator, replacing z score by predicted net payoff. No actual target-day prices enter planning.',
    'constraints':CONSTRAINTS, 'ridge':{'alpha':100}, 'histGradientBoosting':TREE_PARAMS,
    'preprocessing':'Median imputation and Ridge scaling fitted on each chronological training window only; no random CV or early-stopping validation.',
    'fundamentalFeatures':{'fields':['loadMw','solarMw','windMw','netLoadMw'],
                           'sameHourLags':[2,7], 'sameHourMeanLags':[2,3,4,5,6,7,8],
                           'dMinus2DailyStatistics':['mean','max']},
    'feeSensitivity':'Freeze orders using training fee=1; fees 0/1/2/5 only revalue identical orders, never select a winner.',
    'postOutcomeDiagnostic':'Eight fixed DA/spread/sigma V1/V2 hybrids on old Oct15–28; exact three-factor Shapley, not a new candidate search.',
    'defaultComparison':'All fixed policies displayed in declared order; no profit-maximizing model selection.',
    'classification':'developmental_decision_reconstruction',
    'priorKnowledge':'V1/V2 outcomes, including Oct15–28 and V2 monthly results, were already inspected.',
    'forward':'No V3 future forecast or pre-cutoff plan is generated; the Oct30 cutoff has passed. V2 archived forecast remains separate.',
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.'+path.name+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')
    os.replace(temporary,path)


def freeze(output=OUT):
    path=output/'protocol.json'
    if path.exists():
        saved=json.loads(path.read_text())
        if saved['design']!=DESIGN: raise ValueError('Frozen V3 protocol differs; create a new experiment')
        return saved
    result={'schemaVersion':3,'frozenAt':fp.iso(datetime.now(timezone.utc)),
            'designDigest':fp.digest(DESIGN),'design':DESIGN}
    write_json(path,result)
    return result


class Fundamentals:
    """Expose only explicitly lagged PT actual observations, never target values."""
    def __init__(self, payload):
        self.rows=payload['rows']
        self.by_hour=defaultdict(list);self.by_day=defaultdict(list)
        seen=set()
        for row in self.rows:
            if row['startUtc'] in seen: raise ValueError('Duplicate fundamental UTC hour')
            seen.add(row['startUtc'])
            self.by_hour[(row['localDate'],row['localHour'])].append(row)
            self.by_day[row['localDate']].append(row)
        self.feature_names=[]

    def values(self, day, hour, field):
        return [r[field] for r in self.by_hour.get((day,hour),[]) if fp.finite(r.get(field))]

    def features(self,row):
        features={}
        for field in DESIGN['fundamentalFeatures']['fields']:
            for lag in (2,7):
                values=self.values(fp.shifted(row['localDate'],-lag),row['localHour'],field)
                features[f'{field}_lag{lag}']=float(np.mean(values)) if values else np.nan
            # DST folds are averaged per date before equal-day averaging.
            days=[self.values(fp.shifted(row['localDate'],-lag),row['localHour'],field) for lag in range(2,9)]
            values=[np.mean(v) for v in days if v]
            features[f'{field}_mean7']=float(np.mean(values)) if values else np.nan
            values=[r[field] for r in self.by_day.get(fp.shifted(row['localDate'],-2),[]) if fp.finite(r.get(field))]
            features[f'{field}_daily_mean_lag2']=float(np.mean(values)) if values else np.nan
            features[f'{field}_daily_max_lag2']=float(np.max(values)) if values else np.nan
        self.feature_names=list(features)
        return np.asarray(list(features.values()),dtype=float)


def training_mask(dates, day):
    return (dates>=fp.shifted(day,-57)) & (dates<=fp.shifted(day,-2))


def action_payoff(point,side,fee=1):
    sign=1 if side=='DEC' else -1
    quote=point['predictedDa']+sign*10
    difference=sign*(quote-point['actualDa'])
    filled=difference>EPS
    return (sign*point['actualSpread']-fee) if filled else 0.


def feature_matrix(history,points,fundamentals=None):
    vectors=[]
    for point in points:
        values=history.features(point)
        vector=np.concatenate([values,np.asarray([point['predictedDa'],point['predictedSpread'],
                                                  point['sigma'] if fp.finite(point.get('sigma')) else np.nan])])
        if fundamentals is not None: vector=np.concatenate([vector,fundamentals.features(point)])
        vectors.append(vector)
    names=history.feature_names+['v2_predictedDa','v2_predictedSpread','v2_sigma']
    if fundamentals is not None: names+=fundamentals.feature_names
    return np.vstack(vectors),names


def model_for(policy):
    steps=[('impute',SimpleImputer(strategy='median',keep_empty_features=True))]
    if policy=='ridge_payoff': steps += [('scale',StandardScaler()),('model',Ridge(alpha=100))]
    else: steps += [('model',HistGradientBoostingRegressor(**TREE_PARAMS))]
    return Pipeline(steps)


def allocate(points,predictions):
    """Inputs contain forecasts only; actual prices are excluded from this API."""
    candidates=[]
    for point,pred in zip(points,predictions):
        # INC comes first for deterministic exact ties; a tie has no special edge.
        side='INC' if pred[0]>=pred[1] else 'DEC'
        score=float(max(pred))
        if not math.isfinite(score) or score<=1: continue
        candidates.append({**point,'side':side,'quote':point['predictedDa']+(10 if side=='DEC' else -10),
                           'predictedNetPayoffPerSubmittedMWh':score,'trainingFeePerMWh':1,
                           'score':score,'weight':score-1+.12})
    candidates.sort(key=lambda p:(-p['score'],p['startUtc'],p['node']))
    remaining=12.;used=defaultdict(float);admitted=[]
    for item in candidates:
        if len(admitted)>=12 or remaining<1-EPS: break
        if 6-used[item['node']]<1-EPS: continue
        admitted.append({**item,'mwh':1.});used[item['node']]+=1;remaining-=1
    for _ in range(150):
        active=[p for p in admitted if 2-p['mwh']>EPS and 6-used[p['node']]>EPS]
        if remaining<=EPS or not active: break
        total=sum(p['weight'] for p in active);taken=0.
        for point in active:
            room=min(2-point['mwh'],6-used[point['node']])
            extra=max(0.,min(remaining*point['weight']/total,room))
            point['mwh']+=extra;used[point['node']]+=extra;taken+=extra
        remaining-=taken
        if taken<EPS: break
    for point in admitted:
        point['mwh']=math.floor(point['mwh']*1e9+.5)/1e9
        point.pop('weight');point.pop('score');point.pop('predictedDa',None)
    return admitted


def evaluate_orders(orders,actual_index):
    result=[]
    for order in orders:
        actual=actual_index[(order['node'],order['startUtc'])]
        sign=1 if order['side']=='DEC' else -1
        filled=sign*(order['quote']-actual['dam'])>EPS
        gross=order['mwh']*sign*(actual['fmm']-actual['dam']) if filled else 0.
        volume=order['mwh'] if filled else 0.
        result.append({**order,'actualDa':actual['dam'],'actualFmm':actual['fmm'],'filled':filled,
                       'grossPnl':gross,'netPnlByFee':{str(f):gross-f*volume for f in FEES}})
    return result


def daily_metrics(plan):
    orders=plan['orders'];filled=[p for p in orders if p['filled']]
    gross=sum(p['grossPnl'] for p in orders);volume=sum(p['mwh'] for p in filled)
    return {'date':plan['date'],'policyId':plan['policyId'],'grossPnl':gross,
            'plannedMWh':sum(p['mwh'] for p in orders),'filledMWh':volume,'trades':len(filled),
            'netPnlByFee':{str(f):gross-f*volume for f in FEES},
            'winCountByFee':{str(f):sum(p['netPnlByFee'][str(f)]>0 for p in filled) for f in FEES},
            'noSignal':not orders}


def aggregate(days,fee):
    cumulative=peak=drawdown=0.
    for day in sorted(days,key=lambda d:d['date']):
        cumulative+=day['netPnlByFee'][str(fee)]
        peak=max(peak,cumulative);drawdown=max(drawdown,peak-cumulative)
    filled=sum(d['filledMWh'] for d in days);trades=sum(d['trades'] for d in days)
    return {'netPnl':cumulative,'grossPnl':sum(d['grossPnl'] for d in days),'fees':filled*fee,
            'plannedMWh':sum(d['plannedMWh'] for d in days),'filledMWh':filled,'trades':trades,
            'noSignalDays':sum(d['noSignal'] for d in days),'maxDrawdown':drawdown,
            'winRate':100*sum(d['winCountByFee'][str(fee)] for d in days)/trades if trades else None,
            'perMWh':cumulative/filled if filled else None,'days':len(days)}


def old_diagnostics():
    bases={name:json.loads((ROOT/path).read_text()) for name,path in {
        'v1':'public/data/forecast-lab/holdout-input.json',
        'v2':'public/data/forecast-lab/v2/holdout-input.json'}.items()}
    simulations={};hybrids=[];pnl={}
    for bits in itertools.product((0,1),repeat=3):
        data=deepcopy(bases['v1'])
        for node in data['series']:
            for i,row in enumerate(data['series'][node]):
                for bit,column in zip(bits,(4,3,5)):
                    if bit: row[column]=bases['v2']['series'][node][i][column]
        engine=StrategyEngine(data);engine.state['feePerMWh']=1
        result=engine.sim_all(engine.get_config());pnl[bits]=result['total']
        hybrids.append({'id':''.join(map(str,bits)),'daVersion':'v2' if bits[0] else 'v1',
                        'spreadVersion':'v2' if bits[1] else 'v1','sigmaVersion':'v2' if bits[2] else 'v1',
                        'netPnl':result['total'],'filledMWh':result['filled'],'plannedMWh':result['totGross'],
                        'trades':result['totalTrades'],'noSignalDays':result['noSignalDays']})
        if bits in ((0,0,0),(1,1,1)): simulations['v2' if bits[0] else 'v1']=result
    shapley=[]
    for factor,label in enumerate(('da','spread','sigma')):
        contribution=0.
        for bits in itertools.product((0,1),repeat=3):
            if bits[factor]: continue
            k=sum(bits);weight=math.factorial(k)*math.factorial(2-k)/math.factorial(3)
            changed=list(bits);changed[factor]=1
            contribution+=weight*(pnl[tuple(changed)]-pnl[bits])
        shapley.append({'factor':label,'contribution':contribution})
    def summarize(cells):
        filled=[c for c in cells if c['status']=='filled'];wins=[c for c in filled if c['pnl']>0];losses=[c for c in filled if c['pnl']<0]
        return {'netPnl':sum(c['pnl'] for c in filled),'grossPnl':sum(c['grossPnl'] for c in filled),
                'filledMWh':sum(c['qty'] for c in filled),'plannedMWh':sum(c['qty'] for c in cells),
                'plannedCells':len(cells),'trades':len(filled),'fillRate':len(filled)/len(cells) if cells else None,
                'winRate':100*len(wins)/len(filled) if filled else None,
                'averageWin':sum(c['pnl'] for c in wins)/len(wins) if wins else None,
                'averageLoss':sum(c['pnl'] for c in losses)/len(losses) if losses else None}
    rows={k:[c for d in v['days'] for c in d['rows']] for k,v in simulations.items()}
    diagnostic={'feePerMWh':1,'window':{'startDate':'2026-10-15','endDate':'2026-10-28','days':14},
                'summary':{k:summarize(v) for k,v in rows.items()}}
    for key,field in [('byNode','n'),('byHour','localHour'),('byDay','localDate'),('bySide','side')]:
        groups=sorted({str(c[field]) for cells in rows.values() for c in cells})
        diagnostic[key]=[{'group':group,**{version:summarize([c for c in cells if str(c[field])==group])
                                          for version,cells in rows.items()}} for group in groups]
    attribution={'baselinePnl':pnl[(0,0,0)],'allV2Pnl':pnl[(1,1,1)],'delta':pnl[(1,1,1)]-pnl[(0,0,0)],
                 'hybrids':hybrids,'shapley':shapley,
                 'note':'结果后机制诊断；三项交互按所有加入顺序平均分摊。它不是未来因果效应，也未用于选择模型或策略。'}
    if abs(sum(s['contribution'] for s in shapley)-attribution['delta'])>1e-7:
        raise AssertionError('Shapley contributions do not reconcile')
    return {'v1v2':diagnostic,'inputAttribution':attribution}


def run(price_path,fundamental_path,output):
    protocol=freeze(output)
    raw=price_path.read_bytes();archive=json.loads(raw);history=fp.MarketHistory(archive)
    if history.excluded: raise ValueError('Incomplete price labels must be audited before study')
    v2=json.loads((ROOT/'public/data/forecast-lab/v2/all-walk-forward.json').read_text())
    points=sorted(v2['points'],key=lambda p:(p['startUtc'],p['node']))
    if any(p['classification']!='historical_reconstruction' for p in points):
        raise ValueError('V3 only accepts historical reconstructed V2 anchors')
    if v2['digest']!=fp.digest(v2['points']): raise ValueError('V2 anchor digest differs')
    for point in points:
        actual=history.by_key.get((point['node'],point['startUtc']))
        if actual is None or point['actualDa']!=actual['dam'] or point['actualFmm']!=actual['fmm']:
            raise ValueError('V2 anchor labels and actual-price archive disagree')
    source_sha=hashlib.sha256(raw).hexdigest()
    fundamental_raw=fundamental_path.read_bytes();fundamental_payload=json.loads(fundamental_raw)
    fundamentals=Fundamentals(fundamental_payload)
    fundamental_sha=hashlib.sha256(fundamental_raw).hexdigest()
    version=VERSION+'+'+fp.digest({'protocol':protocol['designDigest'],'prices':source_sha,
                                  'v2':v2['digest'],'fundamentals':fundamental_sha})[:12]
    matrix,names=feature_matrix(history,points)
    extra=np.vstack([fundamentals.features(p) for p in points])
    matrix_fundamental=np.column_stack([matrix,extra]);names_fundamental=names+fundamentals.feature_names
    labels=np.asarray([[action_payoff(p,'INC'),action_payoff(p,'DEC')] for p in points])
    dates=np.asarray([p['localDate'] for p in points])
    first=fp.shifted(min(dates),57);days=sorted({d for d in dates if d>=first})
    if not days: raise ValueError('Need 56 full prior V2 OOS prediction days before evaluation')
    engine=StrategyEngine(build_input(v2,archive,reconstructed=True));base_config=engine.get_config()
    base_config['feePerMWh']=1
    points_output=[];plans=[];audit=[];models={}
    order_keys=('node','startUtc','endUtc','localDate','localHour','utcOffset','predictedDa')
    for index,day in enumerate(days):
        train=training_mask(dates,day);test=dates==day
        train_dates=sorted(set(dates[train]));target=[p for p in points if p['localDate']==day]
        if len(train_dates)!=56: raise ValueError('Incomplete 56-day training window')
        expected={(r['node'],r['startUtc']) for r in fp.hours_for_day(day,history.nodes)}
        if expected!={(r['node'],r['startUtc']) for r in target}: raise ValueError('Incomplete target day')
        training_end=max(p['endUtc'] for p in points if fp.shifted(day,-57)<=p['localDate']<=fp.shifted(day,-2))
        information={'date':day,'decisionAsOfUtc':fp.decision_cutoff(day),'trainingEndUtc':training_end,
                     'latestLabelDate':fp.shifted(day,-2)}
        plan_points=[{key:p[key] for key in order_keys} for p in target]
        predictions={}
        for policy in POLICIES[2:]:
            identifier=policy['id'];with_fundamental=identifier.endswith('_fundamentals')
            x=matrix_fundamental if with_fundamental else matrix
            pair=[]
            for action,side in enumerate(('INC','DEC')):
                model=model_for(identifier);model.fit(x[train],labels[train,action]);pair.append(model.predict(x[test]))
                if day==days[-1]:
                    models[identifier+'_'+side]=fp.export_fitted(model,{'id':identifier+'_'+side,
                        'family':'ridge' if identifier=='ridge_payoff' else 'hist_gradient_boosting',
                        'params':{'alpha':100} if identifier=='ridge_payoff' else TREE_PARAMS},
                        names_fundamental if with_fundamental else names)
            values=np.column_stack(pair);predictions[identifier]=values
            orders=allocate(plan_points,values)
            plans.append({'policyId':identifier,**information,'orders':evaluate_orders(orders,history.by_key)})
        base_allocations=engine.build_alloc(engine.dates.index(day),base_config)
        base_orders=[]
        for item in base_allocations:
            hour=engine.hours[item['i']]
            base_orders.append({**hour,'node':item['n'],'side':item['side'],'quote':item['quote'],'mwh':item['qty'],
                                'predictedNetPayoffPerSubmittedMWh':None,'trainingFeePerMWh':1})
        plans.extend([{'policyId':'v2_original',**information,'orders':evaluate_orders(base_orders,history.by_key)},
                      {'policyId':'no_trade',**information,'orders':[]}])
        for n,point in enumerate(target):
            points_output.append({**{k:point[k] for k in ('node','startUtc','endUtc','localDate','localHour','utcOffset')},
                'predictedDaAnchor':point['predictedDa'],'predictedSpreadAnchor':point['predictedSpread'],
                'sigmaAnchor':point['sigma'],'actualDa':point['actualDa'],'actualFmm':point['actualFmm'],
                'trainingEndUtc':training_end,'decisionAsOfUtc':information['decisionAsOfUtc'],
                'trainingFeePerMWh':1,'payoffPredictions':{key:{'INC':float(value[n,0]),'DEC':float(value[n,1])}
                                                       for key,value in predictions.items()}})
        audit.append({**information,'trainingStartDate':train_dates[0],'trainingDays':len(train_dates),
                      'trainingRows':int(np.sum(train)),'targetRows':int(np.sum(test)),
                      'fundamentalFeatures':len(fundamentals.feature_names),
                      'fundamentalMissingTrainingValues':int(np.isnan(extra[train]).sum()),
                      'fundamentalMissingTargetValues':int(np.isnan(extra[test]).sum())})
        if index%10==0 or index==len(days)-1:
            print(f'V3 payoff origins {index+1}/{len(days)} · {day}',flush=True)
    generated=fp.iso(datetime.now(timezone.utc))
    windows=[{'id':'rolling','label':'共同成熟滚动窗口','startDate':days[0],'endDate':days[-1],
              'days':len(days),'rows':len(points_output)},
             {'id':'development','label':'已见 14 日开发窗口','startDate':'2026-10-15','endDate':'2026-10-28',
              'days':14,'rows':1008}]
    daily=sorted([daily_metrics(p) for p in plans],key=lambda d:(d['date'],[p['id'] for p in POLICIES].index(d['policyId'])))
    results=[];monthly=[]
    for window in windows:
        for policy in POLICIES:
            subset=[d for d in daily if d['policyId']==policy['id'] and window['startDate']<=d['date']<=window['endDate']]
            for fee in FEES:
                results.append({'windowId':window['id'],'policyId':policy['id'],'feePerMWh':fee,**aggregate(subset,fee)})
    for month in sorted({d['date'][:7] for d in daily}):
        for policy in POLICIES:
            subset=[d for d in daily if d['policyId']==policy['id'] and d['date'].startswith(month)]
            for fee in FEES:
                monthly.append({'month':month,'startDate':subset[0]['date'],'endDate':subset[-1]['date'],
                                'policyId':policy['id'],'feePerMWh':fee,**aggregate(subset,fee)})
    diagnostics=old_diagnostics()
    v2_forward=json.loads((ROOT/'public/data/forecast-lab/v2/forecast-forward.json').read_text())
    report={'schemaVersion':3,'experimentVersion':version,'generatedAt':generated,
        'classification':'developmental_decision_reconstruction','defaultPolicyId':'ridge_payoff',
        'defaultWindowId':'rolling','defaultFeePerMWh':1,'feesPerMWh':FEES,'policies':POLICIES,'windows':windows,
        'sample':{'priceStartDate':history.dates[0],'priceEndDate':history.dates[-1],'priceDays':len(history.dates),
                  'priceRows':len(history.rows),'nodes':history.nodes,'fundamentalsRows':len(fundamentals.rows),
                  'priceInputSha256':source_sha,'fundamentalsInputSha256':fundamental_sha,
                  'sourceV2ForecastDigest':v2['digest'],'priceFeatureCount':len(names),'fundamentalFeatureCount':len(fundamentals.feature_names)},
        'protocol':protocol,'results':results,'monthly':monthly,'daily':daily,'diagnostics':diagnostics,
        'fitAudit':audit,'forward':{'status':'not_generated','reason':'V3 设计与运行晚于 Oct30 PT 研究截点；Oct31 所需 Oct29 完整日价格尚不在档案。本轮不生成 V3 前向预测，也不改写 V2 已事前归档批次。',
                                  'targetDate':'2026-10-30','existingV2ModelVersion':v2_forward['modelVersion'],
                                  'existingV2ForecastDigest':v2_forward['digest']},
        'promotionGate':{'status':'research_only','approvedForTrading':False,
                         'reasons':['全部历史结果已用于开发；没有新的独立未见测试。','模拟成交及费用假设不等于完整结算和真实成交。','任何盈利候选仍需新的事前归档验证。']},
        'warnings':['V3 预测的是固定报价下每提交 MWh 的扣费收益，不能当作 FMM−DA 电价预测或获利概率。',
                    '每个目标日只用 D−2 及更早的 56 日历史样本外 V2 预测及已发生价格；基本面也只取 D−2 或更早。',
                    '基本面是本次下载的 ACTUAL 历史，可能含修订；它不是历史时点原始发布版本。',
                    '训练费用固定 $1/MWh，决策缓冲固定 $1/MWh，均为研究假设；费用切换不改变订单。',
                    '不交易参照没有风险暴露，不能被称为预测赢家。',
                    '资金限制仅为 12 MWh/日及节点/单格电量约束，不包含信用、资金和官方申报资格校验。']}
    common={'schemaVersion':3,'experimentVersion':version,'generatedAt':generated,
            'classification':'historical_decision_reconstruction','protocolDigest':protocol['designDigest'],
            'sourceForecastDigest':v2['digest'],'trainingFeePerMWh':1}
    write_json(output/'decision-points.json',{**common,'points':points_output})
    write_json(output/'decision-plans.json',{**common,'constraints':CONSTRAINTS,'plans':plans})
    write_json(output/'models.json',{**common,'fittedForHistoricalDate':days[-1],'models':models})
    write_json(output/'report.json',report)
    print(json.dumps({'version':version,'generatedAt':generated,'days':len(days),'rows':len(points_output),
                      'fee1Results':[r for r in results if r['feePerMWh']==1]},ensure_ascii=False))
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prices',type=Path,default=ROOT/'data/strategy-history-expanded.json')
    parser.add_argument('--fundamentals',type=Path,default=ROOT/'data/fundamentals-history-v3.json')
    parser.add_argument('--output',type=Path,default=OUT)
    parser.add_argument('--freeze-only',action='store_true')
    args=parser.parse_args()
    if args.freeze_only: print(json.dumps(freeze(args.output),ensure_ascii=False))
    else: run(args.prices,args.fundamentals,args.output)


if __name__=='__main__': main()
