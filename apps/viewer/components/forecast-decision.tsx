'use client';

import { publicUrl } from '@/lib/public-url';

import {useEffect, useMemo, useState} from 'react';
import {ArrowDownToLine, ArrowRight, BarChart3, Clock3, Code2, Database, FileJson, Info, LoaderCircle, RefreshCw, ShieldCheck} from 'lucide-react';
import {HUBS} from '@/lib/types';
import type {DecisionDaily, DecisionDiagnosticGroup, DecisionReport, DecisionWindow} from '@/lib/forecast-decision-types';

const ROOT = publicUrl('/data/forecast-lab/v3/');
const ORDER = ['no_trade','v2_original','ridge_payoff','hist_payoff_price','hist_payoff_fundamentals'];
const finite = (n: unknown): n is number => typeof n==='number' && Number.isFinite(n);
const num = (n: number | null | undefined, digits=2) => finite(n) ? n.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const signed = (n: number | null | undefined, digits=2) => finite(n) ? `${n>0?'+':''}${num(n,digits)}` : '—';
const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)) : '—';
const nodeLabel = (value: string) => HUBS.find(h=>h.id===value)?.short || value;
const tone = (value: number | null | undefined) => finite(value) && value<0 ? 'fl-negative' : '';
const factorLabel = (factor: string) => (({da:'日前价格预测',predictedDa:'日前价格预测',spread:'价差预测',predictedSpread:'价差预测',sigma:'误差波动 σ'} as Record<string,string>)[factor] || factor);
type View = 'diagnosis'|'comparison'|'evidence';

function validReport(data: DecisionReport) {
  return data.schemaVersion===3 && data.classification==='developmental_decision_reconstruction' &&
    data.promotionGate?.approvedForTrading===false && data.forward?.status==='not_generated' &&
    Array.isArray(data.policies) && ORDER.every(id=>data.policies.some(p=>p.id===id)) &&
    Array.isArray(data.windows) && data.windows.some(w=>w.id===data.defaultWindowId) &&
    data.policies.some(p=>p.id===data.defaultPolicyId) && Array.isArray(data.results) &&
    Array.isArray(data.daily) && Array.isArray(data.monthly) &&
    data.feesPerMWh?.includes(data.defaultFeePerMWh) && data.diagnostics?.v1v2?.summary &&
    Array.isArray(data.diagnostics?.inputAttribution?.shapley) && Array.isArray(data.diagnostics?.inputAttribution?.hybrids) &&
    finite(data.sample?.priceRows) && finite(data.sample?.priceDays) && Array.isArray(data.sample?.nodes) &&
    Array.isArray(data.warnings) && Array.isArray(data.promotionGate?.reasons) &&
    Number.isFinite(Date.parse(data.protocol?.frozenAt)) && Number.isFinite(Date.parse(data.generatedAt));
}

function GroupTable({rows, label}: {rows: DecisionDiagnosticGroup[]; label: string}) {
  return <div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>{label}</th><th>V1 净损益 $</th><th>V2 净损益 $</th><th>变化 $</th><th>V1 / V2 成交 MWh</th><th>V1 / V2 笔数</th></tr></thead><tbody>{rows.map(row=><tr key={row.group}><td><strong>{nodeLabel(row.group)}</strong></td><td className={tone(row.v1.netPnl)}>{num(row.v1.netPnl)}</td><td className={tone(row.v2.netPnl)}>{num(row.v2.netPnl)}</td><td className={tone(finite(row.v1.netPnl)&&finite(row.v2.netPnl)?row.v2.netPnl-row.v1.netPnl:null)}>{signed(finite(row.v1.netPnl)&&finite(row.v2.netPnl)?row.v2.netPnl-row.v1.netPnl:null)}</td><td>{num(row.v1.filledMWh,1)} / {num(row.v2.filledMWh,1)}</td><td>{row.v1.trades} / {row.v2.trades}</td></tr>)}</tbody></table></div>;
}

function CumulativeCurve({daily, window, policyId, policyLabel, fee}: {daily: DecisionDaily[]; window: DecisionWindow; policyId: string; policyLabel: string; fee: number}) {
  const [hover,setHover] = useState<number|null>(null);
  const {dates,series} = useMemo(()=>{
    const rows=daily.filter(r=>r.date>=window.startDate&&r.date<=window.endDate);
    const dates=[...new Set(rows.map(r=>r.date))].sort();
    const ids=policyId==='v2_original'?['v2_original']:[policyId,'v2_original'];
    const series=ids.map(id=>{let cumulative=0; const index=new Map(rows.filter(r=>r.policyId===id).map(r=>[r.date,r]));return {id,label:id==='v2_original'?'V2 原固定策略':policyLabel,values:dates.map(date=>{const value=index.get(date)?.netPnlByFee[String(fee)];if(!finite(value))return null;cumulative+=value;return cumulative;})};});
    return {dates,series};
  },[daily,window.startDate,window.endDate,policyId,policyLabel,fee]);
  useEffect(()=>setHover(null),[policyId,fee,window.id]);
  if(!dates.length) return <p className="fl-explanation">当前窗口尚无可绘制的逐日结果。</p>;
  const values=series.flatMap(s=>s.values).filter(finite);
  if(!values.length) return <p className="fl-explanation">当前费用口径的逐日损益未完成，暂不连线。</p>;
  const W=960,H=270,L=75,R=25,T=28,B=38;
  const low=Math.min(0,...values), high=Math.max(0,...values), pad=Math.max((high-low)*.12,1), lo=low-pad,hi=high+pad;
  const x=(i:number)=>L+(dates.length===1?.5:i/(dates.length-1))*(W-L-R);
  const y=(v:number)=>T+(hi-v)/(hi-lo)*(H-T-B);
  const colors=['#337c59','#a98b57'];
  const selected=hover===null?null:Math.min(hover,dates.length-1);
  const ticks=[...new Set(Array.from({length:Math.min(6,dates.length)},(_,i)=>Math.round(i*(dates.length-1)/Math.max(Math.min(6,dates.length)-1,1))))];
  return <div className="fl-curve fd-cumulative" tabIndex={0} aria-label="累计模拟净损益。左右方向键查看日期。" onKeyDown={event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();setHover(v=>event.key==='ArrowRight'?Math.min((v??-1)+1,dates.length-1):Math.max((v??1)-1,0));}}}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${policyLabel}与V2的累计模拟净损益，费用每MWh ${fee} 美元`} onMouseMove={event=>{const rect=event.currentTarget.getBoundingClientRect();setHover(Math.max(0,Math.min(dates.length-1,Math.round(((event.clientX-rect.left)/rect.width*W-L)/(W-L-R)*(dates.length-1)))));}} onMouseLeave={()=>setHover(null)}>
      <text x={L} y="14" className="fl-axis">累计美元损益 · 窗口起点归零</text>
      {[0,1,2,3,4].map(i=>{const v=lo+(hi-lo)*i/4;return <g key={i}><line x1={L} x2={W-R} y1={y(v)} y2={y(v)} stroke="#e7ede9" strokeDasharray="3 5"/><text x={L-11} y={y(v)+4} textAnchor="end" className="fl-axis">{num(v,0)}</text></g>;})}
      <line x1={L} x2={W-R} y1={y(0)} y2={y(0)} stroke="#9cafaa"/>
      {ticks.map(i=><text key={i} x={x(i)} y={H-12} textAnchor="middle" className="fl-axis">{dates[i].slice(5)}</text>)}
      {series.map((s,i)=>{let open=false;const path=s.values.map((value,k)=>{if(!finite(value)){open=false;return '';}const command=`${open?'L':'M'}${x(k)},${y(value)} `;open=true;return command;}).join('');return <path key={s.id} d={path} fill="none" stroke={colors[i]} strokeWidth="2.5" strokeLinejoin="round"/>;})}
      {selected!==null&&<line x1={x(selected)} x2={x(selected)} y1={T} y2={H-B} stroke="#83988a" strokeDasharray="3 3"/>}
    </svg>
    <div className="fl-chart-caption">{selected!==null&&<strong>{dates[selected]} PT</strong>}{series.map((s,i)=><span key={s.id}><i className="fd-legend" style={{background:colors[i]}}/>{s.label}{selected!==null?` $${signed(s.values[selected])}`:''}</span>)}<span>{selected===null?'悬停或使用左右方向键查看':''}</span></div>
  </div>;
}

export default function DecisionResearch({onViewArchived}: {onViewArchived:()=>void}) {
  const [report,setReport]=useState<DecisionReport|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [view,setView]=useState<View>('diagnosis');
  const [windowId,setWindowId]=useState('rolling');
  const [policyId,setPolicyId]=useState('ridge_payoff');
  const [fee,setFee]=useState(1);
  const [breakdown,setBreakdown]=useState<'byNode'|'bySide'|'byHour'|'byDay'>('byNode');
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    fetch(`${ROOT}report.json`,{cache:'no-store',credentials:'same-origin',signal:controller.signal})
      .then(async response=>{if(!response.ok)throw new Error(`决策研究暂时无法读取（HTTP ${response.status}）。`);return response.json() as Promise<DecisionReport>;})
      .then(data=>{if(!validReport(data))throw new Error('决策报告的版本或研究边界不一致，暂不展示。');setReport(data);setWindowId(data.defaultWindowId);setPolicyId(data.defaultPolicyId);setFee(data.defaultFeePerMWh);})
      .catch(err=>{if(err.name!=='AbortError')setError(err instanceof Error?err.message:'决策研究读取失败。');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[refresh]);
  if(!report) return <div className="fl-loading"><>{loading?<LoaderCircle size={24} className="fl-spin"/>:<Info size={26}/>}</><strong>{error||'正在读取已完成的决策研究…'}</strong><span>策略结果、亏损诊断与冻结协议一并载入。</span>{!loading&&<button className="fl-button" onClick={()=>setRefresh(v=>v+1)}>重新读取</button>}<button className="fl-button" onClick={onViewArchived}>查看已归档 V2 预测<ArrowRight size={14}/></button></div>;
  const policies=ORDER.map(id=>report.policies.find(p=>p.id===id)!).filter(Boolean);
  const window=report.windows.find(w=>w.id===windowId)||report.windows[0];
  const policy=policies.find(p=>p.id===policyId)||policies[2];
  const result=report.results.find(r=>r.windowId===window.id&&r.policyId===policy.id&&r.feePerMWh===fee);
  const baseline=report.results.find(r=>r.windowId===window.id&&r.policyId==='v2_original'&&r.feePerMWh===fee);
  const diagnostic=report.diagnostics.v1v2;
  const attribution=report.diagnostics.inputAttribution;
  const fixed=(selectedWindow:string,selectedPolicy:string)=>report.results.find(r=>r.windowId===selectedWindow&&r.policyId===selectedPolicy&&r.feePerMWh===1);
  const ridgeLong=fixed('rolling','ridge_payoff'),v2Long=fixed('rolling','v2_original');
  const ridgeRecent=fixed('development','ridge_payoff'),v2Recent=fixed('development','v2_original');
  const priceTree=fixed('rolling','hist_payoff_price'),fundamentalTree=fixed('rolling','hist_payoff_fundamentals');
  const rollingDays=report.windows.find(w=>w.id==='rolling')?.days;
  const candidateIds=ORDER.slice(2);
  const recentReferencePnl=v2Recent?.netPnl;
  const recentCandidatesWorse=finite(recentReferencePnl)&&candidateIds.every(id=>{const row=fixed('development',id);return finite(row?.netPnl)&&row.netPnl<recentReferencePnl;});
  const highCostLoss=report.results.filter(r=>r.windowId==='rolling'&&r.feePerMWh===5&&candidateIds.includes(r.policyId));
  const allHighCostLoss=highCostLoss.length===candidateIds.length&&highCostLoss.every(r=>finite(r.netPnl)&&r.netPnl<0);
  const ridgeFee2=report.results.find(r=>r.windowId==='rolling'&&r.policyId==='ridge_payoff'&&r.feePerMWh===2);
  const priceTreeFee2=report.results.find(r=>r.windowId==='rolling'&&r.policyId==='hist_payoff_price'&&r.feePerMWh===2);
  const first=diagnostic.summary.v1,last=diagnostic.summary.v2;
  const pnlDelta=finite(first.netPnl)&&finite(last.netPnl)?last.netPnl-first.netPnl:null;
  const bars=attribution.shapley||[];
  const barScale=Math.max(1,...bars.map(r=>Math.abs(r.contribution)));
  const months=[...new Set(report.monthly.map(r=>r.month))].sort();
  const tabs:Array<{id:View;label:string;icon:typeof Info}>=[{id:'diagnosis',label:'决策诊断',icon:ShieldCheck},{id:'comparison',label:'对比与稳定性',icon:BarChart3},{id:'evidence',label:'证据与复现',icon:Code2}];
  return <section className="forecast-lab fd-lab" aria-label="策略决策研究">
    <header className="fl-heading"><div><span className="fl-eyebrow">DIAGNOSE · DECIDE · VERIFY</span><h1>策略决策研究 <span>第三轮实验</span></h1><p>定位预测到收益之间的损失，再检查直接收益建模能否改善决策。</p></div><button className="fl-button secondary" onClick={()=>setRefresh(v=>v+1)} disabled={loading}>{loading?<LoaderCircle size={15} className="fl-spin"/>:<RefreshCw size={15}/>}刷新结果</button></header>
    <div className="fl-context"><span><Database size={14}/>{report.sample.priceDays} 天 · {report.sample.nodes.length} 枢纽 · {report.sample.priceRows.toLocaleString()} 价格记录</span><span><Clock3 size={14}/>{dateLabel(report.generatedAt)} 北京时间生成</span><code>{report.experimentVersion}</code></div>
    <div className="fd-forward-reference"><div><ShieldCheck size={20}/><span><strong>V3 只包含历史开发研究</strong><small>本轮在 {report.forward.targetDate} PT 的研究截点后开始；未发布该日的新事前预测。</small></span></div><button className="fl-button secondary" onClick={onViewArchived}>查看已归档 V2 预测<ArrowRight size={15}/></button></div>
    <div className="fl-notice warning"><Info size={17}/><span><strong>数据补全发现了新的执行缺口。</strong> 研究枢纽与可申报节点仍有 48 条峰谷日历冲突，完整结算与实际执行费用也未齐全。本页保留原实验口径；新增数据及核验结果见 <a className="fl-text-link" href="#sources">数据中心 → 缺失数据与补齐进度</a>。</span></div>
    <nav className="fl-tabs" aria-label="决策研究视图">{tabs.map(tab=><button key={tab.id} className={view===tab.id?'active':''} aria-current={view===tab.id?'page':undefined} onClick={()=>setView(tab.id)}><tab.icon size={16}/>{tab.label}</button>)}</nav>
    {error&&<div className="fl-notice warning" role="alert"><Info size={17}/><span>{error} 下方保留上一次成功读取的报告。</span></div>}
    <div className="fl-notice warning"><Info size={17}/><span><strong>长窗口与近期窗口需要一起看。</strong> 固定 $1/MWh 费用下，Ridge 在共同 {rollingDays} 日净损益 ${signed(ridgeLong?.netPnl)}，V2 为 ${signed(v2Long?.netPnl)}；旧 14 日 Ridge 为 ${signed(ridgeRecent?.netPnl)}，V2 为 ${signed(v2Recent?.netPnl)}。{recentCandidatesWorse&&<strong>旧 14 日三个新候选均比 V2 更差。</strong>}{finite(priceTree?.netPnl)&&finite(fundamentalTree?.netPnl)&&fundamentalTree.netPnl<priceTree.netPnl&&<>同一长窗口中，价格提升树 ${signed(priceTree.netPnl)}，加入基本面后 ${signed(fundamentalTree.netPnl)}，本次固定模型没有获得基本面增益。</>}这些都是已见历史的开发结果，尚未证明未来交易优势。</span></div>
    {view==='diagnosis'&&<>
      <div className="fd-section-context"><h2>上一轮的损益变化</h2><p>{diagnostic.window.startDate} — {diagnostic.window.endDate} PT · 固定 ${diagnostic.feePerMWh}/MWh 费用与原交易规则。以下诊断解释 V1 → V2 的变化。</p></div>
      <div className="fl-metrics"><article><span>V1 固定策略净损益</span><strong className={tone(first.netPnl)}>${signed(first.netPnl)}</strong><small>原价格预测、价差与 σ</small></article><article><span>V2 固定策略净损益</span><strong className={tone(last.netPnl)}>${signed(last.netPnl)}</strong><small>策略参数和价格实际值相同</small></article><article><span>净损益变化 · V2−V1</span><strong className={tone(pnlDelta)}>${signed(pnlDelta)}</strong><small>费用口径与评价窗口一致</small></article><article><span>模拟成交电量 · V1 → V2</span><strong>{num(first.filledMWh,1)} → {num(last.filledMWh,1)}</strong><small>MWh · 暴露变化与价格误差分别观察</small></article></div>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>把输入变化与损益变化对应起来</h2><p>分别替换 DA、价差和 σ，保留全部组合；下方为各替换顺序平均后的贡献。</p></div><a className="fl-text-link" href={`${ROOT}report.json`} download>下载完整诊断<ArrowDownToLine size={14}/></a></div><div className="fd-attribution">{bars.map(row=><div className="fd-attribution-row" key={row.factor}><span>{factorLabel(row.factor)}</span><div className="fd-attribution-track"><i className={row.contribution<0?'negative':'positive'} style={{width:`${Math.abs(row.contribution)/barScale*100}%`}}/></div><strong className={tone(row.contribution)}>${signed(row.contribution)}</strong></div>)}</div><p className="fl-explanation">{attribution.note || '这是固定实际价格和策略规则下的输入替换诊断，不代表市场原因的因果识别。'} 贡献合计 ${signed(attribution.delta)}，按未舍入数值汇总；起点 ${signed(attribution.baselinePnl)}，全部换为 V2 后 ${signed(attribution.allV2Pnl)}。</p><details className="fd-inner-details"><summary>展开全部输入组合</summary><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>DA 预测</th><th>价差预测</th><th>σ</th><th>模拟净损益 $</th><th>成交 MWh</th></tr></thead><tbody>{attribution.hybrids.map(row=><tr key={row.id}><td>{row.daVersion}</td><td>{row.spreadVersion}</td><td>{row.sigmaVersion}</td><td className={tone(row.netPnl)}>{num(row.netPnl)}</td><td>{num(row.filledMWh)}</td></tr>)}</tbody></table></div></details></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>成交后的盈亏结构</h2><p>胜率与盈亏幅度共同决定结果；单笔金额包含该笔分配电量和固定费用。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>版本</th><th>计划 / 成交笔数</th><th>模拟交叉成交率</th><th>成交胜率</th><th>平均盈利单笔 $</th><th>平均亏损单笔 $</th></tr></thead><tbody>{([{label:'V1',value:first},{label:'V2',value:last}]).map(row=><tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.value.plannedCells ?? '—'} / {row.value.trades ?? '—'}</td><td>{finite(row.value.fillRate)?`${num(row.value.fillRate*100,1)}%`:'—'}</td><td>{finite(row.value.winRate)?`${num(row.value.winRate,1)}%`:'—'}</td><td>{num(row.value.averageWin)}</td><td className={tone(row.value.averageLoss)}>{num(row.value.averageLoss)}</td></tr>)}</tbody></table></div></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>损益差异发生在哪里</h2><p>净损益负数为亏损，变化负数为变差。各维度是同一批模拟成交的不同视角，不能相加。</p></div><label className="fl-select">拆解维度<select aria-label="损益诊断维度" value={breakdown} onChange={event=>setBreakdown(event.target.value as typeof breakdown)}><option value="byNode">枢纽</option><option value="bySide">INC / DEC</option><option value="byHour">小时起点 PT</option><option value="byDay">交易日 PT</option></select></label></div><GroupTable rows={diagnostic[breakdown]||[]} label={{byNode:'枢纽',bySide:'方向',byHour:'小时起点 PT',byDay:'交易日 PT'}[breakdown]}/></section>
      <section className="fd-next"><div><h2>下一步比较决策目标</h2><p>五个预声明方案直接检验模拟收益、回撤和交易量。零交易作为无暴露对照；所有候选保持固定顺序。</p></div><button className="fl-button primary" onClick={()=>setView('comparison')}>比较决策方案<ArrowRight size={15}/></button></section>
    </>}
    {view==='comparison'&&<>
      <section className="fd-controls"><label className="fl-select">比较窗口<select aria-label="决策比较窗口" value={window.id} onChange={event=>setWindowId(event.target.value)}>{report.windows.map(w=><option value={w.id} key={w.id}>{w.label}</option>)}</select></label><label className="fl-select">查看方案<select aria-label="查看决策方案" value={policy.id} onChange={event=>setPolicyId(event.target.value)}>{policies.map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label><div className="fd-fees"><span>费用假设 · $/MWh</span><div className="fl-segment" role="group" aria-label="决策比较费用假设">{report.feesPerMWh.map(value=><button key={value} aria-pressed={fee===value} className={fee===value?'active':''} onClick={()=>setFee(value)}>{value}</button>)}</div></div></section>
      <div className="fl-notice"><Info size={17}/><span><strong>{window.startDate} — {window.endDate} PT · {window.days} 天。</strong> 费用切换只对同一计划重算成本，不重新筛选信号。默认查看 Ridge 是预设展示选项，不代表它是全窗收益最高者或交易推荐。</span></div>
      <div className="fl-notice warning"><Info size={17}/><span><strong>收益对费用敏感。</strong> 共同 {rollingDays} 日中，将费用提高到 $2/MWh 后，Ridge 净损益为 ${signed(ridgeFee2?.netPnl)}，价格提升树为 ${signed(priceTreeFee2?.netPnl)}。{allHighCostLoss&&<>费用为 $5/MWh 时，三个新候选均为负净损益。</>}完整结算成本尚未全部建模。</span></div>
      <div className="fl-metrics"><article><span>所看方案 · 净损益</span><strong className={tone(result?.netPnl)}>${signed(result?.netPnl)}</strong><small>{policy.id==='no_trade'?'零交易对照 · 无暴露，不构成预测能力':`V2 同窗 $${signed(baseline?.netPnl)}`}</small></article><article><span>最大美元回撤</span><strong>${num(result?.maxDrawdown)}</strong><small>从本窗口累计损益峰值回落</small></article><article><span>计划 / 模拟成交电量</span><strong>{num(result?.plannedMWh,1)} / {num(result?.filledMWh,1)}</strong><small>MWh · {result?.trades ?? '—'} 笔模拟成交</small></article><article><span>无信号日</span><strong>{result?.noSignalDays ?? '—'} / {window.days}</strong><small>每成交 MWh 净损益 ${signed(result?.perMWh)}</small></article></div>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>{policy.label} · 累计模拟净损益</h2><p>{policy.description}</p></div><span className="fl-badge muted">${fee}/MWh · 历史重建</span></div><CumulativeCurve daily={report.daily} window={window} policyId={policy.id} policyLabel={policy.label} fee={fee}/><p className="fl-explanation">曲线从所选窗口起点归零；不把此前累积收益带入。报价交叉按模型假设模拟成交，未涵盖正式结算全部项目。</p></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>全部预声明方案并列检查</h2><p>固定顺序展示，点击方案可切换曲线。收益、回撤与暴露一起看。</p></div><span className="fl-badge">{policies.length} 个方案</span></div><div className="fl-table-scroll"><table className="fl-table fd-policy-table"><thead><tr><th>方案</th><th>净损益 $</th><th>毛损益 $</th><th>费用 $</th><th>最大回撤 $</th><th>成交 MWh</th><th>无信号日</th></tr></thead><tbody>{policies.map(p=>{const row=report.results.find(r=>r.windowId===window.id&&r.policyId===p.id&&r.feePerMWh===fee);return <tr key={p.id} className={policy.id===p.id?'selected':''}><td><button onClick={()=>setPolicyId(p.id)} aria-pressed={policy.id===p.id}>{p.label}</button><small>{p.id==='no_trade'?'无暴露对照':p.description}</small></td><td className={tone(row?.netPnl)}>{num(row?.netPnl)}</td><td>{num(row?.grossPnl)}</td><td>{num(row?.fees)}</td><td>{num(row?.maxDrawdown)}</td><td>{num(row?.filledMWh)}</td><td>{row?.noSignalDays ?? '—'} / {window.days}</td></tr>;})}</tbody></table></div></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>跨月稳定性</h2><p>同一策略与费用假设，保留每个月份；单月盈利不能代替整体与未来验证。</p></div>{window.id!=='rolling'&&<button className="fl-button" onClick={()=>setWindowId('rolling')}>切换完整滚动窗</button>}</div>{window.id==='rolling'?<div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>月份 · PT</th><th>实际评价范围</th><th>所看方案净损益 $</th><th>V2 净损益 $</th><th>所看方案成交 MWh</th><th>无信号日</th></tr></thead><tbody>{months.map(month=>{const row=report.monthly.find(r=>r.month===month&&r.policyId===policy.id&&r.feePerMWh===fee);const base=report.monthly.find(r=>r.month===month&&r.policyId==='v2_original'&&r.feePerMWh===fee);return <tr key={month}><td><strong>{month}</strong></td><td>{row?.startDate ?? '—'}<small>至 {row?.endDate ?? '—'}</small></td><td className={tone(row?.netPnl)}>{num(row?.netPnl)}</td><td className={tone(base?.netPnl)}>{num(base?.netPnl)}</td><td>{num(row?.filledMWh)}</td><td>{row?.noSignalDays ?? '—'} / {row?.days ?? '—'}</td></tr>;})}</tbody></table></div>:<p className="fl-explanation">当前选择的是旧 14 日开发窗。完整月度比较使用滚动窗，切换后同时更新上方指标和曲线。</p>}</section>
      <div className="fl-notice warning"><Info size={17}/><span><strong>仍需新的前向验证。</strong> {report.promotionGate.reasons.join(' ')} 所有窗口都属于本轮方法开发时已经可见的历史，不能重新称为未见测试。</span></div>
    </>}
    {view==='evidence'&&<>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>收益决策方案复算</h2><p>V3 读取收益预测和冻结订单计划；V2 的价格预测输入与原运行器继续在 V2 查看。</p></div><Code2 size={24}/></div><div className="fl-download-grid"><a href={`${ROOT}caiso-v3-public-results.zip`} download><Code2 size={22}/><strong>研究结果与数据包</strong><span>研究数据、收益模型、订单计划与文件校验清单</span><ArrowDownToLine size={17}/></a><a href={`${ROOT}decision_strategy.py`} download><FileJson size={22}/><strong>收益决策运行器</strong><span>独立复算冻结计划，不改写旧价格预测字段</span><ArrowDownToLine size={17}/></a><a href={`${ROOT}decision-plan-input.json`} download><Database size={22}/><strong>冻结决策输入</strong><span>历史开发研究 · 各策略的订单和真实行情</span><ArrowDownToLine size={17}/></a></div><div className="fl-code-block"><span>把运行器和输入放在同一目录后执行</span><pre><code>python decision_strategy.py --data decision-plan-input.json --policy ridge_payoff --fee-per-mwh 1 --output replay.json</code></pre></div></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>从输入到结果，保留可复核证据</h2><p>完整训练在 Python 中运行；网页刷新只读取已发布结果。</p></div><FileJson size={24}/></div><div className="fl-artifact-links"><a href={`${ROOT}report.json`} download>完整决策研究报告<ArrowDownToLine size={14}/></a><a href={`${ROOT}protocol.json`} download>预声明协议与冻结摘要<ArrowDownToLine size={14}/></a><a href={`${ROOT}decision-points.json`} download>逐点收益预测与评价<ArrowDownToLine size={14}/></a><a href={`${ROOT}decision-plans.json`} download>逐日决策与模拟成交<ArrowDownToLine size={14}/></a><a href={`${ROOT}replay-verification.json`} download>独立 Python 复算校验<ArrowDownToLine size={14}/></a><a href={`${ROOT}fundamentals-audit.json`} download>负荷与风光历史审计<ArrowDownToLine size={14}/></a><a href={`${ROOT}fundamentals-verification.json`} download>基本面归一化逐值核验<ArrowDownToLine size={14}/></a></div><div className="fl-code-block"><span>冻结协议时间 · 北京</span><p>{dateLabel(report.protocol.frozenAt)}</p><span>协议摘要</span><code className="fd-digest">{report.protocol.designDigest}</code></div></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>输入范围与时点边界</h2><p>{report.sample.priceStartDate} — {report.sample.priceEndDate} PT · {report.sample.priceDays} 日价格档案</p></div><span className="fl-badge muted">按 D−2 截断可用信息</span></div><div className="fd-evidence-facts"><div><span>完整价格记录</span><strong>{report.sample.priceRows.toLocaleString()}</strong><small>{report.sample.nodes.map(nodeLabel).join(' · ')}</small></div><div><span>基本面历史小时</span><strong>{num(report.sample.fundamentalsRows,0)}</strong><small>实际负荷、风电与光伏 · 滞后使用</small></div><div><span>本轮新前向批次</span><strong>未生成</strong><small>V2 已归档预测保留原版本与发布时间</small></div></div><p className="fl-explanation">基本面来自今天获取的 OASIS 历史版本。只作为 D−2 及更早的滞后信息；没有证明这些数值就是历史首次发布值。{report.forward.reason}</p></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>五个方案的职责</h2><p>模型预测模拟成交条件下的收益，策略仍遵守预声明的电量和报价约束。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>方案</th><th>用途与边界</th></tr></thead><tbody>{policies.map(p=><tr key={p.id}><td><strong>{p.label}</strong></td><td className="fl-wrap">{p.description}</td></tr>)}</tbody></table></div></section>
      <details className="fl-method"><summary><ShieldCheck size={16}/>数据、成交假设与研究限制</summary><div>{report.warnings.map((warning,i)=><p key={i}>{warning}</p>)}<p>历史输入替换诊断只解释固定模拟条件下的差异，不识别市场事件的因果影响。历史价格可能经过修订，重建不证明当时已经发布相同数据或模型。</p><p>本轮没有新增未来预测或自动定时训练。需要未来日完整数据、实际生成时间和平台接收回执，才可以建立新的事前观察记录。</p></div></details>
    </>}
  </section>;
}
