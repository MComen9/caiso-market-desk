'use client';

import { publicUrl } from '@/lib/public-url';

import {useEffect, useMemo, useState} from 'react';
import {ArrowDownToLine, ArrowRight, Clock3, FileText, Info, LoaderCircle} from 'lucide-react';
import type {ForecastSimulation} from '@/lib/forecast-lab-types';
import '@/app/forecast-lab.css';

const ROOT = publicUrl('/data/forecast-lab/v4/');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (v: unknown, precision=2) => finite(v) ? v.toLocaleString('en-US', {minimumFractionDigits: precision, maximumFractionDigits: precision}) : '—';
const dollars = (v: unknown) => finite(v) ? (v < 0 ? '−$' : '$') + number(Math.abs(v)) : '—';
const time = (s: string) => new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(s));
const statusOf = (d: ForecastSimulation['days'][number]) => d.status === 'no_signals' ? '无信号' : !finite(d.pnl) ? '无完整结果' : d.filled > 0 ? '模拟成交' : '未成交';

function EquityCurve({days}: {days:ForecastSimulation['days']}) {
  const row = useMemo(() => {
    let sum = 0;
    return [{date:'期初',value:0},...days.map(d=>({date:d.date,value:finite(d.pnl) ? sum+=d.pnl : null}))];
  },[days]);
  const [selected, setSelected] = useState<number|null>(null);
  const values=row.map(d=>d.value).filter(finite), W=900, H=224, L=70, R=22, T=24, B=34;
  const min=Math.min(0,...values), max=Math.max(0,...values), pad=Math.max((max-min)*.1,1);
  const y=(v: number)=>T+(max+pad-v)/(max-min+2*pad)*(H-T-B), x=(i: number)=> L+i/Math.max(1,row.length-1)*(W-L-R);
  let pen=false;
  const path=row.map((d,i)=>{if(d.value===null){pen=false;return '';}const cmd=pen?'L':'M';pen=true;return cmd+x(i)+','+y(d.value);}).join(' ');
  const chosen=selected===null?null:row[selected];
  return <div className="fl-curve" tabIndex={0} aria-label="累计情景损益，左右方向键选择日期" onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setSelected(v=>Math.max(0,Math.min(row.length-1,(v??0)+(e.key==='ArrowRight'?1:-1))));}}}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="V4 开发窗口每日收盘累计模拟损益（美元）" onMouseMove={e=>{const b=e.currentTarget.getBoundingClientRect();setSelected(Math.max(0,Math.min(row.length-1, Math.round((((e.clientX-b.left)/b.width)*W-L)/(W-L-R)*(row.length-1)))));}} onMouseLeave={()=>setSelected(null)}>
      {[0,1,2,3].map(i=>{const v=min-pad+(max-min+2*pad)*i/3;return <g key={i}><line x1={L} x2={W-R} y1={y(v)} y2={y(v)} stroke="#e1eae5" strokeDasharray="3 5"/><text textAnchor="end" x={L-9} y={y(v)+4} className="fl-axis">{number(v,0)}</text></g>;})}
      <line x1={L} x2={W-R} y1={y(0)} y2={y(0)} stroke="#a6b8ac"/><path d={path} stroke="#337b56" strokeWidth="3" fill="none" strokeLinejoin="round"/>
      {row.map((d,i)=>(i===0||i===row.length-1||i%7===0)&&<text key={i} textAnchor="middle" x={x(i)} y={H-9} className="fl-axis">{i===0?d.date:d.date.slice(5)}</text>)}
      {chosen&&selected!==null&&finite(chosen.value)&&<circle cx={x(selected)} cy={y(chosen.value)} r="4" fill="#337b56" stroke="white" strokeWidth="2"/>}
    </svg><div className="fl-chart-caption"><span><i className="fl-key line"/>累计损益 · 美元</span><strong>{chosen? `${chosen.date} · ${dollars(chosen.value)}`:'悬停或使用左右方向键查看日期'}</strong></div>
  </div>;
}

export default function StrategyLab() {
  const [result,setResult]=useState<ForecastSimulation|null>(null), [error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const [filter,setFilter]=useState<'all'|'filled'|'none'>('all');
  useEffect(()=>{
    const c=new AbortController();setError(false);
    fetch(ROOT+'simulation-summary.json',{signal:c.signal}).then(async r=>{
      if(!r.ok)throw Error('status');const data=await r.json() as ForecastSimulation;
      if(!data.holdout||!Array.isArray(data.days)||!data.days.length||!data.config||!data.forward)throw Error('schema');
      if(!c.signal.aborted)setResult(data);
    }).catch(()=>{if(!c.signal.aborted)setError(true);});
    return ()=>c.abort();
  },[attempt]);
  if(!result)return <div className="fl-loading" role="status">{error?<Info size={23}/>:<LoaderCircle size={23} className="fl-spin"/>}<strong>{error?'模拟快照暂时无法读取':'正在载入策略模拟快照…'}</strong>{error&&<button className="fl-button" onClick={()=>setAttempt(n=>n+1)}>重试</button>}</div>;
  const {holdout:h,config:c,forward:f,days}=result;
  const filtered=days.filter(d=>filter==='all'||(filter==='filled'?d.filled>0:d.status==='no_signals'));
  return <section className="forecast-lab" aria-label="研究策略模拟结果">
    <header className="fl-heading"><div><span className="fl-eyebrow">STRATEGY RESULTS · V4</span><h1>策略模拟结果</h1><p>查阅固定策略在开发窗口的模拟表现，以及同一策略在预测发布时给出的计划。</p></div><a className="fl-button secondary" href={ROOT+'simulation-summary.json'} download><ArrowDownToLine size={15}/>下载结果</a></header>
    <div className="fl-context"><span><Clock3 size={14}/>生成于 {time(result.generatedAt)} 北京时间</span><span>{days[0].date} 至 {days[days.length-1].date} PT</span><span>固定费用 ${number(c.feePerMWh,0)}/MWh</span></div>
    <div className="fl-metrics">
      <article><span>开发期模拟损益</span><strong>{dollars(h.total)}</strong><small>已扣情景费用 {dollars(h.fees)}</small></article>
      <article><span>最大回撤</span><strong>{dollars(h.maxdd)}</strong><small>累计模拟损益的最大峰谷回落</small></article>
      <article><span>模拟成交量</span><strong>{number(h.filled)} MWh</strong><small>{h.totalTrades} 笔模拟成交</small></article>
      <article><span>交易胜率</span><strong>{number(h.winRate,1)}%</strong><small>{h.noSignalDays} 个无信号日 · {h.evaluatedDays} 个完整评价日</small></article>
    </div>
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>历史模拟累计损益</h2><p>期初为零，按日期累加已知的每日模拟损益。结果对应已见历史开发样本。</p></div><span className="fl-badge muted">开发评估</span></div><EquityCurve days={days}/></section>
    {f&&<section className="fl-panel"><div className="fl-panel-heading"><div><h2>{f.date} PT · 发布时的前向计划</h2><p>{f.forecastHours}/{f.expectedHours} 个节点小时已有预测；实际损益以生成时快照为准。</p></div><a className="fl-text-link" href={publicUrl('/#prices/prediction')}>查看价格预测<ArrowRight size={14}/></a></div>
      <div className="fl-simulation-metrics"><div><span>计划电量</span><strong>{number(f.gross)} MWh</strong></div><div><span>未分配预算</span><strong>{number(f.unallocatedMWh)} MWh</strong></div><div><span>发布时实际损益</span><strong>{dollars(f.pnl)}</strong><small>{f.pnl===null?'当时未知':''}</small></div></div>
    </section>}
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>固定策略与参数</h2><p>全部日期采用同一策略和费用假设。</p></div></div><div className="fl-field-map"><div><code>{c.strat}</code><span>策略 · 顺势</span></div><div><code>k = {c.k}</code><span>价差波动门槛系数</span></div><div><code>{c.total} MWh</code><span>每日预算</span></div><div><code>{c.capPer} / {c.capNode} MWh</code><span>每时段 / 每枢纽上限</span></div></div><p className="fl-explanation">报价交叉用于估算成交；回测收益不代表真实成交、未来收益或完整账户结算。</p></section>
    <section className="fl-panel"><div className="fl-panel-heading"><div><h2>逐日模拟结果</h2><p>{filtered.length} 个日期 · 交易日按太平洋时间</p></div><label className="fl-select">筛选<select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}><option value="all">全部日期</option><option value="filled">有模拟成交</option><option value="none">无信号日</option></select></label></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>交易日 PT</th><th>状态</th><th>计划 MWh</th><th>成交 MWh</th><th>费用 $</th><th>净损益 $</th></tr></thead><tbody>{filtered.map(d=><tr key={d.date}><td>{d.date}</td><td>{statusOf(d)}</td><td>{number(d.gross)}</td><td>{number(d.filled)}</td><td>{number(d.fees)}</td><td className={finite(d.pnl)&&d.pnl<0?'fl-negative':''}>{number(d.pnl)}</td></tr>)}</tbody></table></div></section>
    <div className="fl-artifact-links"><a href={ROOT+'forward-plan.json'} download>前向模拟计划<FileText size={14}/></a><a href={ROOT+'holdout-simulation.json'} download>历史模拟明细<ArrowDownToLine size={14}/></a><a href={ROOT+'report.json'} download>预测验证报告<ArrowDownToLine size={14}/></a></div>
  </section>;
}
