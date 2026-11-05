'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Database, LoaderCircle, RefreshCw, Zap } from 'lucide-react';
import MarketWorkspace from '@/components/market-workspace';
import OasisDashboard from '@/components/oasis-dashboard';
import type { BootstrapData } from '@/lib/types';
import type { DataArchive } from '@/lib/data-types';

type BootstrapSet = { prices: BootstrapData; outlook: DataArchive; fundamentals: DataArchive };
const ARCHIVES = [
  { id: 'prices', label: '价格与节点快照', url: '/data/prices-bootstrap.json' },
  { id: 'outlook', label: '负荷、供给与运行状态', url: '/data/outlook_snapshot_2026-10-28_2026-10-29.json' },
  { id: 'fundamentals', label: '官方负荷与风光预测', url: '/data/fundamentals-snapshot.json' },
] as const;
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export default function MarketApp() {
  const [data, setData] = useState<BootstrapSet | null>(null);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true, timedOut = false;
    setLoaded([]); setError('');
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
    async function readArchive(archive: typeof ARCHIVES[number]): Promise<BootstrapData | DataArchive> {
      const response = await fetch(archive.url, { signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${archive.label}载入失败（HTTP ${response.status}）。`);
      const payload: unknown = await response.json();
      const valid = isObject(payload) && (archive.id === 'prices'
        ? typeof payload.startDate === 'string' && typeof payload.endDate === 'string' && isObject(payload.markets)
        : typeof payload.generatedAt === 'string' && isObject(payload.byDate));
      if (!valid) throw new Error(`${archive.label}格式异常，请稍后重试。`);
      if (active) setLoaded(previous => [...previous, archive.id]);
      return payload as unknown as BootstrapData | DataArchive;
    }
    void Promise.all(ARCHIVES.map(readArchive)).then(([prices, outlook, fundamentals]) => {
      if (active) setData({ prices: prices as BootstrapData, outlook: outlook as DataArchive, fundamentals: fundamentals as DataArchive });
    }).catch(reason => {
      if (!active) return;
      setError(timedOut ? '数据载入时间较长，请检查连接后重试。'
        : reason instanceof SyntaxError ? '数据响应暂时无法读取，请刷新页面或稍后重试。'
        : reason instanceof Error ? reason.message : '暂时无法载入数据，请稍后重试。');
      controller.abort();
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);

  if (data) return <MarketWorkspace priceBootstrap={data.prices} outlookArchive={data.outlook} fundamentalArchive={data.fundamentals}>
    <OasisDashboard bootstrap={data.prices} embedded />
  </MarketWorkspace>;

  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f5f7f3' }} aria-busy={!error}>
    <section style={{ width: '100%', maxWidth: 510, border: '1px solid #dfe7da', borderRadius: 14, background: '#fff', padding: '35px 32px', boxShadow: '0 8px 35px #24422a07' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 29, color: '#234d3b' }}><span style={{ display: 'grid', placeItems: 'center', width: 41, height: 43, background: '#edf4e5', border: '1px solid #d6e5c9', borderRadius: 10 }}><Zap size={23} /></span><div><strong style={{ fontSize: 21, letterSpacing: 2 }}>CAISO</strong><span style={{ display: 'block', fontSize: 9, letterSpacing: 1.8, color: '#7b9471' }}>MARKET DESK</span></div></div>
      <div role={error ? 'alert' : 'status'} aria-live="polite"><h1 style={{ fontSize: 21, fontWeight: 600, color: '#315a40', margin: '0 0 9px' }}>{error ? '暂时未能载入市场数据' : '正在准备市场工作台'}</h1><p style={{ fontSize: 13, color: '#75896b', lineHeight: 1.9, margin: '0 0 24px' }}>{error || '正在载入已验证的官方数据。完成后即可查看曲线、比较市场并追溯来源。'}</p></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '17px 0', borderTop: '1px solid #e7ede2', borderBottom: '1px solid #e7ede2' }}>{ARCHIVES.map(archive => <div key={archive.id} style={{ display: 'flex', alignItems: 'center', gap: 9, color: loaded.includes(archive.id) ? '#5e8450' : '#87957c', fontSize: 12 }}>{loaded.includes(archive.id) ? <CheckCircle2 size={16} /> : error ? <AlertCircle size={16} /> : <LoaderCircle size={16} className="mw-spin" />}<span>{archive.label}</span><small style={{ marginLeft: 'auto', fontSize: 10 }}>{loaded.includes(archive.id) ? '已载入' : error ? '待重试' : '读取中'}</small></div>)}</div>
      {error ? <button type="button" className="mw-button primary" style={{ marginTop: 22 }} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />重新载入</button> : <p style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#8c9c7f', fontSize: 11, margin: '20px 0 0' }}><Database size={13} />已载入 {loaded.length} / 3 份数据</p>}
    </section>
  </main>;
}
