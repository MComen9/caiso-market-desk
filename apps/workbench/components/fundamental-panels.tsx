'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowUpRight, BarChart3, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, Database, ExternalLink, Info, LoaderCircle, RefreshCw, Table2 } from 'lucide-react';
import type { DataFeed, FeedColumn, FeedRow } from '@/lib/data-types';
import SeriesChart, { dateTimeText, isNumber, numberText, type DisplayZone } from '@/components/series-chart';

export const SOURCE_LABELS = { outlook: 'CAISO Today’s Outlook', oasis: 'CAISO OASIS', gridstatus: 'GridStatus' };
export const STATUS_LABELS = { ok: '已获取', partial: '部分数据', error: '读取失败', unavailable: '暂无数据', not_configured: '待配置' };

function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[=+@\-]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadFeed(feed: DataFeed, selectedColumns?: FeedColumn[], zone: DisplayZone = 'America/Los_Angeles') {
  const columns = selectedColumns || feed.columns;
  if (feed.rows.length) {
    const header = ['feed', 'start_utc', 'end_utc', 'display_time', 'display_timezone', 'source_time', 'quality', 'publish_time_utc', ...columns.map(column => `${column.label} (${column.unit})`), 'source_url', 'fetched_at'];
    const rows = feed.rows.map(row => [feed.id, row.startUtc, row.endUtc, dateTimeText(row.startUtc, zone, true), zone, row.sourceTime, row.quality, row.publishTimeUtc, ...columns.map(column => row.values[column.key]), feed.sourceUrl, feed.fetchedAt]);
    saveFile(`${feed.id}_${feed.requestedDate}.csv`, '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8;');
  } else if (feed.table?.rows.length) {
    const header = feed.table.columns.map(column => `${column.label}${column.unit ? ` (${column.unit})` : ''}`);
    const rows = feed.table.rows.map(row => feed.table!.columns.map(column => row[column.key]));
    saveFile(`${feed.id}_${feed.requestedDate}.csv`, '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8;');
  } else if (feed.stats) saveFile(`${feed.id}_${feed.requestedDate}.json`, JSON.stringify(feed, null, 2), 'application/json');
}

export function FeedStatus({ feed, loading = false }: { feed?: DataFeed; loading?: boolean }) {
  return <span className={`mw-status ${loading ? 'loading' : feed?.status || 'unavailable'}`}>{loading ? <LoaderCircle size={12} className="mw-spin" /> : feed?.status === 'ok' ? <CheckCircle2 size={12} /> : <span className="mw-status-dot" />}{loading ? '正在读取' : feed ? STATUS_LABELS[feed.status] : '待读取'}</span>;
}

export function FeedTable({ feed, columns, zone }: { feed: DataFeed; columns: FeedColumn[]; zone: DisplayZone }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [feed.id, feed.requestedDate, columns.map(column => column.key).join('|')]);
  const pageSize = 24;
  const count = feed.rows.length || feed.table?.rows.length || 0;
  const maxPage = Math.max(1, Math.ceil(count / pageSize));
  if (feed.stats && !count) return <div className="mw-stats-table">{Object.entries(feed.stats).filter(([, value]) => ['number', 'string', 'boolean'].includes(typeof value) || Array.isArray(value)).map(([key, value]) => <div key={key}><code>{key}</code><span>{Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' / ') : String(value)}</span></div>)}</div>;
  return <div className="mw-data-table-wrap"><div className="mw-data-table-scroll"><table className="mw-data-table"><thead><tr>{feed.rows.length ? <><th>时段起点 <small>{zone === 'America/Los_Angeles' ? 'PT' : zone === 'UTC' ? 'UTC' : '北京'}</small></th>{columns.map(column => <th key={column.key}>{column.label}<small>{column.unit}</small></th>)}<th>质量</th></> : feed.table?.columns.map(column => <th key={column.key}>{column.label}<small>{column.unit}</small></th>)}</tr></thead><tbody>{feed.rows.length ? feed.rows.slice((page - 1) * pageSize, page * pageSize).map((row, index) => <tr key={`${row.startUtc || row.sourceTime}-${index}`}><td><strong>{row.startUtc ? dateTimeText(row.startUtc, zone, true) : row.sourceTime || '—'}</strong>{row.startUtc ? <small>{row.startUtc}</small> : <small>原始 PT · 时间歧义</small>}</td>{columns.map(column => <td key={column.key}>{numberText(row.values[column.key], column.unit === '%' ? 1 : 2)}</td>)}<td><span className={row.quality === 'ambiguous' ? 'mw-warning-text' : 'mw-muted'}>{row.quality === 'ambiguous' ? '时间歧义' : row.quality === 'missing' ? '部分缺失' : '来源值'}</span></td></tr>) : feed.table?.rows.slice((page - 1) * pageSize, page * pageSize).map((row, index) => <tr key={index}>{feed.table!.columns.map(column => <td key={column.key}>{typeof row[column.key] === 'number' ? numberText(row[column.key] as number, 2) : row[column.key] ?? '—'}</td>)}</tr>)}{!count && <tr><td colSpan={columns.length + 2} className="mw-empty-cell">当前条件没有数据记录。</td></tr>}</tbody></table></div><div className="mw-table-pagination"><span>共 {count.toLocaleString()} 条 · 空值显示为 —</span><div><span>{Math.min(page, maxPage)} / {maxPage}</span><button type="button" aria-label="上一页数据" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="下一页数据" disabled={page >= maxPage} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div></div></div>;
}

interface FeedPanelProps {
  feed?: DataFeed;
  title?: string;
  subtitle?: string;
  zone: DisplayZone;
  preferredKeys?: string[];
  columns?: FeedColumn[];
  compact?: boolean;
  loading?: boolean;
  onLoad?: () => void;
  onInspect?: () => void;
  footer?: string;
}

export function FeedPanel({ feed, title, subtitle, zone, preferredKeys, columns: suppliedColumns, compact = false, loading = false, onLoad, onInspect, footer }: FeedPanelProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [showNotes, setShowNotes] = useState(false);
  const [unitChoice, setUnitChoice] = useState('');
  const columns = suppliedColumns || feed?.columns || [];
  const units = [...new Set(columns.map(column => column.unit))];
  const selectedUnit = units.includes(unitChoice) ? unitChoice : units.includes(feed?.unit || '') ? feed!.unit : units[0] || '';
  const compatible = columns.filter(column => column.unit === selectedUnit);
  const hasRecords = !!(feed?.rows.length || feed?.table?.rows.length || feed?.stats);
  const latest = feed?.rows.filter(row => row.startUtc && row.quality !== 'ambiguous' && Object.values(row.values).some(isNumber)).at(-1)?.startUtc;
  return <section className={`mw-panel ${compact ? 'mw-panel-compact' : ''}`}>
    <div className="mw-panel-heading"><div><div className="mw-panel-title"><h2>{title || feed?.title || '数据视图'}</h2><FeedStatus feed={feed} loading={loading} /></div>{subtitle && <p>{subtitle}</p>}</div><div className="mw-panel-actions">{!compact && !!feed?.rows.length && <div className="mw-segment" aria-label="展示方式"><button type="button" className={view === 'chart' ? 'active' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}><BarChart3 size={14} /><span>曲线</span></button><button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 size={14} /><span>明细</span></button></div>}{onLoad && <button type="button" className="mw-icon" aria-label={`刷新${title || feed?.title || '数据'}`} disabled={loading} onClick={onLoad}><RefreshCw size={16} className={loading ? 'mw-spin' : ''} /></button>}{hasRecords && <button type="button" className="mw-icon" aria-label={`导出${title || feed?.title || '数据'}`} onClick={() => feed && downloadFeed(feed, compatible, zone)}><ArrowDownToLine size={16} /></button>}</div></div>
    {feed?.dataDate && feed.dataDate !== feed.requestedDate && <div className="mw-notice warning"><AlertCircle size={15} /><span>来源实际日期为 {feed.dataDate}，与查询日期 {feed.requestedDate} 不同。请按来源日期阅读。</span></div>}
    {!hasRecords ? <div className="mw-chart-empty"><Database size={28} /><strong>{loading ? '正在读取官方数据…' : feed?.error?.message || '此数据尚未载入'}</strong><span>{feed?.status === 'unavailable' ? '该日期暂无官方返回记录，可更换日期或稍后重试。' : '每组数据独立加载，其他图表仍可继续使用。'}</span>{onLoad && !loading && <button className="mw-button secondary" onClick={onLoad}>读取这组数据<ArrowUpRight size={14} /></button>}</div> : <>
      {units.length > 1 && view === 'chart' && <label className="mw-inline-filter">计量单位<select aria-label="图表计量单位" value={selectedUnit} onChange={event => setUnitChoice(event.target.value)}>{units.map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label>}
      {view === 'table' || !feed?.rows.length ? <FeedTable feed={feed!} columns={compatible.length ? compatible : columns} zone={zone} /> : <SeriesChart title={title || feed!.title} rows={feed!.rows} columns={compatible} zone={zone} unit={selectedUnit} preferredKeys={preferredKeys} compact={compact} />}
    </>}
    <div className="mw-panel-footer"><span><Info size={13} />{footer || (feed?.source === 'oasis' ? '官方预测保留区域口径；未提供发布时间时不推断发布批次。' : '原始值保留正负与空缺；图例可切换曲线。')}</span>{onInspect ? <button onClick={onInspect}>来源与口径<ArrowUpRight size={12} /></button> : <button type="button" aria-expanded={showNotes} onClick={() => setShowNotes(value => !value)}>来源与口径<ChevronDown size={13} style={{ transform: showNotes ? 'rotate(180deg)' : undefined }} /></button>}</div>
    {showNotes && feed && <div className="mw-feed-notes"><div className="mw-feed-meta"><span>{SOURCE_LABELS[feed.source]}</span><span><Clock3 size={12} />获取于 {dateTimeText(feed.fetchedAt, zone, true)}</span>{latest && <span>序列覆盖至 {dateTimeText(latest, zone, true)}</span>}</div>{[...feed.notes, ...feed.warnings].map((note, index) => <p key={index}>{note}</p>)}{feed.sourceUrl && <a className="mw-text-link" target="_blank" rel="noreferrer" href={feed.sourceUrl}>打开官方原始数据<ExternalLink size={13} /></a>}</div>}
  </section>;
}

export const FORECAST_OPTIONS = [
  { id: 'load_dam', group: 'load', label: '日前 DAM', note: '所选交易日 · 日前小时负荷预测' },
  { id: 'load_rtpd', group: 'load', label: '15 分钟 RTPD', note: '实时预调度负荷预测' },
  { id: 'load_rtd', group: 'load', label: '5 分钟 RTD', note: '实时调度负荷预测' },
  { id: 'load_2da', group: 'load', label: '提前 2 日', note: '官方两日前负荷预测' },
  { id: 'load_7da', group: 'load', label: '提前 7 日', note: '官方七日前负荷预测' },
  { id: 'load_actual', group: 'load', label: '小时实际', note: 'OASIS 实际负荷，口径与 Outlook 不同' },
  { id: 'renewables_dam', group: 'renewables', label: '日前 DAM', note: '日前风电、光伏预测' },
  { id: 'renewables_rtpd', group: 'renewables', label: '15 分钟 RTPD', note: '实时预调度风光预测' },
  { id: 'renewables_rtd', group: 'renewables', label: '5 分钟 RTD', note: '实时调度风光预测' },
  { id: 'renewables_hasp', group: 'renewables', label: '小时前 HASP', note: '小时前风光预测' },
  { id: 'renewables_actual', group: 'renewables', label: '小时实际', note: '官方风光实际出力' },
] as const;

export function ForecastPanel({ feeds, zone, loading, onLoad, onSelectionChange }: { feeds: Record<string, DataFeed>; zone: DisplayZone; loading: Set<string>; onLoad: (id: string) => void; onSelectionChange?: (ids: string[]) => void }) {
  const [loadId, setLoadId] = useState('load_dam');
  const [renewableId, setRenewableId] = useState('renewables_dam');
  const [loadArea, setLoadArea] = useState('CA ISO-TAC');
  const [renewableArea, setRenewableArea] = useState('CAISO');
  useEffect(() => { onSelectionChange?.([loadId, renewableId]); }, [loadId, renewableId]);
  const load = feeds[loadId], renewable = feeds[renewableId];
  const areas = (feed: DataFeed | undefined) => [...new Set(feed?.columns.map(column => column.area).filter((area): area is string => !!area) || [])];
  const activeArea = (feed: DataFeed | undefined, desired: string) => areas(feed).includes(desired) ? desired : feed?.columns.find(column => column.primary)?.area || areas(feed)[0];
  const selectedLoadArea = activeArea(load, loadArea), selectedRenewableArea = activeArea(renewable, renewableArea);
  const loadColumns = load?.columns.filter(column => column.area === selectedLoadArea) || [];
  const renewableColumns = renewable?.columns.filter(column => column.area === selectedRenewableArea) || [];
  function choose(id: string, group: 'load' | 'renewables') { if (group === 'load') setLoadId(id); else setRenewableId(id); if (!feeds[id]) onLoad(id); }
  return <div className="mw-section-stack">
    <div className="mw-notice"><Info size={17} /><span>这里展示 CAISO 官方负荷与风光预测，不是节点电价预测。不同区域独立展示；未提供发布时刻的数据不能用于恢复历史预测批次。</span></div>
    <div className="mw-forecast-group"><div className="mw-group-heading"><div><span className="mw-section-eyebrow">DEMAND FORECAST</span><h2>官方负荷预测</h2></div><label className="mw-select-label">区域<select aria-label="负荷预测区域" value={selectedLoadArea || ''} onChange={event => setLoadArea(event.target.value)}>{areas(load).length ? areas(load).map(area => <option key={area}>{area}</option>) : <option value="">等待数据</option>}</select></label></div><div className="mw-subtabs mw-subtabs-small" aria-label="负荷预测市场">{FORECAST_OPTIONS.filter(option => option.group === 'load').map(option => <button key={option.id} type="button" className={loadId === option.id ? 'active' : ''} aria-pressed={loadId === option.id} onClick={() => choose(option.id, 'load')}>{option.label}{feeds[option.id]?.status === 'ok' && <span className="mw-loaded-dot" />}</button>)}</div><FeedPanel feed={load} title={FORECAST_OPTIONS.find(option => option.id === loadId)?.note} subtitle={selectedLoadArea ? `当前区域：${selectedLoadArea}` : undefined} columns={loadColumns} zone={zone} loading={loading.has(loadId)} onLoad={() => onLoad(loadId)} footer="区域之间不自动相加；OASIS 实际负荷可能包含储能充电，请阅读来源口径。" /></div>
    <div className="mw-forecast-group"><div className="mw-group-heading"><div><span className="mw-section-eyebrow">RENEWABLE FORECAST</span><h2>官方风光预测</h2></div><label className="mw-select-label">区域<select aria-label="风光预测区域" value={selectedRenewableArea || ''} onChange={event => setRenewableArea(event.target.value)}>{areas(renewable).length ? areas(renewable).map(area => <option key={area}>{area}</option>) : <option value="">等待数据</option>}</select></label></div><div className="mw-subtabs mw-subtabs-small" aria-label="风光预测市场">{FORECAST_OPTIONS.filter(option => option.group === 'renewables').map(option => <button key={option.id} type="button" className={renewableId === option.id ? 'active' : ''} aria-pressed={renewableId === option.id} onClick={() => choose(option.id, 'renewables')}>{option.label}{feeds[option.id]?.status === 'ok' && <span className="mw-loaded-dot" />}</button>)}</div><FeedPanel feed={renewable} title={FORECAST_OPTIONS.find(option => option.id === renewableId)?.note} subtitle={selectedRenewableArea === 'CAISO' ? 'CAISO 汇总仅在 NP15 / SP15 / ZP26 三个枢纽都完整时计算。' : selectedRenewableArea ? `当前区域：${selectedRenewableArea}` : undefined} columns={renewableColumns} zone={zone} loading={loading.has(renewableId)} onLoad={() => onLoad(renewableId)} footer="风电与光伏分别展示，不把其他平衡区叠加为 CAISO 总量。" /></div>
  </div>;
}

export function MetricCard({ title, value, unit = 'MW', time, zone, label, accent = false, onClick }: { title: string; value: number | null; unit?: string; time?: string | null; zone: DisplayZone; label?: string; accent?: boolean; onClick?: () => void }) {
  return <button type="button" className={`mw-metric ${accent ? 'mw-metric-accent' : ''}`} onClick={onClick} aria-label={`${title} ${numberText(value)} ${unit}，打开分析`}><div><span>{title}</span><ArrowUpRight size={15} /></div><strong>{numberText(value)}<small>{unit}</small></strong><footer><span>{label || '最后可用实际值'}</span><time>{time ? dateTimeText(time, zone) : ''}</time></footer></button>;
}

export function latestMetric(feed: DataFeed | undefined, keys: string[]) {
  if (!feed || (feed.dataDate && feed.dataDate !== feed.requestedDate) || ['error', 'unavailable', 'not_configured'].includes(feed.status)) return { value: null, time: null };
  for (let i = feed.rows.length - 1; i >= 0; i--) {
    const row = feed.rows[i]; if (!row.startUtc || row.quality === 'ambiguous') continue;
    for (const key of keys) if (isNumber(row.values[key])) return { value: row.values[key], time: row.startUtc };
  }
  return { value: null, time: null };
}
