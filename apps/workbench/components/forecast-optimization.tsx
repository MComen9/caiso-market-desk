'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, CalendarDays, Info, ShieldCheck } from 'lucide-react';
import type { ForecastAblation, ForecastExperiment, ForecastSimulation, StrategyOptimizationComparison } from '@/lib/forecast-lab-types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const num = (n: number | null | undefined, d = 2) => finite(n) ? n.toLocaleString('en-US', {minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const change = (prior: number, current: number) => prior > 0 ? (prior-current)/prior*100 : null;

export default function OptimizationReview({report, simulation, root}: {report: ForecastExperiment; simulation: ForecastSimulation | null; root: string}) {
  const [strategy, setStrategy] = useState<StrategyOptimizationComparison | null>(null);
  const [strategyError, setStrategyError] = useState('');
  const [fee, setFee] = useState(1);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [ablation, setAblation] = useState<ForecastAblation | null>(null);
  const [ablationError, setAblationError] = useState('');
  const [ablationLoading, setAblationLoading] = useState(false);
  useEffect(() => {
    if (!diagnosticsOpen || ablation || ablationError) return;
    const controller = new AbortController(); setAblationLoading(true);
    fetch(`${root}ablation.json`, {cache:'no-store',credentials:'same-origin',signal:controller.signal})
      .then(async response => {if (!response.ok) throw new Error('消融诊断暂未读取成功，其他模型结果仍可查看。'); return response.json() as Promise<ForecastAblation>;})
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.classification!=='post_result_development_ablation' || data.versions?.v2_180?.modelVersion!==report.modelVersion || !data.metrics?.v1_56 || !data.metrics?.v2_56 || !data.metrics?.v2_180 || data.mainModelChanged || !data.requestedAfterMainResults) throw new Error('消融诊断与当前版本或声明不一致，暂不展示。');
        if (data.comparisonWindow.startDate!==report.optimization?.comparisonWindow.startDate || data.comparisonWindow.endDate!==report.optimization?.comparisonWindow.endDate) throw new Error('消融诊断与主报告的比较窗口不同，暂不合并展示。');
        // Keep the compact summary in React state; the downloadable file also
        // contains the much larger hourly comparison used for independent replay.
        setAblation({classification:data.classification,generatedAt:data.generatedAt,requestedAfterMainResults:data.requestedAfterMainResults,mainModelChanged:data.mainModelChanged,comparisonWindow:data.comparisonWindow,versions:data.versions,metrics:data.metrics,changes:data.changes});
      })
      .catch(error => {if(error.name!=='AbortError') setAblationError(error.message);})
      .finally(()=>{if(!controller.signal.aborted)setAblationLoading(false);});
    return ()=>controller.abort();
  },[diagnosticsOpen,ablation,ablationError,root,report.modelVersion,report.optimization?.comparisonWindow.startDate,report.optimization?.comparisonWindow.endDate]);
  useEffect(() => {
    const controller = new AbortController();
    setStrategy(null); setStrategyError('');
    fetch(`${root}strategy-comparison.json`, {cache:'no-store',credentials:'same-origin',signal:controller.signal})
      .then(async response => {if(!response.ok) throw new Error('策略门槛对比尚未发布，可先查看下方已完成的模型结果。'); return response.json() as Promise<StrategyOptimizationComparison>;})
      .then(data => {if(!data.rows?.length || data.rows.some(row => row.model==='v2' && row.modelVersion!==report.modelVersion)) throw new Error('策略比较与当前模型版本不一致，暂不展示。'); setStrategy(data);})
      .catch(error => {if(error.name!=='AbortError') setStrategyError(error.message);});
    return ()=>controller.abort();
  },[root,report.modelVersion]);
  const optimization = report.optimization;
  if (!optimization) return <div className="fl-notice warning"><Info size={17}/><span>当前版本未提供优化对比报告；请刷新或切换至初始实验。</span></div>;
  const {comparison,comparisonWindow,prospective} = optimization;
  const profiles = [...new Set(strategy?.rows.map(row=>row.profileId) || [])];
  const defaultV1 = strategy?.rows.find(row=>row.model==='v1' && row.strategy==='normal' && row.k===0.5 && row.feePerMWh===1);
  const defaultV2 = strategy?.rows.find(row=>row.model==='v2' && row.strategy==='normal' && row.k===0.5 && row.feePerMWh===1);
  return <div className="fl-optimization">
    {finite(defaultV1?.netPnl) && finite(defaultV2?.netPnl) && <div className={`fl-notice ${defaultV2.netPnl < defaultV1.netPnl ? 'warning' : ''}`}><Info size={17}/><span><strong>{defaultV2.netPnl < defaultV1.netPnl ? '误差改善尚未转化为更好的默认策略结果。' : '默认策略结果仍需与误差和交易量一起评价。'}</strong> 同窗、normal、k=0.5、$1/MWh 费用下，V1 净损益 ${num(defaultV1.netPnl)}，V2 ${num(defaultV2.netPnl)}。这是固定参数的开发模拟，不据此选择获利最高的门槛。</span></div>}

    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>同一时段，比较两轮误差</h2><p>{comparisonWindow.startDate} — {comparisonWindow.endDate} PT · {comparisonWindow.days} 天 · 这是已查看过的开发窗口</p></div><a className="fl-text-link" href={`${root}report.json`} download>完整优化报告<ArrowDownToLine size={14}/></a></div>
      <div className="fl-table-scroll"><table className="fl-table fl-comparison-table"><thead><tr><th>预测目标</th><th>V1 初始实验 MAE</th><th>V2 第二轮 MAE</th><th>简单基线 MAE</th><th>相对 V1</th></tr></thead><tbody>{([{id:'da',label:'日前价格 DA'},{id:'spread',label:'小时价差 FMM−DA'}] as const).map(target=>{const delta=change(comparison.v1[target.id].mae,comparison.v2[target.id].mae);return <tr key={target.id}><td><strong>{target.label}</strong></td><td>{num(comparison.v1[target.id].mae,4)}</td><td><strong>{num(comparison.v2[target.id].mae,4)}</strong></td><td>{num(comparison.baseline[target.id].mae,4)}</td><td className={delta!==null&&delta<0?'fl-negative':'fl-positive'}>{delta===null?'—':`${delta>=0?'下降':'上升'} ${num(Math.abs(delta),1)}%`}</td></tr>;})}</tbody></table></div>
      <p className="fl-explanation">MAE 单位为 $/MWh，越低越好。两版按相同节点和 UTC 时段比较；V2 使用 {report.sample.days} 天可用历史及新的因果选型规则。此处改善是开发结果，不是重新获得的独立测试成绩。MAE 保留四位小数，避免微小差异被四舍五入掩盖。</p>
    </section>
    <section className="fl-prospective"><ShieldCheck size={22}/><div><h2>下一步验证已经与开发样本分开</h2><p><CalendarDays size={14}/>{prospective.startDate} — {prospective.endDate} PT · 计划观察 {prospective.days} 天</p><span>前向效果待实际价格到齐。当前只保存真实生成的批次；上述观察期不代表未来每天的预测已生成或已安排自动运行。</span></div><span className="fl-badge muted">待前向验证</span></section>
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>跨时段滚动检查</h2><p>{optimization.evaluationLabel}。每日只允许使用 D−2 及更早的数据与预测误差，检查是否仅在少数日期改善。</p></div><span className="fl-badge">{optimization.blocks.length} 个评价区间</span></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>区间 · PT</th><th>天数</th><th>V2 DA MAE</th><th>基线 DA MAE</th><th>V2 价差 MAE</th><th>基线价差 MAE</th></tr></thead><tbody>{optimization.blocks.map((block,i)=><tr key={`${block.startDate}-${i}`}><td><strong>{block.startDate}</strong><small>至 {block.endDate}</small></td><td>{block.days}</td><td>{num(block.v2.da.mae)}</td><td>{num(block.baseline.da.mae)}</td><td>{num(block.v2.spread.mae)}</td><td>{num(block.baseline.spread.mae)}</td></tr>)}</tbody></table></div><p className="fl-explanation">{report.method.selectionRule}</p></section>
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>固定策略门槛的敏感性</h2><p>同一个已见开发窗口，三种预先设定门槛并列比较；没有根据收益自动选择获利最高的一行。</p></div><div className="fl-segment" role="group" aria-label="策略比较费用假设"><button aria-pressed={fee===1} className={fee===1?'active':''} onClick={()=>setFee(1)}>$1/MWh</button><button aria-pressed={fee===0} className={fee===0?'active':''} onClick={()=>setFee(0)}>零费用</button></div></div>
      {strategy ? <div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>固定门槛</th><th>V1 净损益 $</th><th>V2 净损益 $</th><th>V2 最大回撤 $</th><th>V2 成交 MWh</th><th>V2 无信号日</th></tr></thead><tbody>{profiles.map(id=>{const previous=strategy.rows.find(row=>row.profileId===id&&row.model==='v1'&&row.feePerMWh===fee);const current=strategy.rows.find(row=>row.profileId===id&&row.model==='v2'&&row.feePerMWh===fee);return <tr key={id}><td><strong>{current?.label || previous?.label || id}</strong><small>{current?.strategy || previous?.strategy} · k={num(current?.k ?? previous?.k,1)}</small></td><td className={finite(previous?.netPnl)&&previous.netPnl<0?'fl-negative':''}>{num(previous?.netPnl)}</td><td className={finite(current?.netPnl)&&current.netPnl<0?'fl-negative':''}>{num(current?.netPnl)}</td><td>{num(current?.maxDrawdown)}</td><td>{num(current?.filledMWh)}</td><td>{current?.noSignalDays ?? '—'} / {current?.days ?? '—'}</td></tr>;})}</tbody></table></div> : <p className="fl-explanation">{strategyError || '正在读取固定策略比较…'}</p>}
      <p className="fl-explanation">少交易或不交易可以减少模拟亏损，不等于已证明预测有盈利能力。费用仅为敏感性假设；成交、信用资金、分摊及完整结算成本未全部建模。默认一键模拟仍使用 normal、k=0.5。</p>
      {strategy && <div className="fl-panel-footer"><a className="fl-text-link" href={`${root}strategy-comparison.json`} download>下载全部门槛与费用结果<ArrowDownToLine size={14}/></a></div>}
    </section>
    {simulation && <div className="fl-notice"><Info size={17}/><span>当前默认策略已完成 Python 复算：开发窗口零费用净损益 <strong>${num(simulation.holdout.total)}</strong>；$1/MWh 费用下 <strong>${num(simulation.feeSensitivity1PerMWh.total)}</strong>。<a className="fl-text-link" href={`${root}holdout-simulation.json`} download>查看逐笔结果<ArrowDownToLine size={13}/></a></span></div>}
    <details className="fl-panel fl-diagnostic-details" onToggle={event=>setDiagnosticsOpen(event.currentTarget.open)}><summary>误差诊断 · 方法、数据量与失效时段<span>展开查看</span></summary>
      <div className="fl-panel-heading"><div><h2>方法与数据量消融</h2><p>固定同一旧 14 日开发窗口，分开观察方法变化与历史扩展的贡献。</p></div><a className="fl-text-link" href={`${root}ablation.json`} download>消融指标与逐小时对照<ArrowDownToLine size={14}/></a></div>
      {ablation ? <><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>实验条件</th><th>输入历史</th><th>DA MAE</th><th>价差 MAE</th><th>说明</th></tr></thead><tbody>{([{id:'v1_56',label:'V1 · 初始方法',note:'原始参照'},{id:'v2_56',label:'V2 · 同数据消融',note:'仅用于结果后诊断'},{id:'v2_180',label:'V2 · 当前主版本',note:'主版本保持不变'}] as const).map(item=><tr key={item.id}><td><strong>{item.label}</strong></td><td>{ablation.versions[item.id].sample.days} 天</td><td>{num(ablation.metrics[item.id].da.mae,4)}</td><td>{num(ablation.metrics[item.id].spread.mae,4)}</td><td>{item.note}</td></tr>)}</tbody></table></div>
        <p className="fl-explanation">{ablation.comparisonWindow.startDate} — {ablation.comparisonWindow.endDate} PT，三行均为同一批 {ablation.comparisonWindow.rows.toLocaleString()} 个节点小时。固定 56 日数据，方法变化使 DA / 价差 MAE 分别下降 {num(ablation.changes.methodAtFixed56Days.da.improvementPct,2)}% / {num(ablation.changes.methodAtFixed56Days.spread.improvementPct,2)}%；固定 V2 方法再扩至 180 日，MAE 分别{ablation.changes.historyAtFixedV2Method.da.maeChange>=0?'增加':'降低'} {num(Math.abs(ablation.changes.historyAtFixedV2Method.da.maeChange),4)} / {num(Math.abs(ablation.changes.historyAtFixedV2Method.spread.maeChange),4)} $/MWh。</p>
        <p className="fl-explanation"><strong>该窗口的主要精度改善来自方法变化，扩展历史未额外提高 MAE 表现。</strong> “方法变化”包含候选、选型机制、训练窗口及组合规则，不能归功于其中单项。扩展历史的价值体现在更完整的训练与误差校准，以及跨更多月份检查稳定性。这是主结果生成后的诊断，保留冷启动差异；没有切换主模型或据此挑选盈利参数，仍需新的前向验证。</p></> : <p className="fl-explanation">{ablationError || (ablationLoading ? '正在读取消融诊断…' : '展开后读取消融诊断。')}{ablationError && <button className="fl-button" onClick={()=>setAblationError('')}>重新读取</button>}</p>}
<div className="fl-panel-heading"><div><h2>按小时定位误差</h2><p>{optimization.rollingWindow && <>{optimization.rollingWindow.startDate} — {optimization.rollingWindow.endDate} PT · </>}各枢纽聚合的当地小时误差，用于发现失效时段。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>小时起点 PT</th><th>DA MAE</th><th>DA 偏差</th><th>价差 MAE</th><th>价差偏差</th><th>小时节点样本</th></tr></thead><tbody>{optimization.diagnostics.byHour.map(row=><tr key={row.hour}><td>{String(row.hour).includes(':')?row.hour:`${String(row.hour).padStart(2,'0')}:00`}</td><td>{num(row.da.mae)}</td><td>{num(row.da.bias)}</td><td>{num(row.spread.mae)}</td><td>{num(row.spread.bias)}</td><td>{row.spread.n}</td></tr>)}</tbody></table></div><div className="fl-panel-heading"><div><h2>价差误差最大的日期</h2><p>仅用于定位失效，不删除这些日期，也不据此重算独立测试成绩。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>交易日期 PT</th><th>DA MAE</th><th>价差 MAE</th></tr></thead><tbody>{optimization.diagnostics.worstDays.map(row=><tr key={row.date}><td>{row.date}</td><td>{num(row.daMae ?? row.da?.mae)}</td><td>{num(row.spreadMae ?? row.spread?.mae)}</td></tr>)}</tbody></table></div></details>
    <details className="fl-panel fl-diagnostic-details"><summary>候选方法 · {report.candidates.length} 组实际运行<span>展开查看</span></summary><div className="fl-panel-heading"><div><h2>候选方法公开比较</h2><p>下面的共同开发窗口指标用于诊断。每日组合权重只根据当日之前可用的滚动误差计算。</p></div><span className="fl-badge">{report.candidates.length} 组候选</span></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>候选方法</th><th>DA MAE</th><th>价差 MAE</th><th>DA RMSE</th><th>价差 RMSE</th></tr></thead><tbody>{report.candidates.map(candidate=><tr key={candidate.id}><td><strong>{candidate.label}</strong><small>{candidate.family}</small></td><td>{num(candidate.holdout.da.mae)}</td><td>{num(candidate.holdout.spread.mae)}</td><td>{num(candidate.holdout.da.rmse)}</td><td>{num(candidate.holdout.spread.rmse)}</td></tr>)}</tbody></table></div></details>
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>数据与特征可用性</h2><p>{report.sample.startDate} — {report.sample.endDate} PT · {report.sample.rows.toLocaleString()} 条完整小时记录</p></div><a className="fl-text-link" href={`${root}data-audit.json`} download>扩展数据审查<ArrowDownToLine size={14}/></a></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>来源</th><th>用途</th><th>判断依据</th></tr></thead><tbody>{report.featureAudit.map((item,i)=><tr key={i}><td>{item.source}</td><td><span className={`fl-badge ${item.status==='included'?'':'muted'}`}>{item.status==='included'?'进入模型':'暂未入模'}</span></td><td className="fl-wrap">{item.reason}</td></tr>)}</tbody></table></div><p className="fl-explanation">{optimization.limitations.join(' ')}</p></section>
  </div>;
}
