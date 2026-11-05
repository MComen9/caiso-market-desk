'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import type { FeedColumn, FeedRow } from '@/lib/data-types';

export type DisplayZone = 'America/Los_Angeles' | 'Asia/Shanghai' | 'UTC';
export const SERIES_COLORS = ['#267b78', '#d08b43', '#6b87bd', '#9a6c9b', '#7b9555', '#c66c62', '#4b9fba', '#9c876c'];
const SEMANTIC_COLORS: Record<string, string> = { demandActual: '#267b78', demandDayAhead: '#d08b43', demandHourAhead: '#6b87bd', netDemand: '#5a7139', netDemandForecast: '#9a6c9b', solar: '#d09a43', wind: '#6b98ae', naturalGas: '#9b7b61', imports: '#6c80b0', batteriesTotal: '#267b78', batteriesStandalone: '#8c6dac', batteriesHybrid: '#c48c53', raCapacity: '#267b78', raNetCapacity: '#668c44', reserveRequirement: '#6b87bd', reserveForecast: '#6b87bd' };
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const numberText = (value: number | null | undefined, digits = 0) => isNumber(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
export function dateTimeText(value: string | null | undefined, zone: DisplayZone = 'America/Los_Angeles', includeDate = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

interface SeriesChartProps {
  rows: FeedRow[];
  columns: FeedColumn[];
  zone: DisplayZone;
  title: string;
  unit?: string;
  preferredKeys?: string[];
  compact?: boolean;
}

export default function SeriesChart({ rows, columns, zone, title, unit = 'MW', preferredKeys, compact = false }: SeriesChartProps) {
  const signature = columns.map(column => column.key).join('|');
  const preferred = preferredKeys?.join('|') || '';
  const initialKeys = () => {
    const selected = preferredKeys?.length ? columns.filter(column => preferredKeys.includes(column.key)) : columns.filter(column => column.primary);
    return (selected.length ? selected : columns.slice(0, compact ? 3 : 5)).map(column => column.key);
  };
  const [enabled, setEnabled] = useState<string[]>(initialKeys);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { setEnabled(initialKeys()); setHover(null); }, [signature, preferred]); // Column changes represent another dataset or region.
  const points = useMemo(() => rows.filter(row => row.startUtc && row.quality !== 'ambiguous' && Number.isFinite(Date.parse(row.startUtc))).sort((a, b) => a.startUtc!.localeCompare(b.startUtc!)), [rows]);
  const activeColumns = columns.filter(column => enabled.includes(column.key));
  const colorFor = (column: FeedColumn) => SEMANTIC_COLORS[column.key] || (column.resource === 'solar' ? '#d09a43' : column.resource === 'wind' ? '#6b98ae' : SERIES_COLORS[columns.findIndex(item => item.key === column.key) % SERIES_COLORS.length]);
  const values = points.flatMap(row => activeColumns.map(column => row.values[column.key])).filter(isNumber);
  const W = 1000, H = compact ? 230 : 285, L = 68, R = 22, T = 22, B = 35;
  const first = points.length ? Date.parse(points[0].startUtc!) : 0;
  const last = points.length ? Date.parse(points.at(-1)!.startUtc!) : 1;
  const duration = Math.max(last - first, 1);
  const lowest = values.length ? Math.min(...values) : 0, highest = values.length ? Math.max(...values) : 1;
  const range = Math.max(highest - lowest, Math.max(Math.abs(highest), 1) * .08);
  const min = lowest - range * .12, max = highest + range * .14;
  const x = (index: number) => L + (Date.parse(points[index].startUtc!) - first) / duration * (W - L - R);
  const y = (value: number) => T + (max - value) / (max - min) * (H - T - B);
  const differences = points.slice(1).map((point, i) => Date.parse(point.startUtc!) - Date.parse(points[i].startUtc!)).filter(value => value > 0).sort((a, b) => a - b);
  const nominalStep = differences.length ? differences[Math.floor(differences.length / 2)] : 300000;
  const path = (column: FeedColumn) => {
    let result = '', open = false, previous = 0;
    points.forEach((row, index) => {
      const value = row.values[column.key], instant = Date.parse(row.startUtc!);
      if (!isNumber(value)) { open = false; return; }
      if (previous && instant - previous > nominalStep * 1.6) open = false;
      result += `${open ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
      open = true; previous = instant;
    });
    return result;
  };
  const selectedIndex = hover === null ? null : Math.min(hover, points.length - 1);
  const selected = selectedIndex === null || selectedIndex < 0 ? null : points[selectedIndex];
  const showDates = duration >= 86400000;
  const tickIndices = [...new Set(Array.from({ length: Math.min(6, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(Math.min(6, points.length) - 1, 1))))];
  function nearestIndex(clientX: number, rect: DOMRect) {
    const target = first + Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * W - L) / (W - L - R))) * duration;
    let index = 0, distance = Infinity;
    points.forEach((point, i) => { const next = Math.abs(Date.parse(point.startUtc!) - target); if (next < distance) { distance = next; index = i; } });
    return index;
  }

  return <div className={`mw-chart ${compact ? 'mw-chart-compact' : ''}`}>
    <div className="mw-chart-legend" aria-label={`${title}图例，点击显示或隐藏曲线`}>
      {columns.map(column => <button key={column.key} type="button" aria-pressed={enabled.includes(column.key)} className={!enabled.includes(column.key) ? 'mw-legend-off' : ''} onClick={() => setEnabled(current => current.includes(column.key) ? current.filter(key => key !== column.key) : [...current, column.key])}><i style={{ background: colorFor(column) }} /><span>{column.label}</span>{column.kind === 'forecast' && <small>预测</small>}</button>)}
    </div>
    {!points.length || !values.length ? <div className="mw-chart-empty"><Activity size={28} /><strong>{enabled.length ? '该条件下暂无有效时序' : '选择上方图例以显示曲线'}</strong><span>空值保持为空，时间歧义的数据不绘入曲线。</span></div> : <div className="mw-chart-plot" role="group" tabIndex={0} aria-label={`${title}，左右方向键查看时间点，Escape清除`} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setHover(value => Math.min((value ?? -1) + 1, points.length - 1)); } if (event.key === 'ArrowLeft') { event.preventDefault(); setHover(value => Math.max((value ?? 1) - 1, 0)); } if (event.key === 'Escape') setHover(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onPointerMove={event => setHover(nearestIndex(event.clientX, event.currentTarget.getBoundingClientRect()))} onPointerLeave={() => setHover(null)} onClick={event => setHover(nearestIndex(event.clientX, event.currentTarget.getBoundingClientRect()))}>
        <text x={L} y="11" className="mw-axis-unit">{unit}</text>
        {Array.from({ length: 5 }, (_, i) => { const value = min + (max - min) * i / 4; return <g key={i}><line x1={L} x2={W - R} y1={y(value)} y2={y(value)} stroke="#e6ece8" strokeDasharray="3 5" /><text x={L - 12} y={y(value) + 4} textAnchor="end" className="mw-axis-label">{numberText(value, Math.abs(value) < 10 ? 1 : 0)}</text></g>; })}
        {min < 0 && max > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#99aca5" strokeDasharray="5 5" />}
        {tickIndices.map((index, i) => <text key={index} x={x(index)} y={H - 9} textAnchor={i === 0 ? 'start' : i === tickIndices.length - 1 ? 'end' : 'middle'} className="mw-axis-label">{dateTimeText(points[index].startUtc, zone, showDates)}</text>)}
        {activeColumns.map(column => <path key={column.key} d={path(column)} fill="none" stroke={colorFor(column)} strokeWidth={column.kind === 'forecast' ? 1.9 : 2.5} strokeDasharray={column.kind === 'forecast' ? '7 4' : undefined} strokeLinecap="round" strokeLinejoin="round" />)}
        {selected && selectedIndex !== null && <g><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={T} y2={H - B} stroke="#668d84" strokeDasharray="3 4" />{activeColumns.map(column => isNumber(selected.values[column.key]) && <circle key={column.key} cx={x(selectedIndex)} cy={y(selected.values[column.key]!)} r="3.5" fill={colorFor(column)} stroke="white" strokeWidth="1.7" />)}</g>}
      </svg>
      {selected && selectedIndex !== null && <div className="mw-chart-tooltip" style={{ left: `${Math.min(70, Math.max(4, x(selectedIndex) / W * 100))}%` }} role="status"><strong>{dateTimeText(selected.startUtc, zone, true)} <small>{zone === 'America/Los_Angeles' ? 'PT' : zone === 'UTC' ? 'UTC' : '北京'}</small></strong>{activeColumns.slice(0, 9).map(column => <div key={column.key}><span>{column.label}</span><b>{numberText(selected.values[column.key], 1)}<small> {column.unit}</small></b></div>)}</div>}
    </div>}
  </div>;
}
