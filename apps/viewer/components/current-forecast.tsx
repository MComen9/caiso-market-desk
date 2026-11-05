'use client';

import { publicUrl } from '@/lib/public-url';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, CheckCircle2, ChevronDown, Clock3, Code2, Database, FileJson, Info, LoaderCircle, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { HUBS } from '@/lib/types';
import type { ForecastSimulation, ModelForecastBundle, ModelForecastPoint } from '@/lib/forecast-lab-types';
import type { CurrentForecastExperiment } from '@/lib/current-forecast-types';

const ROOT = publicUrl('/data/forecast-lab/v4/');
type View = 'forecast' | 'evaluation' | 'files';
type Metric = 'da' | 'fmm' | 'spread';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const num = (value: number | null | undefined, digits = 2) => finite(value) ? value.toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}) : '—';
const percent = (value: number | null | undefined) => finite(value) ? `${num(value * 100, 1)}%` : '—';
const nodeName = (node: string) => HUBS.find(hub => hub.id === node)?.short || node;
const beijing = (value: string) => new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(value));
const metricName: Record<Metric, string> = {da: '日前价 DA', fmm: '实时价 FMM', spread: '价差 FMM−DA'};
const valueOf = (point: ModelForecastPoint, metric: Metric) => metric === 'da' ? point.predictedDa : metric === 'fmm' ? point.predictedFmm : point.predictedSpread;

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(publicUrl(url), {cache: 'no-store', credentials: 'same-origin', signal});
  if (!response.ok) throw new Error(`结果读取未完成（HTTP ${response.status}）。请重新读取。`);
  return response.json();
}

function validateResults(report: CurrentForecastExperiment, forecast: ModelForecastBundle, simulation: ForecastSimulation | null) {
  if (!report?.sample?.nodes?.length || !report.selectedModels?.da || !report.selectedModels?.spread || !report.holdout?.selected || !report.holdout?.baseline || !report.method || !report.artifacts) throw new Error('预测报告格式不完整，请重新读取。');
  if (!Array.isArray(forecast.points) || report.modelVersion !== forecast.modelVersion || report.forecast.rows !== forecast.points.length) throw new Error('报告和预测版本不一致，请重新读取。');
  if (!forecast.points.length) return;
  if (forecast.classification !== 'forward_forecast') throw new Error('当前批次不是已发布的前向预测，请重新读取。');
  const cutoff = Date.parse(report.forecast.decisionAsOfUtc);
  if (!Number.isFinite(cutoff) || Date.parse(forecast.generatedAt) > cutoff || !Number.isFinite(Date.parse(forecast.generatedAt))) throw new Error('预测发布时间未通过截点校验。');
  const seen = new Set<string>();
  for (const point of forecast.points) {
    const key = `${point.node}|${point.startUtc}`;
    const issued = Date.parse(point.issuedAt), training = Date.parse(point.trainingEndUtc || '');
    if (seen.has(key) || !report.sample.nodes.includes(point.node) || point.localDate !== report.forecast.targetDate || point.modelVersion !== report.modelVersion || ![point.predictedDa, point.predictedFmm, point.predictedSpread].every(finite) || Math.abs(point.predictedFmm - point.predictedDa - point.predictedSpread) > 1e-7 || point.actualDa !== null || point.actualFmm !== null || point.actualSpread !== null || !Number.isFinite(issued) || !Number.isFinite(training) || training > issued || issued > cutoff) throw new Error('预测批次的时段、数值或时间证据校验未通过。');
    seen.add(key);
  }
  const clocks = report.sample.nodes.map(node => forecast.points.filter(point => point.node === node).sort((a, b) => a.startUtc.localeCompare(b.startUtc)));
  const reference = clocks[0].map(point => point.startUtc).join('|');
  if (clocks.some(points => points.map(point => point.startUtc).join('|') !== reference || ![23, 24, 25].includes(points.length) || points[0].localHour !== '00:00' || points[points.length - 1].localHour !== '23:00' || points.some((point, index) => Date.parse(point.endUtc) - Date.parse(point.startUtc) !== 3600000 || (index > 0 && Date.parse(point.startUtc) - Date.parse(points[index - 1].startUtc) !== 3600000)))) throw new Error('逐小时预测不完整，无法作为本批次输入。');
  if (simulation && (simulation.forecastDigest !== forecast.digest || simulation.forecastDate !== report.forecast.targetDate || simulation.forward?.pnl !== null)) throw new Error('预测与模拟输入版本不一致，请重新读取。');
}

function PredictionCurve({points, metric}: {points: ModelForecastPoint[]; metric: Metric}) {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [points, metric]);
  const lower = (point: ModelForecastPoint) => metric === 'da' ? point.daLow80 : metric === 'spread' ? point.spreadLow80 : null;
  const upper = (point: ModelForecastPoint) => metric === 'da' ? point.daHigh80 : metric === 'spread' ? point.spreadHigh80 : null;
  const values = points.flatMap(point => [valueOf(point, metric), lower(point), upper(point)]).filter(finite);
  if (!points.length || !values.length) return <div className="fl-empty">该枢纽暂未提供预测。</div>;
  const W = 960, H = 280, L = 62, R = 22, T = 25, B = 38;
  const min = Math.min(...values, ...(metric === 'spread' ? [0] : [])), max = Math.max(...values, ...(metric === 'spread' ? [0] : []));
  const pad = Math.max((max - min) * .12, 2), lo = min - pad, hi = max + pad;
  const x = (index: number) => L + index / Math.max(points.length - 1, 1) * (W - L - R);
  const y = (value: number) => T + (hi - value) / (hi - lo) * (H - T - B);
  const curve = points.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(valueOf(point, metric))}`).join(' ');
  const hasBand = points.every(point => finite(lower(point)) && finite(upper(point)));
  const band = hasBand ? points.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(upper(point)!)}`).join(' ') + [...points].reverse().map((point, index) => `L${x(points.length - index - 1)},${y(lower(point)!)}`).join(' ') + 'Z' : '';
  const selectedIndex = hover === null ? null : Math.min(hover, points.length - 1), selected = selectedIndex === null ? null : points[selectedIndex];
  return <div className="fl-curve cf-curve" tabIndex={0} aria-label={`${metricName[metric]}逐小时预测。使用左右方向键查看时段。`} onKeyDown={event => {if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault(); setHover(index => event.key === 'ArrowRight' ? Math.min((index ?? -1) + 1, points.length - 1) : Math.max((index ?? 1) - 1, 0));}}}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${nodeName(points[0].node)} ${metricName[metric]}，美元每兆瓦时`} onMouseMove={event => {const rect = event.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(points.length - 1, Math.round(((event.clientX - rect.left) / rect.width * W - L) / (W - L - R) * (points.length - 1)))));}} onMouseLeave={() => setHover(null)}>
      <text x={L} y="13" className="fl-axis">$/MWh</text>
      {[0, 1, 2, 3, 4].map(index => {const value = lo + (hi - lo) * index / 4; return <g key={index}><line x1={L} x2={W - R} y1={y(value)} y2={y(value)} stroke="#e5ece3" strokeDasharray="3 5"/><text x={L - 10} y={y(value) + 4} textAnchor="end" className="fl-axis">{num(value, 1)}</text></g>;})}
      {lo < 0 && hi > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#a4b7a8" strokeDasharray="5 4"/>}
      {hasBand && <path d={band} fill="#4e8f6b" fillOpacity=".13"/>}<path d={curve} fill="none" stroke={metric === 'fmm' ? '#6985a0' : '#337c59'} strokeWidth="2.5" strokeLinejoin="round"/>
      {points.map((point, index) => (index % 4 === 0 || index === points.length - 1) && <text key={point.startUtc} x={x(index)} y={H - 12} textAnchor="middle" className="fl-axis">{point.localHour}</text>)}
      {selected && selectedIndex !== null && <g><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={T} y2={H - B} stroke="#8aa18c" strokeDasharray="3 3"/><circle cx={x(selectedIndex)} cy={y(valueOf(selected, metric))} r="4" fill="#337c59" stroke="white" strokeWidth="2"/></g>}
    </svg>
    <div className="fl-chart-caption">{selected ? <><strong>{selected.localHour} PT · UTC{selected.utcOffset}</strong><span>{metricName[metric]} {num(valueOf(selected, metric))}</span>{hasBand && <span>经验区间 [{num(lower(selected))}, {num(upper(selected))}]</span>}</> : <><span><i className={`fl-key line ${metric === 'fmm' ? 'cf-fmm-key' : ''}`}/>点预测</span>{hasBand && <span><i className="fl-key band"/>经验 80% 区间</span>}<span>悬停或用方向键查看 · 小时起点 PT</span></>}</div>
  </div>;
}

export default function CurrentForecast() {
  const [report, setReport] = useState<CurrentForecastExperiment | null>(null);
  const [forward, setForward] = useState<ModelForecastBundle | null>(null);
  const [simulation, setSimulation] = useState<ForecastSimulation | null>(null);
  const [view, setView] = useState<View>('forecast'), [metric, setMetric] = useState<Metric>('da');
  const [node, setNode] = useState<string>(HUBS[0].id);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0), [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    Promise.all([readJson<CurrentForecastExperiment>(`${ROOT}report.json`, controller.signal), readJson<ModelForecastBundle>(`${ROOT}forecast-forward.json`, controller.signal), readJson<ForecastSimulation>(`${ROOT}simulation-summary.json`, controller.signal).catch(() => null)])
      .then(([nextReport, nextForward, nextSimulation]) => {
        if (controller.signal.aborted) return;
        validateResults(nextReport, nextForward, nextSimulation);
        setReport(nextReport); setForward(nextForward); setSimulation(nextSimulation);
        setNode(current => nextReport.sample.nodes.includes(current) ? current : nextReport.sample.nodes[0]);
      })
      .catch(reason => {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '预测结果读取失败。');})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [refresh]);

  const points = useMemo(() => forward?.points.filter(point => point.node === node).sort((a, b) => a.startUtc.localeCompare(b.startUtc)) || [], [forward, node]);

  if (loading && !report) return <section className="fl-loading"><LoaderCircle size={25} className="fl-spin"/><strong>正在读取本轮预测</strong><span>逐小时结果、模型评估与模拟输入一并载入</span></section>;
  if (!report || !forward) return <section className="fl-loading"><Info size={25}/><strong>{error || '当前预测结果尚未发布'}</strong><button className="fl-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></section>;

  const hasForward = forward.classification === 'forward_forecast' && forward.points.length > 0;
  const mean = (selected: Metric) => points.length ? points.reduce((sum, point) => sum + valueOf(point, selected), 0) / points.length : null;
  const selected = report.holdout.selected, baseline = report.holdout.baseline;
  const comparison = (current: number, previous: number) => previous > 0 ? `${current <= previous ? '下降' : '增加'} ${num(Math.abs(current - previous) / previous * 100, 1)}%` : '基线为零';
  const evaluation = report.splits.holdout;
  const fees = simulation?.feeSensitivity1PerMWh;
  const file = (name: string) => `${ROOT}${name}`;

  return <section className="cf-current" aria-label="逐小时价格预测">
    <header className="fl-heading"><div><span className="fl-eyebrow">CAISO · PRICE FORECAST</span><h1>逐小时价格预测</h1><p>查看已发布的价格曲线、预测区间和开发评估；交易日按太平洋时间显示。</p></div><button className="fl-button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? <LoaderCircle size={15} className="fl-spin"/> : <RefreshCw size={15}/>}重读快照</button></header>
    <div className="fl-context cf-context"><span><Clock3 size={14}/>生成于 {beijing(forward.generatedAt)} 北京时间</span><span><Database size={14}/>{report.sample.days} 天 · {report.sample.rows.toLocaleString()} 条节点小时</span><span>输入截至 {report.forecast.trainingThrough} PT · D−{report.method.featureDelayDays}</span></div>
    <nav className="fl-tabs" aria-label="当前预测视图">{([{id: 'forecast', label: '预测结果', icon: Play}, {id: 'evaluation', label: '模型验证', icon: ShieldCheck}, {id: 'files', label: '下载与复现', icon: Code2}] as const).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><item.icon size={15}/>{item.label}</button>)}</nav>
    {error && <div className="fl-notice warning" role="alert"><Info size={17}/><span>{error}{report && ' 下方保留最近一次成功读取的结果。'}</span></div>}

    {view === 'forecast' && <>
      <div className="cf-result-toolbar"><div><span className="cf-date-label">预测交易日 · 太平洋时间</span><h2>{report.forecast.targetDate}</h2><span className="fl-badge">{hasForward ? `${forward.points.length} 条已生成预测` : '预测未生成'}</span></div><label className="fl-select">枢纽<select aria-label="当前预测枢纽" value={node} onChange={event => setNode(event.target.value)}>{report.sample.nodes.map(item => <option key={item} value={item}>{nodeName(item)}</option>)}</select></label></div>
      {hasForward ? <>
        <div className="cf-price-metrics">{(['da', 'fmm', 'spread'] as const).map(item => <button type="button" key={item} aria-pressed={metric === item} className={metric === item ? 'active' : ''} onClick={() => setMetric(item)}><span>{nodeName(node)} · {metricName[item]}日均预测</span><strong>{num(mean(item))}<small>$/MWh</small></strong><span>查看逐小时曲线<ArrowRight size={12}/></span></button>)}</div>
        <section className="fl-panel"><div className="fl-panel-heading"><div><h2>{nodeName(node)} · {metricName[metric]}</h2><p>日均值仅作概览，策略使用下方完整小时曲线。</p></div><div className="fl-segment" role="group" aria-label="预测曲线指标">{(['da', 'fmm', 'spread'] as const).map(item => <button key={item} aria-pressed={metric === item} className={metric === item ? 'active' : ''} onClick={() => setMetric(item)}>{metricName[item]}</button>)}</div></div><PredictionCurve points={points} metric={metric}/><p className="fl-explanation">{metric === 'fmm' ? 'FMM 点预测由日前价与价差预测相加。本版未单独估计 FMM 预测区间。' : <>阴影为经验 80% 区间；开发评估的实际覆盖率为 {percent(metric === 'da' ? report.holdout.intervals.daCoverage80 : report.holdout.intervals.spreadCoverage80)}。区间反映预测误差，不能解释为获利概率。</>}</p></section>
        <div className="fl-handoff"><div><CheckCircle2 size={23}/><span><strong>{simulation?.forward ? `模拟输入已生成 · 计划 ${num(simulation.forward.gross)} MWh` : '已发布模拟输入'}</strong><small>顺势 · k=0.5 · 12 MWh/日 · 固定 $1/MWh 费用情景</small></span></div><div className="fl-actions"><a className="fl-button secondary" href={publicUrl(report.artifacts.pythonInput || file('embedded-data.json'))} download><ArrowDownToLine size={15}/>下载 Python 输入</a><a className="fl-button primary" href={publicUrl('/#prices/strategy')}>查看模拟结果<ArrowRight size={15}/></a></div></div>
        <p className="fl-small">该快照按 {beijing(report.forecast.decisionAsOfUtc)} 北京时间的研究截点生成；发布时实际价格和损益尚未形成。{simulation?.forward?.gross === 0 && <>预测已齐全，信号未超过当前策略门槛；{num(simulation.forward.unallocatedMWh)} MWh 研究预算保持未分配。</>}</p>
        <details className="fl-panel fl-diagnostic-details cf-hourly"><summary>逐小时预测明细<span>{nodeName(node)} · {points.length} 个时段 · $/MWh</span></summary><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>小时起点 PT</th><th>日前价 DA</th><th>实时价 FMM</th><th>价差 FMM−DA</th><th>价差经验区间</th></tr></thead><tbody>{points.map(point => <tr key={point.startUtc}><td><strong>{point.localHour}</strong><small>UTC{point.utcOffset}</small></td><td>{num(point.predictedDa)}</td><td>{num(point.predictedFmm)}</td><td className={point.predictedSpread < 0 ? 'fl-negative' : 'fl-positive'}>{num(point.predictedSpread)}</td><td>[{num(point.spreadLow80)}, {num(point.spreadHigh80)}]</td></tr>)}</tbody></table></div><div className="fl-panel-footer"><a className="fl-text-link" href={publicUrl(report.artifacts.forwardCsv || file('forward-predictions.csv'))} download>下载全部枢纽 CSV<ArrowDownToLine size={14}/></a></div></details>
      </> : <section className="fl-panel"><div className="fl-empty"><h2>本批次未生成前向预测</h2><p>{report.forecast.reason || '当前批次仅包含历史开发评估。'}</p><button className="fl-button" onClick={() => setView('evaluation')}>查看已完成的模型验证</button></div></section>}
    </>}

    {view === 'evaluation' && <>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>连续时间开发评估</h2><p>{evaluation.startDate} — {evaluation.endDate} PT · {evaluation.days} 天 · 相同日期、相同数据范围比较</p></div><span className="fl-badge muted">历史重建</span></div><div className="fl-table-scroll"><table className="fl-table cf-evaluation-table"><thead><tr><th>预测目标</th><th>本轮选择</th><th>模型 MAE</th><th>基线 MAE</th><th>相对基线</th><th>模型 RMSE</th></tr></thead><tbody>{(['da', 'spread'] as const).map(target => <tr key={target}><td><strong>{metricName[target]}</strong></td><td className="fl-wrap">{report.selectedModels[target].label}</td><td>{num(selected[target].mae)}</td><td>{num(baseline[target].mae)}</td><td>{comparison(selected[target].mae, baseline[target].mae)}</td><td>{num(selected[target].rmse)}</td></tr>)}</tbody></table></div><p className="fl-explanation">误差单位为 $/MWh。基线与模型使用同一评价窗口；旧历史已用于方法开发，这些结果不作为新的独立测试。预测质量与模拟收益分别评价。</p></section>
      <div className="cf-evaluation-facts"><article><span>日前价经验区间覆盖</span><strong>{percent(report.holdout.intervals.daCoverage80)}</strong><small>名义覆盖率 80%</small></article><article><span>价差经验区间覆盖</span><strong>{percent(report.holdout.intervals.spreadCoverage80)}</strong><small>名义覆盖率 80%</small></article><article><span>价差有信号时方向准确率</span><strong>{percent(selected.spread.conditionalSignAccuracy)}</strong><small>信号覆盖 {percent(selected.spread.signalRate)}</small></article></div>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>模型选择与时间划分</h2><p>{report.method.selectionRule}</p></div></div><div className="fl-splits">{([{id: 'validation', label: '模型选择'}, {id: 'calibration', label: '区间校准'}, {id: 'holdout', label: '开发评估'}] as const).map(split => <div key={split.id}><span>{split.label}</span><strong>{report.splits[split.id].startDate} — {report.splits[split.id].endDate}</strong><small>{report.splits[split.id].days} 天</small></div>)}</div><div className="fl-table-scroll"><table className="fl-table"><thead><tr><th>候选模型</th><th>选型期 DA MAE</th><th>选型期价差 MAE</th><th>开发期 DA MAE</th><th>开发期价差 MAE</th></tr></thead><tbody>{report.candidates.map(candidate => <tr key={candidate.id}><td><strong>{candidate.label}</strong><small>{[candidate.id === report.selectedModels.da.id ? '已选 DA' : '', candidate.id === report.selectedModels.spread.id ? '已选价差' : ''].filter(Boolean).join(' · ')}</small></td><td>{num(candidate.validation.da.mae)}</td><td>{num(candidate.validation.spread.mae)}</td><td>{num(candidate.holdout.da.mae)}</td><td>{num(candidate.holdout.spread.mae)}</td></tr>)}</tbody></table></div></section>
      {simulation && fees && <section className="fl-panel"><div className="fl-panel-heading"><div><h2>固定策略与费用情景</h2><p>同一开发评估窗口 · 顺势 k=0.5 · 每模拟成交 MWh 扣 $1</p></div><a className="fl-text-link" href={file('holdout-fee-1-sensitivity.json')} download>逐笔结果<ArrowDownToLine size={14}/></a></div><div className="fl-simulation-metrics"><div><span>情景损益</span><strong className={fees.total < 0 ? 'fl-negative' : ''}>${num(fees.total)}</strong><small>已扣假设费用 ${num(fees.fees)}</small></div><div><span>最大回撤</span><strong>${num(fees.maxdd)}</strong><small>累计美元损益回撤</small></div><div><span>模拟成交量</span><strong>{num(fees.filled)} MWh</strong><small>{simulation.holdout.noSignalDays} 个无信号日 · {simulation.holdout.evaluatedDays} 个完整评价日</small></div></div><p className="fl-explanation">报价交叉与成交量均按固定研究规则计算；$1/MWh 是统一费用假设，结果不是账户完整结算。保持原策略参数，不按本窗口收益更换赢家。</p></section>}
      <details className="fl-method"><summary><ShieldCheck size={16}/>输入范围与复现说明<ChevronDown size={15}/></summary><div><p>{report.method.training}</p><p>{report.method.calibration}</p><p>输入按 D−{report.method.featureDelayDays} 截断；历史重建使用本次取得的价格版本，不表示模型当时已发布。</p><p>{report.featureAudit.filter(item => item.status === 'included' || item.status === 'used').map(item => item.source).join('；') || '本轮使用历史 DAM／FMM 价格、滞后统计、跨枢纽价格和日历特征。'}</p><p>模型版本 <code>{report.modelVersion}</code></p><p>输入指纹 <code>{report.sample.inputSha256}</code></p><a className="fl-text-link" href={file('report.json')} download>下载完整评估与方法说明<ArrowDownToLine size={14}/></a></div></details>
    </>}

    {view === 'files' && <>
      <section className="fl-panel"><div className="fl-panel-heading"><div><h2>同一批预测，可查看也可直接运行</h2><p>{report.forecast.targetDate} PT · {report.modelVersion}</p></div><Code2 size={23}/></div><div className="fl-download-grid cf-download-grid"><a href={file('forecast-csv.html')}><ArrowDownToLine size={22}/><strong>逐小时预测 CSV</strong><span>查看、复制或下载三个枢纽的完整逐小时预测</span></a><a href={publicUrl(report.artifacts.forward)} download><FileJson size={22}/><strong>预测 JSON</strong><span>完整预测批次、发布时间与模型版本</span></a><a href={publicUrl(report.artifacts.pythonInput || file('embedded-data.json'))} download><Database size={22}/><strong>Python 模拟输入</strong><span>已适配 meta / nodes / series；未来实际值为空</span></a><a href={publicUrl(report.artifacts.runner || file('trading_strategy.py'))} download><Play size={22}/><strong>Python 运行器</strong><span>读取同一份输入，生成固定策略计划</span></a><a href={publicUrl(report.artifacts.package || file('caiso-current-forecast.zip'))} download><Code2 size={22}/><strong>完整可复现工程</strong><span>数据、训练脚本、预测与模拟结果</span></a><a href={file('report.json')} download><ShieldCheck size={22}/><strong>模型验证报告</strong><span>时间划分、基线比较与模型选择依据</span></a></div><div className="fl-code-block"><span>把运行器和输入放在同一目录，运行固定 $1/MWh 情景</span><pre><code>{`python trading_strategy.py --data embedded-data.json --date ${report.forecast.targetDate} --strategy normal --k 0.5 --fee-per-mwh 1`}</code></pre></div><p className="fl-explanation">本页展示已经发布的固定批次。下载的输入与网页采用同一预测版本，完整工程包含重新训练所需文件。</p></section>
      <div className="fl-artifact-links"><a href={publicUrl(report.artifacts.models)} download>模型参数与结构<ArrowDownToLine size={14}/></a><a href={publicUrl(report.artifacts.protocol || file('protocol.json'))} download>冻结的实验协议<ArrowDownToLine size={14}/></a><a href={publicUrl(report.artifacts.history)} download>历史开发预测<ArrowDownToLine size={14}/></a><a href={file('simulation-summary.json')} download>Python 模拟摘要<ArrowDownToLine size={14}/></a></div>
    </>}
  </section>;
}
