'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, CheckCircle2, ChevronDown, Clock3, Database, ExternalLink, FileSearch, Info, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import '@/app/data-readiness.css';

type ReadinessCategory = 'prediction' | 'settlement' | 'market';
type ReadinessPriority = 'P0' | 'P1' | 'P2';
type ReadinessStatus = 'ready' | 'partial' | 'blocked';
type Download = { label: string; href: string };

export interface DataReadinessItem {
  id: string;
  title: string;
  category: ReadinessCategory;
  priority: ReadinessPriority;
  status: ReadinessStatus;
  statusLabel: string;
  before: string;
  coverage: string;
  useCase: string;
  modelStatus: string;
  modelUse?: 'current' | 'reference';
  limitation: string;
  metrics: { label: string; value: string }[];
  sources: { label: string; url: string }[];
  downloads: Download[];
  sampleRows?: Record<string, string | number | null>[];
}

export interface DataReadinessCatalog {
  schemaVersion: 1;
  generatedAt: string;
  headline: string;
  summary: string;
  items: DataReadinessItem[];
  downloads: Download[];
  warnings: string[];
}

const CATEGORY: Record<ReadinessCategory, string> = { prediction: '预测输入', settlement: '结算与执行', market: '市场边界' };
const PRIORITY: Record<ReadinessPriority, number> = { P0: 0, P1: 1, P2: 2 };
const FILTERS = [{ id: 'all', label: '全部' }, { id: 'obtained', label: '已取得' }, { id: 'missing', label: '参考缺口' }] as const;
type Filter = typeof FILTERS[number]['id'];

function validLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}

function readCatalog(value: unknown): DataReadinessCatalog {
  if (!value || typeof value !== 'object') throw new Error('数据覆盖清单格式无法识别。');
  const data = value as DataReadinessCatalog;
  const strings = (values: unknown[]) => values.every(item => typeof item === 'string');
  const downloads = (values: unknown) => Array.isArray(values) && values.every(link => link && typeof link.label === 'string' && validLink(link.href));
  if (data.schemaVersion !== 1 || !strings([data.generatedAt, data.headline, data.summary]) || !Number.isFinite(Date.parse(data.generatedAt)) || !/(Z|[+-]\d{2}:\d{2})$/.test(data.generatedAt)
    || !Array.isArray(data.items) || !Array.isArray(data.warnings) || !strings(data.warnings) || !downloads(data.downloads)) throw new Error('数据覆盖清单缺少必要的版本、时间或内容。');
  const ids = new Set<string>();
  for (const item of data.items) {
    if (!item || !strings([item.id, item.title, item.statusLabel, item.before, item.coverage, item.useCase, item.modelStatus, item.limitation])
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)
      || !['prediction', 'settlement', 'market'].includes(item.category) || !['P0', 'P1', 'P2'].includes(item.priority) || !['ready', 'partial', 'blocked'].includes(item.status) || (item.modelUse !== undefined && !['current', 'reference'].includes(item.modelUse))
      || !Array.isArray(item.metrics) || !item.metrics.every(metric => metric && strings([metric.label, metric.value]))
      || !Array.isArray(item.sources) || !item.sources.every(source => source && typeof source.label === 'string' && validLink(source.url))
      || !downloads(item.downloads)
      || (item.sampleRows !== undefined && (!Array.isArray(item.sampleRows) || !item.sampleRows.every(row => row && typeof row === 'object' && !Array.isArray(row) && Object.values(row).every(cell => cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))))))) {
      throw new Error('数据覆盖清单有不完整条目，请重新读取。');
    }
    ids.add(item.id);
  }
  return data;
}

function auditTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function Downloads({ links, className = '' }: { links: Download[]; className?: string }) {
  if (!links.length) return null;
  return <div className={`dr-downloads ${className}`}>{links.map(link => <a key={`${link.href}:${link.label}`} href={link.href} download={link.href.startsWith('/') ? true : undefined} target={link.href.startsWith('/') ? undefined : '_blank'} rel={link.href.startsWith('/') ? undefined : 'noreferrer'}><ArrowDownToLine size={15} aria-hidden="true" /><span>{link.label}</span></a>)}</div>;
}

function SampleTable({ rows, title }: { rows: Record<string, string | number | null>[]; title: string }) {
  const sample = rows.slice(0, 6);
  const columns = [...new Set(sample.flatMap(row => Object.keys(row)))];
  if (!sample.length || !columns.length) return null;
  return <div className="dr-sample"><h4>已取得数据示例</h4><p>最多展示 6 行；完整记录及字段说明见对应下载文件。空值显示为“—”。</p><div className="dr-table-scroll" role="region" aria-label={`${title}数据示例，可横向滚动`} tabIndex={0}><table><caption className="dr-sr-only">{title}的已取得数据示例</caption><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{sample.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{row[column] == null ? '—' : String(row[column])}</td>)}</tr>)}</tbody></table></div></div>;
}

function ReadinessRow({ item, open, onToggle }: { item: DataReadinessItem; open: boolean; onToggle: () => void }) {
  const Icon = item.status === 'ready' ? CheckCircle2 : item.status === 'blocked' ? LockKeyhole : AlertCircle;
  const panelId = `dr-details-${item.id}`;
  return <article className={`dr-item dr-item-${item.status}${open ? ' dr-item-open' : ''}`}>
    <button type="button" className="dr-item-toggle" aria-expanded={open} aria-controls={panelId} id={`dr-heading-${item.id}`} onClick={onToggle}>
      <span className={`dr-item-icon dr-${item.status}`}><Icon size={19} aria-hidden="true" /></span>
      <span className="dr-item-main"><span className="dr-item-eyebrow"><span>{CATEGORY[item.category]}</span><span className={`dr-priority dr-priority-${item.priority.toLowerCase()}`}>{item.modelUse === 'current' ? '本轮使用' : item.modelUse === 'reference' ? '参考数据' : item.priority}</span></span><strong>{item.title}</strong><span className="dr-item-coverage">{item.coverage}</span><span className="dr-item-model"><span>模型使用</span>{item.modelStatus}</span></span>
      <span className={`dr-status dr-${item.status}`}>{item.statusLabel}</span><ChevronDown size={17} className="dr-chevron" aria-hidden="true" />
    </button>
    <div id={panelId} className="dr-item-details" role="region" aria-labelledby={`dr-heading-${item.id}`} hidden={!open}>
      <dl className="dr-detail-grid"><div><dt>此前缺口</dt><dd>{item.before}</dd></div><div><dt>业务用途</dt><dd>{item.useCase}</dd></div><div className="dr-detail-wide"><dt>当前边界与仍缺内容</dt><dd>{item.limitation}</dd></div></dl>
      {item.metrics.length > 0 && <dl className="dr-metrics">{item.metrics.map((metric, index) => <div key={`${metric.label}:${index}`}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>}
      <Downloads links={item.downloads} />
      {item.sampleRows && <SampleTable rows={item.sampleRows} title={item.title} />}
      {item.sources.length > 0 && <div className="dr-sources"><h4>来源与证据</h4><div>{item.sources.map(source => <a key={`${source.url}:${source.label}`} href={source.url} target="_blank" rel="noreferrer"><span>{source.label}</span><ExternalLink size={13} aria-hidden="true" /></a>)}</div></div>}
    </div>
  </article>;
}

/** Fetch only the small published catalog, and only while the data center is open. */
export default function DataReadiness({ active }: { active: boolean }) {
  const [catalog, setCatalog] = useState<DataReadinessCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>('obtained');
  const [expanded, setExpanded] = useState<string | null>(null);
  const loadedAttempt = useRef(-1);

  useEffect(() => {
    if (!active || loadedAttempt.current === attempt) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetch('/data/data-gaps/catalog.json', { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(response.status === 404 ? '本轮数据覆盖清单尚未发布。' : '暂时无法读取数据覆盖清单。'); return readCatalog(await response.json()); })
      .then(data => { if (!controller.signal.aborted) { setCatalog(data); loadedAttempt.current = attempt; } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '读取失败，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, attempt]);

  const items = useMemo(() => (catalog?.items || []).map((item, index) => ({ item, index })).sort((a, b) => PRIORITY[a.item.priority] - PRIORITY[b.item.priority] || a.index - b.index).map(entry => entry.item), [catalog]);
  const counts = { all: items.length, obtained: items.filter(item => item.status !== 'blocked').length, missing: items.filter(item => item.status !== 'ready').length };
  const shown = items.filter(item => filter === 'all' || (filter === 'obtained' ? item.status !== 'blocked' : item.status !== 'ready'));
  if (!active) return null;

  return <section className="dr-readiness" aria-labelledby="dr-readiness-title" aria-busy={loading}>
    <div className="dr-heading"><div><span className="dr-eyebrow">CURRENT INPUTS & REFERENCES</span><h2 id="dr-readiness-title">{catalog?.headline || '当前预测输入与参考数据'}</h2><p>{catalog?.summary || '查看本轮预测实际使用的数据，以及已保留的其他参考资料。'}</p></div><button type="button" className="dr-refresh" onClick={() => setAttempt(value => value + 1)} disabled={loading} title="读取已发布清单，不发起来源数据采集">{loading ? <LoaderCircle size={15} className="dr-spin" /> : <RefreshCw size={15} />}<span>刷新清单</span></button></div>
    <div className="dr-context"><span><Clock3 size={14} aria-hidden="true" />{catalog ? <>审计更新 <time dateTime={catalog.generatedAt}>{auditTime(catalog.generatedAt)}</time> 北京时间</> : '读取最近发布的审计清单'}</span><span>独立历史覆盖，不随上方交易日期切换</span><a className="dr-refresh" style={{textDecoration: 'none', marginLeft: 'auto'}} href="/#prices/prediction">返回当前预测<ArrowRight size={14}/></a></div>
    {error && <div className="dr-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>{error}</strong>{catalog && <p>下方保留上一次成功读取的清单及其审计时间。</p>}</div><button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>重新读取</button></div>}
    {!catalog && !error && <div className="dr-empty" role="status"><LoaderCircle size={24} className="dr-spin" aria-hidden="true" /><strong>正在读取数据覆盖清单</strong><p>各类数据的覆盖范围、模型使用状态和下载证据将分别展示。</p></div>}
    {catalog && <>
      <div className="dr-controls"><div className="dr-filters" role="group" aria-label="筛选数据取得状态">{FILTERS.map(option => <button key={option.id} type="button" aria-pressed={filter === option.id} className={filter === option.id ? 'active' : ''} onClick={() => setFilter(option.id)}>{option.label}<span>{counts[option.id]}</span></button>)}</div><span className="dr-sort-note">本轮使用的数据优先展示</span></div>
      <p className="dr-filter-note">“部分取得”同时出现在已取得与参考缺口中；其他来源的未取得部分不阻塞当前预测。</p>
      <div className="dr-list" aria-live="polite">{shown.map(item => <ReadinessRow key={item.id} item={item} open={expanded === item.id} onToggle={() => setExpanded(value => value === item.id ? null : item.id)} />)}{!shown.length && <div className="dr-empty"><FileSearch size={26} aria-hidden="true" /><strong>{items.length ? '当前筛选下没有条目' : '尚未发布逐项数据清单'}</strong><p>{items.length ? '切换筛选查看其他数据，或打开下方现有数据目录。' : '下方已接入的数据目录仍可正常使用。'}</p>{items.length > 0 && filter !== 'all' && <button type="button" onClick={() => setFilter('all')}>查看全部</button>}</div>}</div>
      {catalog.downloads.length > 0 && <footer className="dr-footer"><div><Database size={17} aria-hidden="true" /><span>本轮输入与参考下载</span></div><Downloads links={catalog.downloads} /></footer>}
      {catalog.warnings.length > 0 && <details style={{marginTop: 18, fontSize: 12, lineHeight: 1.85, color: '#738469'}}><summary style={{cursor: 'pointer'}}><Info size={13} aria-hidden="true" style={{display: 'inline', marginRight: 6}}/>数据使用说明</summary><ul>{catalog.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </>}
  </section>;
}
