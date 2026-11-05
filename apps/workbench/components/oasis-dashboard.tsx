'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowLeftRight, ArrowUpRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Database, ExternalLink, FileText, Info, Layers3, LoaderCircle, RefreshCw, Search, ShieldCheck, Table2, X, Zap } from 'lucide-react';
import { HUBS, MARKET_LABELS, type BootstrapData, type Market, type MarketResponse, type PriceInterval } from '@/lib/types';
import { buildHourlyRows } from '@/lib/analytics';
import { addDays, localDayStartUtc } from '@/lib/time';
import StrategyLab from '@/components/strategy-lab';
import ForecastLab from '@/components/forecast-lab';

type Markets = Partial<Record<Market, MarketResponse>>;
type View = 'overview' | 'spread' | 'table' | 'strategy' | 'prediction';
type Resolution = 'hour' | 'FMM' | 'RTD';
type Zone = 'America/Los_Angeles' | 'Asia/Shanghai' | 'UTC';
type HourRow = ReturnType<typeof buildHourlyRows>[number];
type ChartRow = { startUtc: string; dam: number | null; fmm: number | null; rtd: number | null; spread: number | null };
type SeriesKey = 'dam' | 'fmm' | 'rtd';
const ORDER: Market[] = ['DAM', 'FMM', 'RTD'];
const SERIES = { dam: { label: '日前 DA', color: '#247a79' }, fmm: { label: 'FMM', color: '#d59450' }, rtd: { label: '实时 RTD', color: '#6d83b4' } };
const ZONES: Record<Zone, string> = { 'America/Los_Angeles': '太平洋时间 PT', 'Asia/Shanghai': '北京时间', UTC: 'UTC' };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const average = (v: (number | null | undefined)[]) => { const n = v.filter(finite); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; };
const fmt = (v: number | null | undefined, n = 2) => finite(v) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: n, maximumFractionDigits: n }).format(v) : '—';
const signfmt = (v: number | null | undefined) => finite(v) ? `${v > 0 ? '+' : ''}${fmt(v)}` : '—';
const shiftDate = (date: string, shift: number) => new Date(Date.parse(`${date}T12:00:00Z`) + shift * 86400000).toISOString().slice(0, 10);
function currentPTDate() { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return `${p.find(x => x.type === 'year')?.value}-${p.find(x => x.type === 'month')?.value}-${p.find(x => x.type === 'day')?.value}`; }
function timeLabel(utc: string, zone: Zone, withDate = false) { if (!utc) return '—'; return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(utc)); }
function fullTimestamp(utc: string) { if (!utc) return '尚未获取'; return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(utc)); }
function utcHour(utc: string) { return new Date(Math.floor(Date.parse(utc) / 3600000) * 3600000).toISOString(); }
function csvEscape(v: unknown) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function downloadCSV(name: string, columns: string[], rows: unknown[][]) { const body = '\ufeff' + [columns, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n'); const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' })); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function MiniLine({ values, color = '#247a79' }: { values: (number | null)[]; color?: string }) { const good = values.filter(finite); if (good.length < 2) return <div className="spark-empty" />; const lo = Math.min(...good), span = Math.max(...good) - lo || 1; let d = '', open = false; values.forEach((v, i) => { if (!finite(v)) { open = false; return; } const x = 2 + i / Math.max(values.length - 1, 1) * 112, y = 34 - (v - lo) / span * 29; d += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `; open = true; }); return <svg className="mini-line" viewBox="0 0 118 40" aria-hidden="true"><path d={d} fill="none" stroke={color} strokeWidth="1.9" strokeLinejoin="round" /></svg>; }

function PriceChart({ rows, zone, spread, enabled, onSelect }: { rows: ChartRow[]; zone: Zone; spread: boolean; enabled: Record<SeriesKey, boolean>; onSelect: (utc: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const keys = (Object.keys(SERIES) as SeriesKey[]).filter(k => enabled[k]);
  const values = rows.flatMap(r => spread ? [r.spread] : keys.map(k => r[k])).filter(finite);
  if (!rows.length || !values.length) return <div className="chart-empty"><Activity size={34} strokeWidth={1.3} /><strong>当前条件下暂无可展示的数据</strong><span>选择已载入的节点，或点击“查询 OASIS”获取数据。</span></div>;
  const W = 1040, H = 330, L = 56, R = 18, T = 24, B = 40, pw = W - L - R, ph = H - T - B;
  const lower = Math.min(...values, ...(spread ? [0] : [])), upper = Math.max(...values, ...(spread ? [0] : []));
  const span = Math.max(upper - lower, 10), pad = span * .13, min = lower - pad, max = upper + pad;
  const x = (i: number) => L + i / Math.max(rows.length - 1, 1) * pw;
  const y = (v: number) => T + (max - v) / (max - min) * ph;
  const pathFor = (key: SeriesKey) => { let d = '', open = false; rows.forEach((r, i) => { const v = r[key]; if (!finite(v)) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)} `; open = true; }); return d; };
  const ticks = Array.from({ length: Math.min(7, rows.length) }, (_, i) => Math.round(i * (rows.length - 1) / Math.max(Math.min(7, rows.length) - 1, 1)));
  const isMulti = Date.parse(rows.at(-1)!.startUtc) - Date.parse(rows[0].startUtc) >= 86400000;
  const hovered = hover == null ? null : rows[Math.min(hover, rows.length - 1)];
  const hoveredIndex = hover == null ? 0 : Math.min(hover, rows.length - 1);
  return <div className="chart-surface" tabIndex={0} role="group" aria-label="价格曲线。左右方向键查看时间点，回车打开明细。" onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setHover(h => Math.min((h ?? -1) + 1, rows.length - 1)); } if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(h => Math.max((h ?? 1) - 1, 0)); } if (e.key === 'Enter' && hovered) onSelect(hovered.startUtc); }}>
    <svg viewBox={`0 0 ${W} ${H}`} className="price-chart" role="img" aria-label={spread ? 'FMM 小时均价减日前价格的价差曲线' : '日前、FMM 与实时价格曲线'} onMouseMove={e => { const rect = e.currentTarget.getBoundingClientRect(); const localX = (e.clientX - rect.left) / rect.width * W; setHover(Math.max(0, Math.min(rows.length - 1, Math.round((localX - L) / pw * (rows.length - 1))))); }} onMouseLeave={() => setHover(null)} onClick={() => hovered && onSelect(hovered.startUtc)}>
      <text x={L} y="11" className="chart-unit">$/MWh</text>
      {Array.from({ length: 5 }, (_, i) => { const value = min + (max - min) * i / 4, yy = y(value); return <g key={i}><line x1={L} x2={W - R} y1={yy} y2={yy} stroke="#e9eeed" strokeDasharray="3 5" /><text x={L - 12} y={yy + 4} textAnchor="end" className="axis-label">{value.toFixed(Math.abs(value) > 100 ? 0 : 1)}</text></g>; })}
      {ticks.map((i, pos) => <text key={`${i}-${pos}`} x={x(i)} y={H - 12} textAnchor={pos === 0 ? 'start' : pos === ticks.length - 1 ? 'end' : 'middle'} className="axis-label">{timeLabel(rows[i].startUtc, zone, isMulti)}</text>)}
      {min < 0 && max > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#b7c7c3" strokeDasharray="5 5" />}
      {spread ? rows.map((r, i) => finite(r.spread) && <rect key={r.startUtc} x={x(i) - Math.max(1.5, pw / rows.length * .30)} y={Math.min(y(r.spread), y(0))} width={Math.max(3, pw / rows.length * .60)} height={Math.max(1, Math.abs(y(r.spread) - y(0)))} rx={rows.length < 100 ? 2 : 0} fill={r.spread >= 0 ? '#2b9180' : '#cf7c6e'} opacity={hoveredIndex === i && hover !== null ? 1 : .79} />) : keys.map(key => <path key={key} d={pathFor(key)} fill="none" stroke={SERIES[key].color} strokeWidth={key === 'rtd' ? 1.65 : 2.3} strokeLinejoin="round" strokeLinecap="round" opacity={key === 'rtd' ? .75 : 1} />)}
      {hovered && <g><line x1={x(hoveredIndex)} x2={x(hoveredIndex)} y1={T} y2={H - B} stroke="#7f9993" strokeDasharray="3 3" />{!spread && keys.map(key => finite(hovered[key]) && <circle key={key} cx={x(hoveredIndex)} cy={y(hovered[key]!)} r="4" fill={SERIES[key].color} stroke="white" strokeWidth="2" />)}</g>}
    </svg>
    {hovered && <div className="chart-tooltip" style={{ left: `${Math.min(77, Math.max(5, x(hoveredIndex) / W * 100))}%` }}><strong>{timeLabel(hovered.startUtc, zone, true)}</strong>{spread ? <p><span>FMM − DA</span><b className={finite(hovered.spread) && hovered.spread < 0 ? 'negative' : 'positive'}>{signfmt(hovered.spread)}</b></p> : keys.map(key => <p key={key}><span><i style={{ background: SERIES[key].color }} />{SERIES[key].label}</span><b>{fmt(hovered[key])}</b></p>)}<small>点击查看原始时段</small></div>}
  </div>;
}

export default function OasisDashboard({ bootstrap, embedded = false }: { bootstrap: BootstrapData; embedded?: boolean }) {
  const [view, setView] = useState<View>('overview');
  const [strategyOpened, setStrategyOpened] = useState(false);
  const [predictionOpened, setPredictionOpened] = useState(false);
  const [strategyRunId, setStrategyRunId] = useState('');
  const [markets, setMarkets] = useState<Markets>(bootstrap.markets);
  const [node, setNode] = useState<string>(HUBS[0].id);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [start, setStart] = useState(bootstrap.endDate);
  const [end, setEnd] = useState(bootstrap.endDate);
  const [active, setActive] = useState({ start: bootstrap.endDate, end: bootstrap.endDate });
  const [zone, setZone] = useState<Zone>('America/Los_Angeles');
  const [resolution, setResolution] = useState<Resolution>('hour');
  const [mode, setMode] = useState<'snapshot' | 'api'>('snapshot');
  const [busy, setBusy] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState<Market | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Market, string>>>({});
  const [formError, setFormError] = useState('');
  const [drawer, setDrawer] = useState<'sources' | 'help' | null>(null);
  const [detailUtc, setDetailUtc] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>({ dam: true, fmm: true, rtd: true });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('time');
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const queryRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!embedded) return;
    const readView = () => { const match = /^#prices\/(overview|spread|table|strategy|prediction)$/.exec(window.location.hash); if (match) { const next = match[1] as View; setView(next); if (next === 'strategy') setStrategyOpened(true); if (next === 'prediction') setPredictionOpened(true); if (next === 'spread') setResolution('hour'); } };
    readView(); window.addEventListener('hashchange', readView); return () => window.removeEventListener('hashchange', readView);
  }, [embedded]);
  useEffect(() => {
    const selectNode = (event: Event) => {
      const next = (event as CustomEvent<{node?: string}>).detail?.node;
      if (next && HUBS.some(hub => hub.id === next)) { setNode(next); setShowCustom(false); setDetailUtc(null); }
    };
    window.addEventListener('caiso:select-node', selectNode);
    return () => window.removeEventListener('caiso:select-node', selectNode);
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { setPage(1); setDetailUtc(null); }, [node, active.start, active.end, resolution, view, sort]);
  useEffect(() => { if (!drawer && !detailUtc) return; const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; const trap = (e: KeyboardEvent) => { if (e.key !== 'Tab') return; const elements = drawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }; document.addEventListener('keydown', trap); return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', trap); previous?.focus(); }; }, [drawer, detailUtc]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 2800); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawer(null); setDetailUtc(null); setMobileNav(false); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  const hourRows = useMemo(() => buildHourlyRows(markets, node, active.start, active.end), [markets, node, active]);
  const inRange = (r: PriceInterval) => r.node === node && r.localDate >= active.start && r.localDate <= active.end;
  const rawRows = useMemo(() => (resolution === 'hour' ? [] : markets[resolution]?.intervals.filter(r => r.node === node && r.localDate >= active.start && r.localDate <= active.end) || []).sort((a, b) => a.startUtc.localeCompare(b.startUtc)), [markets, resolution, node, active]);
  const chartRows = useMemo<ChartRow[]>(() => { if (resolution === 'hour' || view === 'spread') return hourRows; const hours = new Map(hourRows.map(r => [r.startUtc, r])); const indexed = new Map(rawRows.map(r => [r.startUtc, r])); const result: ChartRow[] = []; const step = (resolution === 'FMM' ? 15 : 5) * 60000; const endUtc = localDayStartUtc(addDays(active.end, 1)); for (let t = localDayStartUtc(active.start); t < endUtc; t += step) { const startUtc = new Date(t).toISOString(); const r = indexed.get(startUtc); const price = r?.quality === 'ok' ? r.price : null; result.push({ startUtc, dam: hours.get(utcHour(startUtc))?.dam ?? null, fmm: resolution === 'FMM' ? price : null, rtd: resolution === 'RTD' ? price : null, spread: null }); } return result; }, [hourRows, rawRows, resolution, view, active]);
  const paired = hourRows.filter(r => finite(r.dam) && finite(r.fmm));
  const daAvg = average(hourRows.map(r => r.dam)), fmmAvg = average(hourRows.map(r => r.fmm)), spreadAvg = average(paired.map(r => r.spread));
  const matched = paired.length, expected = hourRows.length;
  const validHours = hourRows.filter(r => finite(r.dam) || finite(r.fmm) || finite(r.rtd)).length;
  const activeNode = HUBS.find(h => h.id === node);
  const latestFetch = Object.values(markets).filter(Boolean).map(m => m!.fetchedAt).sort().at(-1) || '';
  const warnings = [...new Set(Object.values(markets).flatMap(m => m?.warnings || []))];
  const changed = start !== active.start || end !== active.end;
  const loadingLabel = loadingMarket ? `正在获取${MARKET_LABELS[loadingMarket]}…` : '准备查询…';
  const sortedHours = useMemo(() => sort === 'spread' ? [...hourRows].sort((a, b) => (b.spread ?? -Infinity) - (a.spread ?? -Infinity)) : hourRows, [hourRows, sort]);
  const tableRows = resolution === 'hour' || view === 'spread' ? sortedHours : rawRows;
  const pageSize = 24, totalPages = Math.max(1, Math.ceil(tableRows.length / pageSize));
  const visibleRows = tableRows.slice((page - 1) * pageSize, page * pageSize);
  const detailHour = detailUtc ? hourRows.find(r => r.startUtc === utcHour(detailUtc)) : undefined;
  const selectedDetailRows = detailUtc ? ORDER.map(m => ({ market: m, rows: (markets[m]?.intervals || []).filter(r => inRange(r) && utcHour(r.startUtc) === utcHour(detailUtc)).sort((a, b) => a.startUtc.localeCompare(b.startUtc)) })) : [];
  const overallEmpty = !Object.values(markets).some(m => m?.ok && m.intervals.length);

  async function queryOasis(queryStart = start, queryEnd = end, queryNode = node) {
    setFormError('');
    const days = (Date.parse(queryEnd) - Date.parse(queryStart)) / 86400000 + 1;
    if (!queryStart || !queryEnd || !Number.isFinite(days) || days < 1 || days > 7) { setFormError('请选择连续 1—7 天，结束日期不能早于开始日期。'); return; }
    if (!/^[A-Z0-9_.-]{1,80}$/.test(queryNode)) { setFormError('节点代码仅支持英文字母、数字、下划线、点和连字符。'); return; }
    const nodes = HUBS.some(h => h.id === queryNode) ? HUBS.map(h => h.id) : [queryNode];
    abortRef.current?.abort(); const token = ++queryRef.current;
    setStart(queryStart); setEnd(queryEnd); setActive({ start: queryStart, end: queryEnd }); setMode('api'); setMarkets({}); setErrors({}); setBusy(true); setPage(1);
    for (const market of ORDER) {
      if (token !== queryRef.current) return;
      setLoadingMarket(market); const controller = new AbortController(); abortRef.current = controller; const timeout = setTimeout(() => controller.abort(), 70000);
      try {
        const qs = new URLSearchParams({ market, start: queryStart, end: queryEnd, nodes: nodes.join(',') });
        const response = await fetch(`/api/prices?${qs}`, { signal: controller.signal });
        const data = await response.json() as MarketResponse;
        if (token !== queryRef.current) return;
        if (!response.ok || !data.ok) throw new Error(data.error?.message || `请求未完成（${response.status}）`);
        setMarkets(prev => ({ ...prev, [market]: data }));
      } catch (error) {
        if (token !== queryRef.current) return;
        const msg = error instanceof Error && error.name === 'AbortError' ? '上游响应较慢，请稍后重试。' : error instanceof Error ? error.message : '暂时无法获取数据。';
        setErrors(prev => ({ ...prev, [market]: msg }));
      } finally { clearTimeout(timeout); }
      if (market !== 'RTD') await new Promise(resolve => setTimeout(resolve, 1300));
    }
    if (token === queryRef.current) { setBusy(false); setLoadingMarket(null); }
  }
  function loadSnapshot(range: 'day' | 'week' = 'day') { queryRef.current++; abortRef.current?.abort(); const s = range === 'week' ? bootstrap.startDate : bootstrap.endDate; setMarkets(bootstrap.markets); setStart(s); setEnd(bootstrap.endDate); setActive({ start: s, end: bootstrap.endDate }); setMode('snapshot'); setErrors({}); setFormError(''); setBusy(false); setLoadingMarket(null); if (!HUBS.some(h => h.id === node)) setNode(HUBS[0].id); }
  function chooseRecent(days: number) { const last = shiftDate(currentPTDate(), -1); void queryOasis(shiftDate(last, -(days - 1)), last); }
  function applyCustom() { const s = custom.trim().toUpperCase(); if (!/^[A-Z0-9_.-]{1,80}$/.test(s)) { setFormError('请输入有效的 OASIS 节点代码，例如 TH_NP15_GEN-APND。'); return; } setNode(s); setFormError(''); setShowCustom(false); void queryOasis(start, end, s); }
  function exportData() { const prefix = `${node}_${active.start}_${active.end}`; if (resolution === 'hour' || view === 'spread') downloadCSV(`${prefix}_hourly.csv`, ['node', 'start_utc', 'end_utc', 'display_timezone', 'display_time', 'DA_USD_MWh', 'FMM_hourly_USD_MWh', 'RTD_hourly_USD_MWh', 'FMM_minus_DA_USD_MWh', 'FMM_intervals', 'RTD_intervals', 'quality'], hourRows.map(r => [node, r.startUtc, r.endUtc, zone, timeLabel(r.startUtc, zone, true), r.dam, r.fmm, r.rtd, r.spread, r.fmmCount, r.rtdCount, r.quality])); else downloadCSV(`${prefix}_${resolution}.csv`, ['node', 'market', 'start_utc', 'end_utc', 'display_timezone', 'display_time', 'LMP_USD_MWh', 'MCE', 'MCC', 'MCL', 'MGHG', 'quality'], rawRows.map(r => [node, resolution, r.startUtc, r.endUtc, zone, timeLabel(r.startUtc, zone, true), r.price, r.components.MCE, r.components.MCC, r.components.MCL, r.components.MGHG, r.quality])); setToast('CSV 已导出，包含 UTC 时间与价格口径。'); }
  function navigate(next: View) { if (next === 'strategy') setStrategyOpened(true); if (next === 'prediction') setPredictionOpened(true); setView(next); if (next === 'spread') setResolution('hour'); setMobileNav(false); if (embedded) window.history.replaceState(null, '', `#prices/${next}`); }
  const rangeLabel = active.start === active.end ? active.end : `${active.start} — ${active.end}`;
  const displayedSeries = resolution === 'hour' ? enabled : { dam: enabled.dam, fmm: resolution === 'FMM' && enabled.fmm, rtd: resolution === 'RTD' && enabled.rtd };

  const Content = embedded ? 'section' : 'main';
  return <div className={`oasis-app ${embedded ? 'oasis-embedded' : ''}`}>
    {!embedded && <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <a href="/" className="brand" aria-label="OASIS 市场数据台首页"><span className="brand-icon"><Zap size={22} fill="currentColor" strokeWidth={1.2} /></span><span>OASIS<span className="brand-small">MARKET OBSERVATORY</span></span></a>
      <div className="workspace"><span className="workspace-avatar">CA</span><div><strong>CAISO 市场</strong><span>California · 美国</span></div><ChevronDown size={14} /></div>
      <p className="nav-eyebrow">市场工作台</p>
      <nav className="main-nav" aria-label="主要导航">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => navigate('overview')}><Activity size={18} /><span>市场总览</span><span className="nav-dot" /></button>
        <button className={view === 'spread' ? 'active' : ''} onClick={() => navigate('spread')}><ArrowLeftRight size={18} /><span>价差分析</span></button>
        <button className={view === 'table' ? 'active' : ''} onClick={() => navigate('table')}><Table2 size={18} /><span>数据明细</span></button>
      </nav>
      <p className="nav-eyebrow nav-secondary">数据与口径</p>
      <nav className="main-nav"><button onClick={() => { setDrawer('sources'); setMobileNav(false); }}><Database size={18} /><span>来源与质量</span></button><button onClick={() => { setDrawer('help'); setMobileNav(false); }}><FileText size={18} /><span>指标说明</span></button><a href="https://oasis.caiso.com/mrioasis/logon.do" target="_blank" rel="noreferrer"><ExternalLink size={17} /><span>OASIS 官方平台</span><ArrowUpRight size={13} /></a></nav>
      <div className="sidebar-bottom"><div className="source-health"><span className="status-dot" /><div><strong>CAISO 官方公开数据</strong><span>可追溯的市场价格</span></div></div><div className="sidebar-note"><ShieldCheck size={16} /><span>你的市场研究工作台</span></div></div>
    </aside>}
    {!embedded && mobileNav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <div className="main-shell">
      {!embedded && <header className="topbar"><div className="breadcrumbs"><button className="mobile-menu" aria-label="打开导航" onClick={() => setMobileNav(true)}><Layers3 size={21} /></button><span>市场工作台</span><ChevronRight size={13} /><strong>{view === 'overview' ? '市场总览' : view === 'spread' ? '价差分析' : '数据明细'}</strong></div><div className="topbar-right"><span className="official-badge"><span />OASIS 官方来源</span><button className="icon-button" aria-label="查看指标说明" onClick={() => setDrawer('help')}><Info size={17} /></button><span className="profile-dot">研</span></div></header>}
      <Content className="main-content">
        {embedded && <nav className="price-subnav" aria-label="价格分析视图">{([{id:'overview', label:'价格走势'}, {id:'spread', label:'小时价差'}, {id:'table', label:'原始明细'}, {id:'prediction', label:'电价预测'}, {id:'strategy', label:'策略实验室'}] as const).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}<button className="price-method-button" onClick={() => setDrawer('help')}><Info size={15} />计算口径</button></nav>}
        {predictionOpened && <div hidden={view !== 'prediction'}><ForecastLab onOpenRun={id => {setStrategyRunId(id); navigate('strategy');}} /></div>}
        {strategyOpened && <div hidden={view !== 'strategy'}><StrategyLab bootstrap={bootstrap} initialRunId={strategyRunId} /></div>}
        <div hidden={view === 'strategy' || view === 'prediction'}>
        <div className="page-heading"><div><div className="eyebrow">CALIFORNIA ELECTRICITY MARKET</div><h1>{view === 'spread' ? '日前与实时，价差一目了然。' : view === 'table' ? '每一个价格，都有据可查。' : embedded ? '节点价格分析' : 'CAISO 市场总览'}<span className="heading-tag">电价数据台</span></h1><p>从官方市场数据出发，查看节点电价、小时价差与价格构成。</p></div><button className="button secondary export-main" disabled={!validHours && !rawRows.length} onClick={exportData}><ArrowDownToLine size={16} />导出 CSV</button></div>
        <section className="query-panel" aria-label="数据筛选">
          <div className="query-dates"><span className="filter-label"><CalendarDays size={15} />交易日期 <small>PT</small></span><div className="date-inputs"><input type="date" aria-label="开始日期，太平洋时间" value={start} onChange={e => setStart(e.target.value)} /><span>至</span><input type="date" aria-label="结束日期，太平洋时间" value={end} onChange={e => setEnd(e.target.value)} /></div></div>
          <div className="quick-dates"><button onClick={() => loadSnapshot('day')} disabled={busy} className={mode === 'snapshot' && active.start === bootstrap.endDate ? 'selected' : ''}>已验证日</button><button onClick={() => loadSnapshot('week')} disabled={busy} className={mode === 'snapshot' && active.start === bootstrap.startDate && active.start !== active.end ? 'selected' : ''}>已验证 7 日</button><button onClick={() => chooseRecent(1)} disabled={busy}>最近完整日</button></div>
          <button className="button primary query-button" onClick={() => void queryOasis()} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}<span>{busy ? '正在查询' : '查询 OASIS'}</span></button>
        </section>
        {(formError || changed) && <div className={`inline-notice ${formError ? 'error' : ''}`}><Info size={15} /><span>{formError || `筛选条件已修改。当前仍显示 ${rangeLabel} 的数据，点击“查询 OASIS”应用。`}</span></div>}
        <div className="data-context"><span className={`context-label ${mode === 'api' ? 'api' : ''}`}><Database size={13} />{mode === 'snapshot' ? '已验证历史快照' : busy ? '正在读取 OASIS' : '本次 API 查询'}</span><span className="context-range">{rangeLabel}<span className="context-muted"> · 交易日按太平洋时间</span></span><button onClick={() => setDrawer('sources')} className="context-update"><Clock3 size={13} />抓取于 {fullTimestamp(latestFetch)} 北京时间<ChevronRight size={13} /></button></div>
        {busy && <div className="loading-strip" aria-live="polite"><LoaderCircle size={15} className="spin" /><span>{loadingLabel}</span><div className="fetch-stages">{ORDER.map(m => <span key={m} className={markets[m]?.ok ? 'done' : loadingMarket === m ? 'current' : errors[m] ? 'failed' : ''}>{markets[m]?.ok && <Check size={11} />}{m}</span>)}</div><small>按市场依次读取，请稍候</small></div>}
        {!!Object.keys(errors).length && <div className="fetch-errors" role="status"><Info size={17} /><div><strong>{overallEmpty ? '本次查询暂未获取数据' : '部分市场数据暂未获取'}</strong>{ORDER.filter(m => errors[m]).map(m => <p key={m}>{MARKET_LABELS[m]}：{errors[m]}</p>)}<span>已成功返回的数据仍可查看；缺失价格保留为空。</span></div><button onClick={() => loadSnapshot('day')}>查看已验证历史数据<ArrowUpRight size={14} /></button></div>}
        <section className="node-section"><div className="node-heading"><span>交易枢纽</span><small>点击切换节点</small></div><div className="node-tabs">{HUBS.map((h, index) => { const selected = node === h.id; return <button key={h.id} className={`node-tab ${selected ? 'selected' : ''}`} onClick={() => { setNode(h.id); setShowCustom(false); }}><span className="node-mark">{String(index + 1).padStart(2, '0')}</span><div><strong>{h.short}<span>{h.name}</span></strong><small>{h.id}</small></div>{selected ? <span className="node-check"><Check size={12} /></span> : <ChevronRight size={15} />}</button>; })}<button className={`custom-node-button ${!activeNode ? 'selected' : ''}`} onClick={() => setShowCustom(s => !s)}><Search size={17} /><span>{!activeNode ? node : '自定义节点'}</span></button></div>{showCustom && <form className="custom-node-form" onSubmit={e => { e.preventDefault(); applyCustom(); }}><input autoFocus aria-label="自定义 OASIS 节点代码" placeholder="输入完整节点代码，例如 TH_NP15_GEN-APND" value={custom} onChange={e => setCustom(e.target.value)} /><button className="button primary" disabled={busy}>查询节点<ArrowUpRight size={14} /></button><button type="button" className="icon-button" aria-label="关闭自定义节点" onClick={() => setShowCustom(false)}><X size={16} /></button></form>}</section>
        {view !== 'table' && <section className="metric-grid" aria-label="价格摘要">
          <article className="metric-card"><div className="metric-top"><span>日前市场均价</span><span className="metric-market">DA</span></div><div className="metric-main"><strong>{fmt(daAvg)}</strong><MiniLine values={hourRows.map(r => r.dam)} /></div><div className="metric-foot"><span>$/MWh</span><small>{hourRows.filter(r => finite(r.dam)).length} 个有效小时</small></div></article>
          <article className="metric-card"><div className="metric-top"><span>FMM 小时均价</span><span className="metric-market amber">FMM</span></div><div className="metric-main"><strong>{fmt(fmmAvg)}</strong><MiniLine values={hourRows.map(r => r.fmm)} color="#d59450" /></div><div className="metric-foot"><span>$/MWh</span><small>每小时需齐 4 个时段</small></div></article>
          <article className="metric-card spread-metric"><div className="metric-top"><span>平均小时价差</span><ArrowLeftRight size={16} /></div><div className="metric-main"><strong className={finite(spreadAvg) && spreadAvg < 0 ? 'negative' : 'positive'}>{signfmt(spreadAvg)}</strong><MiniLine values={hourRows.map(r => r.spread)} color={finite(spreadAvg) && spreadAvg < 0 ? '#c87468' : '#247a79'} /></div><div className="metric-foot"><span>FMM − DA · $/MWh</span><button onClick={() => setDrawer('help')} aria-label="查看价差口径"><Info size={13} /></button></div></article>
          <article className="metric-card quality-metric"><div className="metric-top"><span>可比小时完整度</span><ShieldCheck size={17} /></div><div className="metric-main"><strong>{matched}<span className="metric-denominator">/ {expected || '—'}</span></strong><span className={`quality-pill ${matched < expected ? 'partial' : ''}`}>{matched === expected && expected > 0 ? '完整' : matched > 0 ? '部分可比' : '待获取'}</span></div><div className="quality-track"><span style={{ width: `${expected ? matched / expected * 100 : 0}%` }} /></div><div className="metric-foot"><span>DA 与 FMM 完整对齐</span><button onClick={() => setDrawer('sources')} aria-label="查看数据质量详情"><ArrowUpRight size={14} /></button></div></article>
        </section>}
        {view !== 'table' && <section className="panel chart-panel"><div className="panel-heading"><div><div className="panel-title-row"><h2>{view === 'spread' ? '小时价差分布' : '价格走势'}</h2><span className="small-tag">{activeNode?.short || node}</span></div><p>{view === 'spread' ? '正值表示 FMM 高于日前；负值表示 FMM 低于日前。' : resolution === 'hour' ? '按小时对齐日前、FMM 与 RTD 价格，保留缺失时段。' : resolution === 'FMM' ? '展示官方 15 分钟 FMM 原始价格，日前价格按所属小时对照。' : '展示官方 5 分钟 RTD 原始价格，日前价格按所属小时对照。'}</p></div><div className="chart-controls">{view !== 'spread' && <div className="segment-control">{(['hour', 'FMM', 'RTD'] as Resolution[]).map(r => <button key={r} className={resolution === r ? 'active' : ''} onClick={() => setResolution(r)}>{r === 'hour' ? '小时' : r === 'FMM' ? '15 分钟' : '5 分钟'}</button>)}</div>}<label className="timezone-select"><Clock3 size={13} /><select aria-label="图表显示时区" value={zone} onChange={e => setZone(e.target.value as Zone)}>{(Object.keys(ZONES) as Zone[]).map(z => <option key={z} value={z}>{ZONES[z]}</option>)}</select><ChevronDown size={12} /></label></div></div>
          <div className="chart-legend">{view === 'spread' ? <><span><i style={{ background: '#2b9180' }} />FMM 高于 DA</span><span><i style={{ background: '#cf7c6e' }} />FMM 低于 DA</span></> : (Object.keys(SERIES) as SeriesKey[]).filter(k => resolution === 'hour' || k === 'dam' || (resolution === 'FMM' ? k === 'fmm' : k === 'rtd')).map(k => <button key={k} className={!enabled[k] ? 'muted' : ''} onClick={() => setEnabled(s => ({ ...s, [k]: !s[k] }))}><i style={{ background: SERIES[k].color }} />{SERIES[k].label}{resolution === 'hour' && k !== 'dam' ? ' 小时均价' : ''}</button>)}<span className="chart-hint">悬停查看 · 点击展开时段</span></div>
          <PriceChart rows={chartRows} zone={zone} spread={view === 'spread'} enabled={displayedSeries} onSelect={setDetailUtc} />
          <div className="chart-footer"><Info size={13} /><span>{view === 'spread' ? `价差仅统计 ${matched} 个完整可比小时，不含交易费用，也不代表已实现收益。` : '图中空缺表示数据缺失或时段不完整；不会用零价格填补。'}</span><span className="chart-node-code">{node}</span></div>
        </section>}
        <section className={`panel table-panel ${view === 'table' ? 'full-table' : ''}`}><div className="panel-heading"><div><div className="panel-title-row"><h2>{resolution === 'hour' || view === 'spread' ? '小时数据明细' : `${resolution === 'FMM' ? '15 分钟 FMM' : '5 分钟 RTD'} 明细`}</h2><span className="row-count">{tableRows.length} 条</span></div><p>{view === 'table' ? `${node} · ${rangeLabel} · ${ZONES[zone]}` : '点击任一行，查看原始价格、组成与对应时间。'}</p></div><div className="table-controls">{view === 'table' && <label className="timezone-select"><Clock3 size={13} /><select aria-label="明细显示时区" value={zone} onChange={e => setZone(e.target.value as Zone)}>{(Object.keys(ZONES) as Zone[]).map(z => <option key={z} value={z}>{ZONES[z]}</option>)}</select><ChevronDown size={12} /></label>}{view === 'table' && <div className="segment-control">{(['hour', 'FMM', 'RTD'] as Resolution[]).map(r => <button key={r} className={resolution === r ? 'active' : ''} onClick={() => setResolution(r)}>{r === 'hour' ? '小时' : r === 'FMM' ? '15 分钟' : '5 分钟'}</button>)}</div>}{(resolution === 'hour' || view === 'spread') && <select className="sort-select" aria-label="明细排序" value={sort} onChange={e => setSort(e.target.value)}><option value="time">按时间排序</option><option value="spread">按价差降序</option></select>}<button className="icon-button" aria-label="导出当前数据明细" onClick={exportData} disabled={!validHours && !rawRows.length}><ArrowDownToLine size={17} /></button></div></div>
          <div className="table-scroll"><table><thead>{resolution === 'hour' || view === 'spread' ? <tr><th>时段起点 <small>{zone === 'America/Los_Angeles' ? 'PT' : zone === 'Asia/Shanghai' ? '北京时间' : 'UTC'}</small></th><th>日前 DA</th><th>FMM 均价</th><th>RTD 均价</th><th>价差 <small>FMM − DA</small></th><th>时段完整性</th><th aria-label="展开详情" /></tr> : <tr><th>时段起点 <small>{zone === 'America/Los_Angeles' ? 'PT' : zone === 'Asia/Shanghai' ? '北京时间' : 'UTC'}</small></th><th>LMP</th><th>能源 MCE</th><th>拥塞 MCC</th><th>损耗 MCL</th><th>温室气体</th><th aria-label="展开详情" /></tr>}</thead><tbody>{visibleRows.map(row => { const hourly = 'dam' in row; return <tr key={row.startUtc} tabIndex={0} role="button" aria-label={`查看 ${timeLabel(row.startUtc, zone, true)} 价格明细`} onClick={() => setDetailUtc(row.startUtc)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailUtc(row.startUtc); } }}><td><strong>{timeLabel(row.startUtc, zone, active.start !== active.end)}</strong><small className="time-offset">{zone === 'America/Los_Angeles' ? `UTC${row.utcOffset}` : zone === 'Asia/Shanghai' ? 'UTC+08:00' : 'UTC+00:00'}</small></td>{hourly ? <><td>{fmt(row.dam)}</td><td>{fmt(row.fmm)}</td><td>{fmt(row.rtd)}</td><td><span className={`spread-value ${finite(row.spread) && row.spread < 0 ? 'negative' : 'positive'}`}>{signfmt(row.spread)}</span></td><td><span className={`table-quality ${finite(row.dam) && finite(row.fmm) ? 'complete' : ''}`}><i />{finite(row.dam) && finite(row.fmm) ? 'DA / FMM 完整' : `FMM ${row.fmmCount}/4`}</span></td></> : <><td><strong>{fmt(row.quality === 'ok' ? row.price : null)}</strong>{row.quality !== 'ok' && <small className="conflict-label">{row.quality === 'conflict' ? '冲突' : '缺失'}</small>}</td><td>{fmt(row.quality === 'ok' ? row.components.MCE : null)}</td><td>{fmt(row.quality === 'ok' ? row.components.MCC : null)}</td><td>{fmt(row.quality === 'ok' ? row.components.MCL : null)}</td><td>{fmt(row.quality === 'ok' ? row.components.MGHG : null)}</td></>}<td><ChevronRight size={14} /></td></tr>; })}{!visibleRows.length && <tr><td colSpan={7} className="empty-table">{busy ? '正在获取所选市场数据…' : '当前节点与日期没有可用明细。请查询数据或选择已验证历史数据。'}</td></tr>}</tbody></table></div>
          <div className="table-footer"><span>价格单位 $/MWh<span className="footer-divider">·</span>缺失值显示为 —</span><div className="pagination"><span>{tableRows.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, tableRows.length)}` : '0'} / {tableRows.length}</span><button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15} /></button><button className="icon-button" aria-label="下一页" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={15} /></button></div></div>
        </section>
        <footer className="page-footer"><span><ShieldCheck size={13} />官方数据，可追溯计算</span><p>来源 CAISO OASIS · 交易日使用 America/Los_Angeles · 支持夏令时</p><button onClick={() => setDrawer('sources')}>查看来源与口径<ArrowUpRight size={12} /></button></footer>
        </div>
      </Content>
    </div>
    {(drawer || detailUtc) && <div className="drawer-overlay" onMouseDown={e => { if (e.target === e.currentTarget) { setDrawer(null); setDetailUtc(null); } }}><section ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-label={detailUtc ? '时段价格明细' : drawer === 'sources' ? '数据来源与质量' : '指标说明'}><div className="drawer-heading"><div><span className="eyebrow">{detailUtc ? 'INTERVAL DETAILS' : drawer === 'sources' ? 'DATA PROVENANCE' : 'MARKET METHODOLOGY'}</span><h2>{detailUtc ? '时段价格明细' : drawer === 'sources' ? '来源与数据质量' : '指标与计算口径'}</h2></div><button autoFocus className="icon-button" aria-label="关闭详情" onClick={() => { setDrawer(null); setDetailUtc(null); }}><X size={21} /></button></div>
      <div className="drawer-body">{detailUtc ? <><div className="detail-summary"><span>{activeNode?.short || node} · {activeNode?.name || '自定义节点'}</span><h3>{timeLabel(utcHour(detailUtc), zone, true)}</h3><p>{ZONES[zone]} · 对应完整小时</p><code>{utcHour(detailUtc)} UTC</code></div>{detailHour && <div className="detail-metrics"><div><span>日前 DA</span><strong>{fmt(detailHour.dam)}</strong></div><div><span>FMM 均价</span><strong>{fmt(detailHour.fmm)}</strong></div><div><span>FMM − DA</span><strong className={finite(detailHour.spread) && detailHour.spread < 0 ? 'negative' : 'positive'}>{signfmt(detailHour.spread)}</strong></div></div>}<p className="detail-explanation">以下为该小时对应的原始市场时段。价格单位均为 $/MWh；小时均价只在所需时段完整时计算。</p>{selectedDetailRows.map(group => <div className="detail-market" key={group.market}><div className="detail-section-title"><h3>{MARKET_LABELS[group.market]}</h3><span>{group.rows.length} 个时段</span></div><div className="table-scroll"><table className="detail-table"><thead><tr><th>起始时间</th><th>LMP</th><th>能源</th><th>拥塞</th><th>损耗</th><th>GHG</th></tr></thead><tbody>{group.rows.map(r => <tr key={r.startUtc}><td>{timeLabel(r.startUtc, zone)}</td><td>{fmt(r.quality === 'ok' ? r.price : null)}{r.quality !== 'ok' && <small className="conflict-label">{r.quality === 'conflict' ? '冲突' : '缺失'}</small>}</td><td>{fmt(r.quality === 'ok' ? r.components.MCE : null)}</td><td>{fmt(r.quality === 'ok' ? r.components.MCC : null)}</td><td>{fmt(r.quality === 'ok' ? r.components.MCL : null)}</td><td>{fmt(r.quality === 'ok' ? r.components.MGHG : null)}</td></tr>)}{!group.rows.length && <tr><td colSpan={6}>该小时暂无此市场数据</td></tr>}</tbody></table></div></div>)}</> : drawer === 'sources' ? <><div className="source-banner"><Database size={24} /><div><strong>CAISO OASIS</strong><p>官方开放市场数据 · {mode === 'snapshot' ? '已验证历史快照' : '本次 API 查询'}</p></div></div><dl className="provenance-list"><div><dt>当前交易日期</dt><dd>{rangeLabel}（PT）</dd></div><div><dt>显示节点</dt><dd><code>{node}</code></dd></div><div><dt>抓取时间</dt><dd>{fullTimestamp(latestFetch)} 北京时间</dd></div><div><dt>可比小时</dt><dd>{matched} / {expected} 小时</dd></div></dl><a className="official-link snapshot-download" href={`/data/oasis_prices_${bootstrap.startDate}_${bootstrap.endDate}.csv`} download><span>下载全部历史快照 · {bootstrap.startDate} 至 {bootstrap.endDate}</span><ArrowDownToLine size={14} /></a><h3 className="drawer-section-label">市场数据</h3>{ORDER.map(m => { const data = markets[m], count = data?.intervals.filter(inRange).length || 0; return <article className="source-market-card" key={m}><div><span className={`market-symbol ${m.toLowerCase()}`}>{m}</span><strong>{MARKET_LABELS[m]}</strong><span className={`source-state ${data?.ok ? 'ok' : ''}`}>{data?.ok ? data.cached ? '缓存数据' : '已获取' : busy && loadingMarket === m ? '读取中' : '未获取'}</span></div><p>{count} 个原始价格时段 · {m === 'DAM' ? '60' : m === 'FMM' ? '15' : '5'} 分钟粒度</p>{data?.fetchedAt && <small>{fullTimestamp(data.fetchedAt)} 北京时间</small>}{data?.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer">打开官方同条件查询 ZIP<ExternalLink size={12} /></a>}{errors[m] && <p className="negative">{errors[m]}</p>}</article>; })}{warnings.length > 0 && <div className="data-warnings"><h3>数据提示</h3>{warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}<div className="source-notes"><h3>数据处理原则</h3><p>以 UTC 时段作为唯一时间键，按太平洋交易日筛选。夏令时切换日保留 23 或 25 个小时，重复的本地时刻以 UTC 偏移区分。</p><p>DA 与 4 个完整 FMM 时段对齐后计算小时价差。RTD 小时均价需要 12 个完整时段，RTD 不替代收敛竞价的 FMM 价格。</p><p>未返回或冲突的数据保持缺失。零价格和负价格均为有效价格，不作删除或填补。</p><p>历史快照对应固定日期及抓取时间；手动查询成功后展示该次结果。上游接口错误不会被替换为模拟行情。</p></div><a className="official-link" href="https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf" target="_blank" rel="noreferrer">阅读 OASIS 官方 API 说明<ExternalLink size={14} /></a></> : <><div className="source-banner"><Layers3 size={25} /><div><strong>把市场口径放在数字之前</strong><p>官方价格整理与研究；策略预测来源在实验室单独标注</p></div></div><article className="method-item"><span>01</span><div><h3>三类价格，保留各自粒度</h3><p>DA 为日前小时价格；FMM 为 15 分钟市场价格；RTD 为 5 分钟实时调度价格。小时视图将 FMM、RTD 分别在同一小时内取完整时段的简单平均。</p></div></article><article className="method-item"><span>02</span><div><h3>价差 = FMM 小时均价 − DA</h3><p>只比较同节点、同一 UTC 小时，且该小时 DA 与 4 个 FMM 时段均完整的价格。平均价差仅在这些配对小时计算，不用两条不同覆盖范围的均价相减。</p></div></article><article className="method-item"><span>03</span><div><h3>均价与交易收益的边界</h3><p>顶部 DA 均价与 FMM 均价分别基于各自有效小时。价差表达价格关系，不包含成交电量、费用与其他结算项，不直接代表收益。</p></div></article><article className="method-item"><span>04</span><div><h3>LMP 四项价格构成</h3><p>MCE：边际能源；MCC：边际拥塞；MCL：边际损耗；MGHG：边际温室气体成本。点击时段可查看官方返回的各分项。</p></div></article><article className="method-item"><span>05</span><div><h3>日期与时区</h3><p>查询日期始终采用 America/Los_Angeles 的自然日。图表可切换北京时间或 UTC，仅改变展示时间，查询范围保持不变。</p></div></article><article className="method-item"><span>06</span><div><h3>枢纽与自定义节点</h3><p>内置 NP15、SP15、ZP26 三个交易枢纽；其他节点可输入 OASIS 完整代码查询。价格可查询不等于具有交易权限或符合虚拟交易节点资格。</p></div></article><a className="official-link" href="https://www.caiso.com/documents/section-11-california-iso-settlements-and-billing-as-of-jul-22-2026.pdf" target="_blank" rel="noreferrer">查看 CAISO 结算规则 §11.3<ExternalLink size={14} /></a></>}</div>
    </section></div>}
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>;
}
