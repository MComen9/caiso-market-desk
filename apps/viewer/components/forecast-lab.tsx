'use client';

import { publicUrl } from '@/lib/public-url';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Beaker, CheckCircle2, ChevronDown, Clock3, Code2, Database, ExternalLink, FileJson, Info, LoaderCircle, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { HUBS } from '@/lib/types';
import type { ForecastExperiment, ForecastSimulation, ModelForecastBundle, ModelForecastPoint } from '@/lib/forecast-lab-types';
import OptimizationReview from '@/components/forecast-optimization';
import DecisionResearch from '@/components/forecast-decision';
import CurrentForecast from '@/components/current-forecast';
import '@/app/forecast-lab.css';

const ROOTS = {v1: publicUrl('/data/forecast-lab/'), v2: publicUrl('/data/forecast-lab/v2/')} as const;
type ForecastVersion = keyof typeof ROOTS;
type Version = ForecastVersion | 'v3' | 'v4';
const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const num = (n: number | null | undefined, digits = 2) => numeric(n) ? n.toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}) : '—';
const percent = (n: number | null | undefined) => numeric(n) ? `${num(n * 100, 1)}%` : '—';
const shortNode = (node: string) => HUBS.find(hub => hub.id === node)?.short || node;
const beijing = (value: string) => new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(value));
type Tab = 'forward' | 'evaluation' | 'python' | 'optimization';

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(publicUrl(url), {cache: 'no-store', credentials: 'same-origin', signal});
  if (!response.ok) throw new Error(`数据读取未完成（HTTP ${response.status}），请重试。`);
  return response.json();
}
function ForecastCurve({points, metric}: {points: ModelForecastPoint[]; metric: 'spread' | 'da'}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.flatMap(p => metric === 'spread' ? [p.predictedSpread, p.spreadLow80, p.spreadHigh80] : [p.predictedDa, p.daLow80, p.daHigh80]).filter(numeric);
  if (!points.length || !values.length) return <p className="fl-empty">该节点暂无预测。</p>;
  const W = 960, H = 260, L = 62, R = 20, T = 24, B = 37;
  const min = Math.min(...values, ...(metric === 'spread' ? [0] : []));
  const max = Math.max(...values, ...(metric === 'spread' ? [0] : []));
  const pad = Math.max((max - min) * .12, 2), lo = min - pad, hi = max + pad;
  const x = (i: number) => L + i / Math.max(points.length - 1, 1) * (W - L - R);
  const y = (v: number) => T + (hi - v) / (hi - lo) * (H - T - B);
  const center = (p: ModelForecastPoint) => metric === 'spread' ? p.predictedSpread : p.predictedDa;
  const lower = (p: ModelForecastPoint) => metric === 'spread' ? p.spreadLow80 : p.daLow80;
  const upper = (p: ModelForecastPoint) => metric === 'spread' ? p.spreadHigh80 : p.daHigh80;
  const curve = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(center(p))}`).join(' ');
  const hasBand = points.every(p => numeric(lower(p)) && numeric(upper(p)));
  const band = hasBand ? points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(upper(p)!)}`).join(' ') + [...points].reverse().map((p, i) => `L${x(points.length - i - 1)},${y(lower(p)!)}`).join(' ') + 'Z' : '';
  const selected = hover === null ? null : points[Math.min(hover, points.length - 1)];
  return <div className="fl-curve" tabIndex={0} aria-label="逐小时预测。左右方向键查看时段。" onKeyDown={e => {if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {e.preventDefault(); setHover(i => e.key === 'ArrowRight' ? Math.min((i ?? -1) + 1, points.length - 1) : Math.max((i ?? 1) - 1, 0));}}}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={metric === 'spread' ? '预测 FMM−DA 价差及经验80%区间' : '预测日前价格及经验80%区间'} onMouseMove={e => {const rect = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width * W - L) / (W - L - R) * (points.length - 1)))));}} onMouseLeave={() => setHover(null)}>
      <text x={L} y="13" className="fl-axis">$/MWh</text>
      {[0,1,2,3,4].map(i => {const value = lo + (hi - lo) * i / 4; return <g key={i}><line x1={L} x2={W-R} y1={y(value)} y2={y(value)} stroke="#e7ede9" strokeDasharray="3 5"/><text x={L-10} y={y(value)+4} textAnchor="end" className="fl-axis">{num(value,1)}</text></g>;})}
      {lo < 0 && hi > 0 && <line x1={L} x2={W-R} y1={y(0)} y2={y(0)} stroke="#9cafaa" strokeDasharray="5 4"/>}
      {hasBand && <path d={band} fill="#4e8f6b" fillOpacity=".13"/>}<path d={curve} fill="none" stroke="#337c59" strokeWidth="2.5" strokeLinejoin="round"/>
      {points.map((p,i) => (i % 4 === 0 || i === points.length-1) && <text key={p.startUtc} x={x(i)} y={H-11} textAnchor="middle" className="fl-axis">{p.localHour}</text>)}
      {selected && hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={T} y2={H-B} stroke="#7e9789" strokeDasharray="3 3"/><circle cx={x(hover)} cy={y(center(selected))} r="4" fill="#337c59" stroke="white" strokeWidth="2"/></g>}
    </svg>
    <div className="fl-chart-caption">{selected ? <><strong>{selected.localHour} PT · {shortNode(selected.node)}</strong><span>预测 {num(center(selected))}</span><span>经验区间 [{num(lower(selected))}, {num(upper(selected))}]</span></> : <><span><i className="fl-key line"/>点预测</span><span><i className="fl-key band"/>经验 80% 区间</span><span>悬停或使用左右方向键查看 · 小时起点 PT</span></>}</div>
  </div>;
}

function VersionedForecastLab({version, onFallback, initialTab}: {version: ForecastVersion; onFallback: () => void; initialTab?: Tab}) {
  const ROOT = ROOTS[version];
  const optimized = version === 'v2';
  const [report, setReport] = useState<ForecastExperiment | null>(null);
  const [forward, setForward] = useState<ModelForecastBundle | null>(null);
  const [simulation, setSimulation] = useState<ForecastSimulation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<Tab>(initialTab ?? (optimized ? 'optimization' : 'forward'));
  const [node, setNode] = useState<string>(HUBS[0].id);
  const [metric, setMetric] = useState<'spread'|'da'>('spread');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    Promise.all([readJson<ForecastExperiment>(`${ROOT}report.json`,controller.signal), readJson<ModelForecastBundle>(`${ROOT}forecast-forward.json`,controller.signal), readJson<ForecastSimulation>(`${ROOT}simulation-summary.json`,controller.signal).catch(() => null)])
      .then(([nextReport,nextForward,nextSimulation]) => {if (controller.signal.aborted) return; if (nextReport.modelVersion !== nextForward.modelVersion || nextReport.forecast.rows !== nextForward.points.length || (nextSimulation && nextForward.points.length > 0 && nextSimulation.forecastDigest !== nextForward.digest)) throw new Error('实验报告、预测与模拟输入版本不一致，请刷新后重试。'); setReport(nextReport); setForward(nextForward); setSimulation(nextSimulation);})
      .catch(e => {if (e.name !== 'AbortError') setError(e instanceof Error ? e.message : '预测实验暂时无法读取。');})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  },[refresh, ROOT]);
  const points = useMemo(() => forward?.points.filter(p => p.node === node).sort((a,b) => a.startUtc.localeCompare(b.startUtc)) || [], [forward,node]);

  if (loading && !report) return <div className="fl-loading"><LoaderCircle size={24} className="fl-spin"/><strong>正在读取已完成的预测实验…</strong><span>训练结果、时间划分和预测版本一并载入。</span></div>;
  if (!report || !forward) return <div className="fl-loading"><Info size={26}/><strong>{error || '实验结果尚未就绪'}</strong><button className="fl-button" onClick={() => setRefresh(v=>v+1)}>重新读取</button>{optimized && <button className="fl-button" onClick={onFallback}>查看上一轮实验</button>}</div>;
  const selected = report.holdout.selected, baseline = report.holdout.baseline;
  const spreadDelta = (baseline.spread.mae - selected.spread.mae) / Math.max(baseline.spread.mae, 1e-9);
  const hasForward = forward.points.length > 0 && forward.classification === 'forward_forecast';
  const evaluationLabel = optimized ? '开发评估' : '留出集';
  const tabs: Array<{id: Tab; label: string; icon: typeof Beaker}> = optimized
    ? [{id:'optimization',label:'优化对比',icon:ShieldCheck},{id:'forward',label:'逐小时预测',icon:Beaker},{id:'python',label:'Python 输入与复现',icon:Code2}]
    : [{id:'forward',label:'逐小时预测',icon:Beaker},{id:'evaluation',label:'模型与验证',icon:ShieldCheck},{id:'python',label:'Python 输入与复现',icon:Code2}];
  return <section className="forecast-lab" aria-label="电价预测实验室">
    <header className="fl-heading"><div><span className="fl-eyebrow">TRAIN · VALIDATE · FORECAST</span><h1>电价预测实验室 <span>{optimized ? '第二轮优化' : '初始实验'}</span></h1><p>{optimized ? '比较同一时段的模型误差，检查优化是否稳健，再查看新一批预测。' : '从已有数据选择模型，生成逐小时预测，再交给策略模拟。'}</p></div><button className="fl-button secondary" onClick={() => setRefresh(v=>v+1)} disabled={loading}>{loading ? <LoaderCircle size={15} className="fl-spin"/> : <RefreshCw size={15}/>}重读快照</button></header>
    <div className="fl-context"><span><Database size={14}/>{report.sample.days} 天 · {report.sample.nodes.length} 枢纽 · {report.sample.rows.toLocaleString()} 小时记录</span><span><Clock3 size={14}/>生成于 {beijing(report.generatedAt)} 北京时间</span><code>{report.modelVersion}</code></div>
    <nav className="fl-tabs" aria-label="预测实验视图">{tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} aria-current={tab===t.id?'page':undefined} className={tab===t.id?'active':''}><t.icon size={16}/>{t.label}</button>)}</nav>
    {error && <div className="fl-notice warning" role="alert"><Info size={17}/><span>{error}</span></div>}
    {optimized ? <div className="fl-notice warning"><Info size={17}/><span><strong>研究版 · 优化结果仍需前向验证。</strong> {selected.spread.mae >= baseline.spread.mae && '共同开发窗口的价差误差尚未低于零价差基线。'}本轮使用已经查看过的历史数据开发与比较，改善不能作为新的独立测试结论。未来预测按真实发布时间保存，实际价格到齐后再评价。</span></div> : <div className={`fl-notice ${spreadDelta <= 0 ? 'warning' : ''}`}><Info size={17}/><span><strong>{spreadDelta <= 0 ? '研究版 · 未通过推广门槛：价差模型未超过零价差基准。' : `研究版 · 留出集价差 MAE 较零价差基准下降 ${percent(spreadDelta)}。`}</strong> 选型只使用较早的验证集；最后 {report.splits.holdout.days} 天用于检验。当前结果支持继续研究，不能据此确认稳定交易收益。</span></div>}
    <div className="fl-metrics"><article><span>预测交易日 · PT</span><strong>{hasForward ? report.forecast.targetDate : '待生成'}</strong><small>{hasForward ? <>{report.forecast.rows} 条逐小时预测 · 发布时的预测快照</> : '等待满足数据与发布时间要求的前向批次'}</small></article><article><span>日前价格模型</span><strong>{report.selectedModels.da.label}</strong><small>{evaluationLabel} MAE {num(selected.da.mae)} $/MWh</small></article><article><span>价差模型 · FMM−DA</span><strong>{report.selectedModels.spread.label}</strong><small>{evaluationLabel} MAE {num(selected.spread.mae)} $/MWh</small></article><article><span>{optimized ? '有信号时价差方向准确率' : '价差方向准确率'}</span><strong>{percent(optimized ? selected.spread.conditionalSignAccuracy : selected.spread.signAccuracy)}</strong><small>{optimized ? <>信号覆盖 {percent(selected.spread.signalRate)} · {selected.spread.n.toLocaleString()} 条开发样本</> : <>{selected.spread.n.toLocaleString()} 条留出样本 · 非零实际值口径</>}</small></article></div>
    {tab === 'optimization' && <OptimizationReview report={report} simulation={simulation} root={ROOT}/>}
    {tab === 'forward' && !hasForward && <section className="fl-panel"><div className="fl-empty"><Info size={24}/><h2>前向预测暂未就绪</h2><p>{report.forecast.reason || '当前批次未满足完整数据与决策截点要求。'}历史优化结果仍可查看；不会沿用旧时间戳或将过去预测改名为新预测。</p><button className="fl-button" onClick={()=>setTab('optimization')}>查看优化比较</button></div></section>}
    {tab === 'forward' && hasForward && <>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>{report.forecast.targetDate} · 价格与价差预测</h2><p>训练实际价格截至 {report.forecast.trainingThrough} PT；阴影为历史样本外残差构建的经验区间。</p></div><div className="fl-actions"><label className="fl-select">枢纽<select value={node} onChange={e=>setNode(e.target.value)} aria-label="预测枢纽">{report.sample.nodes.map(n=><option key={n} value={n}>{shortNode(n)}</option>)}</select></label><div className="fl-segment"><button className={metric==='spread'?'active':''} onClick={()=>setMetric('spread')}>FMM−DA</button><button className={metric==='da'?'active':''} onClick={()=>setMetric('da')}>日前价</button></div></div></div>
        <ForecastCurve points={points} metric={metric}/><div className="fl-explanation">区间名义覆盖率为 80%；{optimized ? '共同开发窗口' : '最后 14 天'}的实际覆盖率：日前价 {percent(report.holdout.intervals.daCoverage80)}，价差 {percent(report.holdout.intervals.spreadCoverage80)}。它不是获利概率。</div>
      </section>
      {simulation?.forward && simulation.forward.gross === 0 && simulation.forward.forecastHours === simulation.forward.expectedHours && <div className="fl-notice"><Info size={17}/><span><strong>当前固定策略没有形成可分配计划。</strong> {simulation.forward.forecastHours} 个小时节点预测齐全，计划为 0 MWh，{num(simulation.forward.unallocatedMWh)} MWh 预算未分配。这不表示数据缺失，也不表示已实现零收益。</span></div>}
      <div className="fl-handoff"><div><CheckCircle2 size={23}/><span><strong>已发布的预测和研究输入</strong><small>predictedDa · predictedSpread · sigma · UTC 时段 · 训练与发布时间</small></span></div><div className="fl-actions"><a className="fl-button secondary" href={publicUrl(simulation?.forward ? `${ROOT}embedded-data.json` : report.artifacts.forward)} download><ArrowDownToLine size={15}/>{simulation?.forward ? '下载 Python 输入' : '下载预测 JSON'}</a>{simulation && <a className="fl-button primary" href={`${ROOT}simulation-summary.json`} download>下载此版本模拟摘要<ArrowDownToLine size={15}/></a>}</div></div>
      <p className="fl-small">{simulation?.forward && <>Python 已用同一输入完成模拟：计划 {num(simulation.forward.gross)} MWh，实际损益待验证。</>} 预测图表保留生成时的未知实际值，读者可以下载同一批输入与历史结果。</p>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>逐小时输入明细 · {shortNode(node)}</h2><p>价差 = 预测 FMM 小时均价 − 预测 DA；金额单位 $/MWh。</p></div><a className="fl-text-link" href={publicUrl(report.artifacts.csv)} download>导出全部预测 CSV<ArrowDownToLine size={14}/></a></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>小时起点 PT</th><th>预测 DA</th><th>预测 FMM</th><th>预测价差</th><th>价差 σ</th><th>价差经验 80% 区间</th></tr></thead><tbody>{points.map(p=><tr key={p.startUtc}><td><strong>{p.localHour}</strong><small>UTC{p.utcOffset}</small></td><td>{num(p.predictedDa)}</td><td>{num(p.predictedFmm)}</td><td className={p.predictedSpread<0?'fl-negative':'fl-positive'}>{p.predictedSpread>0?'+':''}{num(p.predictedSpread)}</td><td>{num(p.sigma)}</td><td>[{num(p.spreadLow80)}, {num(p.spreadHigh80)}]</td></tr>)}</tbody></table></div></section>
    </>}
    {tab === 'evaluation' && <>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>先选模型，再检验</h2><p>每天前推，特征和训练实际值仅使用目标日前第 {report.method.featureDelayDays} 日及更早的完整交易日。随机种子 {report.method.seed}。</p></div><a className="fl-text-link" href={`${ROOT}report.json`} download>下载完整实验报告<FileJson size={15}/></a></div><div className="fl-splits">{([{id:'validation',label:'验证 · 选型与参数'},{id:'calibration',label:'校准 · 误差与区间'},{id:'holdout',label:'留出 · 最后检验'}] as const).map(s=><div key={s.id}><span>{s.label}</span><strong>{report.splits[s.id].startDate} — {report.splits[s.id].endDate}</strong><small>{report.splits[s.id].days} 个交易日</small></div>)}</div><p className="fl-explanation">阶段间保留 {report.splits.purgedDates.join('、')} 的目标日间隔，以满足决策截点的数据可用性。每个训练窗口单独拟合预处理和模型；留出日可在后续预测时成为已知历史，但不会重新挑模型或参数。</p></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>候选模型比较</h2><p>按验证集选择，测试列用于公开检查选型是否有效。MAE、RMSE 越低越好；不使用不适合零价与负价的 MAPE。</p></div><span className="fl-badge">{report.candidates.length} 组实际运行</span></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>模型与参数</th><th>验证 DA MAE</th><th>验证价差 MAE</th><th>留出 DA MAE</th><th>留出价差 MAE</th><th>本次选择</th></tr></thead><tbody>{report.candidates.map(c=><tr key={c.id}><td><strong>{c.label}</strong><small>{c.family} · {Object.entries(c.params).map(([k,v])=>`${k}=${String(v)}`).join(' · ') || '固定基准'}</small></td><td>{num(c.validation.da.mae)}</td><td>{num(c.validation.spread.mae)}</td><td>{num(c.holdout.da.mae)}</td><td>{num(c.holdout.spread.mae)}</td><td>{c.id===report.selectedModels.da.id&&<span className="fl-badge">DA</span>} {c.id===report.selectedModels.spread.id&&<span className="fl-badge">价差</span>}</td></tr>)}</tbody></table></div><p className="fl-explanation">{report.method.selectionRule}</p></section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>留出集 · 按枢纽检查</h2><p>{report.splits.holdout.startDate} — {report.splits.holdout.endDate} PT；零价差基准 MAE {num(baseline.spread.mae)}，日前同小时均值基准 MAE {num(baseline.da.mae)}。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>枢纽</th><th>DA MAE</th><th>DA RMSE</th><th>价差 MAE</th><th>价差 RMSE</th><th>价差方向准确率</th></tr></thead><tbody>{report.holdout.byNode.map(n=><tr key={n.node}><td><strong>{shortNode(n.node)}</strong></td><td>{num(n.da.mae)}</td><td>{num(n.da.rmse)}</td><td>{num(n.spread.mae)}</td><td>{num(n.spread.rmse)}</td><td>{percent(n.spread.signAccuracy)}</td></tr>)}</tbody></table></div></section>
      {simulation && <section className="fl-panel"><div className="fl-panel-heading"><div><h2>同一预测的 Python 策略检验</h2><p>顺势 · k={simulation.config.k} · {simulation.config.total} MWh/日 · 报价偏移 ${simulation.config.dp}/MWh。全部参数固定，未按留出期收益再调参。</p></div><a className="fl-text-link" href={`${ROOT}holdout-simulation.json`} download>逐笔模拟结果<ArrowDownToLine size={14}/></a></div><div className="fl-simulation-metrics"><div><span>留出期价差损益 · 零费用</span><strong className={simulation.holdout.total<0?'fl-negative':''}>${num(simulation.holdout.total)}</strong><small>{simulation.holdout.evaluatedDays} 个完整评估日 · {num(simulation.holdout.filled)} MWh 模拟成交</small></div><div><span>最大回撤</span><strong>${num(simulation.holdout.maxdd)}</strong><small>累计美元损益回撤，非资金收益率</small></div><div><span>按 $1/MWh 费用敏感性</span><strong className={simulation.feeSensitivity1PerMWh.total<0?'fl-negative':''}>${num(simulation.feeSensitivity1PerMWh.total)}</strong><small>同一计划 · 配置费用 ${num(simulation.feeSensitivity1PerMWh.fees)}</small></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>交易日期 PT</th><th>计划 MWh</th><th>模拟成交 MWh</th><th>价差损益 $</th><th>状态</th></tr></thead><tbody>{simulation.days.map(d=><tr key={d.date}><td>{d.date}</td><td>{num(d.gross)}</td><td>{num(d.filled)}</td><td className={numeric(d.pnl)&&d.pnl<0?'fl-negative':''}>{num(d.pnl)}</td><td>{d.status==='complete'?'完整评估':d.status}</td></tr>)}</tbody></table></div><p className="fl-explanation">历史重建研究；未发送交易。成交仅按报价与 DA 是否交叉推算，未包括 Forecasted Movement、其他分摊与完整结算费用。未来日的计划不能解释为已实现收益。</p></section>}
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>现有数据的使用范围</h2><p>只让可对齐、可按时间截断的数据进入本次训练。</p></div></div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>来源 / 特征</th><th>本次用途</th><th>依据</th></tr></thead><tbody>{report.featureAudit.map((f,i)=><tr key={i}><td><strong>{f.source}</strong></td><td><span className={`fl-badge ${f.status==='included'?'':'muted'}`}>{f.status==='included'?'进入模型':'暂未入模'}</span></td><td className="fl-wrap">{f.reason}</td></tr>)}</tbody></table></div></section>
    </>}
    {tab === 'python' && <>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>给交易脚本一份真正可用的输入</h2><p>保留原始上传脚本，提供可直接读取的兼容数据，以及修正缺失值和时点处理的 Python 运行器。</p></div><Code2 size={24}/></div><div className="fl-download-grid"><a href={`${ROOT}${version==='v2'?'caiso-v2-public-results.zip':'caiso-forecast-research.zip'}`} download><Code2 size={22}/><strong>研究结果与数据包</strong><span>已发布的数据、模型结果与策略输入</span><ArrowDownToLine size={17}/></a><a href={`${ROOTS.v1}trading_strategy.py`} download><Play size={22}/><strong>修正版策略运行器</strong><span>保留七类策略与原输入结构</span><ArrowDownToLine size={17}/></a>{hasForward && simulation?.forward ? <a href={`${ROOT}embedded-data.json`} download><FileJson size={22}/><strong>本版本 Python 输入</strong><span>meta / nodes / series · 预测日实际值为空</span><ArrowDownToLine size={17}/></a> : <div className="fl-download-pending"><FileJson size={22}/><strong>前向输入待就绪</strong><span>需要可用预测及对应 Python 模拟产物</span></div>}</div>
        {hasForward && simulation?.forward && <div className="fl-code-block"><span>下载运行器和当前版本输入文件到同一目录</span><pre><code>{`python trading_strategy.py --data embedded-data.json --date ${report.forecast.targetDate} --strategy normal --k 0.5`}</code></pre></div>}
        <div className="fl-field-map"><div><code>r[1] / r[2]</code><span>实际 DA / FMM；未来为空</span></div><div><code>r[3]</code><span>模型预测的 FMM−DA 价差</span></div><div><code>r[4]</code><span>模型预测的日前 DA 价格</span></div><div><code>r[5]</code><span>样本外残差估计的价差 σ</span></div></div>
        <p className="fl-explanation">下载的运行器可以读取同一份兼容输入，在本地重现已发布的策略情景。</p>
      </section>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>训练、预测、模拟结果分别可追溯</h2><p>网页展示已运行的实验快照。完整重训在 Python 中执行；刷新网页只重新读取此版本的快照。</p></div></div><div className="fl-artifact-links">{hasForward && <a href={publicUrl(report.artifacts.forward)} download>真实生成时间的下一日预测<ArrowDownToLine size={14}/></a>}<a href={publicUrl(report.artifacts.history)} download>{optimized ? '开发期逐日前推重建结果' : '留出集逐日前推重建结果'}<ArrowDownToLine size={14}/></a><a href={publicUrl(report.artifacts.models)} download>模型参数与结构<ArrowDownToLine size={14}/></a>{simulation && <a href={`${ROOT}simulation-summary.json`} download>Python 策略实际运行结果<ArrowDownToLine size={14}/></a>}<a href={`${ROOT}report.json`} download>模型比较与误差报告<ArrowDownToLine size={14}/></a><a href={`${ROOT}data-audit.json`} download>本版本数据范围审计<ArrowDownToLine size={14}/></a></div><p className="fl-explanation">历史测试保留理论决策截点与本次真实生成时间，明确标为历史重建；不会导入成当时已存在的外部预测。训练资料可复现计算，但后取的价格可能含官方修订版本。</p></section>
    </>}
    <details className="fl-method"><summary><ShieldCheck size={16}/>方法、适用边界与资料<ChevronDown size={15}/></summary><div><p>{report.method.training}</p><p>{report.method.calibration}</p>{report.warnings.map((w,i)=><p key={i}>{w}</p>)}<p>数据指纹 <code>{report.sample.inputSha256}</code></p><div className="fl-reference-links">{report.sources.map(s=><a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title}<ExternalLink size={12}/></a>)}</div></div></details>
  </section>;
}


export default function ForecastLab() {
  const [version, setVersion] = useState<Version>('v4');
  const [initialTab, setInitialTab] = useState<Tab | undefined>();
  const choose = (next: Version, tab?: Tab) => {setInitialTab(tab); setVersion(next);};
  return <div className="forecast-lab">
    <div className="fl-version-bar cf-version-bar"><button type="button" className={`fl-button ${version==='v4'?'primary':'secondary'}`} aria-pressed={version==='v4'} onClick={()=>choose('v4')}>预测快照 <span className="cf-version-tag">V4</span></button><label className="fl-select">历史实验<select aria-label="历史实验版本" value={version==='v4'?'':version} onChange={event=>{if(event.target.value)choose(event.target.value as Version);}}><option value="">查看已保留的版本</option><option value="v3">V3 · 策略决策研究</option><option value="v2">V2 · 价格预测优化</option><option value="v1">V1 · 初始实验</option></select></label></div>
    {version==='v4' ? <CurrentForecast/> : version==='v3' ? <DecisionResearch onViewArchived={()=>choose('v2','forward')}/> : <VersionedForecastLab key={`${version}-${initialTab ?? 'default'}`} version={version} initialTab={initialTab} onFallback={()=>choose('v1')}/>}
  </div>;
}
