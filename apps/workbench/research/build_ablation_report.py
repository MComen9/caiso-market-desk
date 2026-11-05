#!/usr/bin/env python3
"""Compare a fixed V2-on-56-day diagnostic with unchanged V1/V2 releases."""
import argparse
import hashlib
import json
import shutil
import statistics
from datetime import datetime, timezone
from pathlib import Path

import forecast_pipeline as fp
from optimization_pipeline import run, write_json

ROOT=Path(__file__).resolve().parents[1]


def summarize(points):
    metrics={}
    for target,actual,predicted in [('da','actualDa','predictedDa'),('spread','actualSpread','predictedSpread')]:
        m=fp.metric([p[actual] for p in points],[p[predicted] for p in points],spread=target=='spread')
        valid=[p for p in points if p.get(target+'Low80') is not None and p.get(target+'High80') is not None]
        m['interval80']={'n':len(valid),
            'coverage':sum(p[target+'Low80']<=p[actual]<=p[target+'High80'] for p in valid)/len(valid),
            'meanWidth':statistics.mean(p[target+'High80']-p[target+'Low80'] for p in valid)}
        metrics[target]=m
    metrics['calibration']={'meanSpreadSigma':statistics.mean(p['sigma'] for p in points),
                            'minResidualCount':min(p['calibrationCount'] for p in points),
                            'maxResidualCount':max(p['calibrationCount'] for p in points)}
    return metrics


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ablation-dir',type=Path,default=ROOT/'.sites-runtime/ablation-v2-56d')
    parser.add_argument('--run',action='store_true',help='Recompute the fixed 56-day diagnostic before comparing; never publishes its forward output')
    args=parser.parse_args()
    public=ROOT/'public/data/forecast-lab'
    if args.run:
        args.ablation_dir.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(public/'v2/protocol.json',args.ablation_dir/'protocol.json')
        run(ROOT/'data/strategy-history.json',args.ablation_dir,'2026-10-30')
    locations={'v1_56':public,'v2_56':args.ablation_dir,'v2_180':public/'v2'}
    reports={name:json.loads((p/'report.json').read_text()) for name,p in locations.items()}
    protocol=json.loads((public/'v2/protocol.json').read_text())
    diagnostic_protocol=json.loads((args.ablation_dir/'protocol.json').read_text())
    assert protocol==diagnostic_protocol,'Fixed algorithm protocol differs'
    points={}
    for name,p in locations.items():
        filename='forecast-history.json' if name=='v1_56' else 'all-walk-forward.json'
        bundle=json.loads((p/filename).read_text())
        points[name]={(r['node'],r['startUtc']):r for r in bundle['points'] if '2026-10-15'<=r['localDate']<='2026-10-28'}
    keys=sorted(points['v1_56'])
    assert len(keys)==1008
    assert all(set(p)==set(keys) for p in points.values())
    for key in keys:
        for name in ('v2_56','v2_180'):
            assert points[name][key]['actualDa']==points['v1_56'][key]['actualDa']
            assert points[name][key]['actualSpread']==points['v1_56'][key]['actualSpread']
    metrics={name:summarize([values[k] for k in keys]) for name,values in points.items()}
    cold={}
    for name in ('v2_56','v2_180'):
        audit=[a for a in reports[name]['method']['fitAudit'] if '2026-10-15'<=a['targetDate']<='2026-10-28']
        cold[name]={'rollingPredictionStart':reports[name]['method']['fitAudit'][0]['targetDate'],
                    'comparisonDays':[{'date':a['targetDate'],'selectorDays':a['selector']['da']['days'],
                                       'ridgeTrainingRows':a['ridgeTrainingRows']} for a in audit]}
    fields=('predictedDa','predictedSpread','daLow80','daHigh80','spreadLow80','spreadHigh80','sigma','calibrationCount')
    result={'schemaVersion':1,'generatedAt':fp.iso(datetime.now(timezone.utc)),
        'classification':'post_result_development_ablation','protocolDigest':protocol['designDigest'],
        'algorithmProtocolFrozenAt':protocol['frozenAt'],
        'ablationExecutedAt':reports['v2_56']['generatedAt'],
        'requestedAfterMainResults':True,'forwardPublished':False,'mainModelChanged':False,
        'comparisonWindow':{'startDate':'2026-10-15','endDate':'2026-10-28','days':14,'rows':len(keys)},
        'versions':{n:{'modelVersion':r['modelVersion'],'sample':r['sample']} for n,r in reports.items()},
        'metrics':metrics,
        'changes':{
            'methodAtFixed56Days':{t:{'maeChange':metrics['v2_56'][t]['mae']-metrics['v1_56'][t]['mae'],
                                       'improvementPct':100*(metrics['v1_56'][t]['mae']-metrics['v2_56'][t]['mae'])/metrics['v1_56'][t]['mae']} for t in ('da','spread')},
            'historyAtFixedV2Method':{t:{'maeChange':metrics['v2_180'][t]['mae']-metrics['v2_56'][t]['mae'],
                                          'improvementPct':100*(metrics['v2_56'][t]['mae']-metrics['v2_180'][t]['mae'])/metrics['v2_56'][t]['mae']} for t in ('da','spread')}},
        'coldStart':cold,
        'conclusions':[
            '在已见14日窗口，固定56日数据后V2方法已明显改善DA，并小幅改善价差。',
            '固定V2方法后扩至180日，在这14日没有额外MAE收益：DA与价差均略差；没有据此替换已冻结主模型。',
            '扩历史带来更长时间跨度评价和完整的滚动误差/训练窗，不能保证近期窗口精度单调提升。',
            '区间覆盖改善伴随宽度扩大，不能只依据覆盖率认为概率已校准。',
            '比较包含冷启动长度、历史可用Ridge训练行数和滚动残差差异；不是只改变单个模型参数的独立实验。',
            '该消融在看到主结果后提出，所有数据均属于开发诊断；不能重新称为独立测试。'],
        'hourlyComparison':[{'node':k[0],'startUtc':k[1],'actualDa':points['v1_56'][k]['actualDa'],
                              'actualSpread':points['v1_56'][k]['actualSpread'],
                              **{name:{f:points[name][k][f] for f in fields} for name in points}} for k in keys]}
    write_json(public/'v2/ablation.json',result)
    print(json.dumps({'output':str(public/'v2/ablation.json'),'changes':result['changes'],'metrics':metrics},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
