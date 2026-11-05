'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BatteryCharging, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Clock3, Database, ExternalLink, FileText, Globe2, Info, LayoutDashboard, Menu, Search, ShieldCheck, TrendingUp, Wind, X, Zap } from 'lucide-react';
import type { BootstrapData, Market } from '@/lib/types';
import { HUBS } from '@/lib/types';
import type { DataArchive, DataFeed } from '@/lib/data-types';
import { buildHourlyRows, mean } from '@/lib/analytics';
import { FeedPanel, FeedStatus, ForecastPanel, FORECAST_OPTIONS, MetricCard, SOURCE_LABELS, downloadFeed, latestMetric } from '@/components/fundamental-panels';
import { dateTimeText, isNumber, numberText, type DisplayZone } from '@/components/series-chart';
import DataReadiness from '@/components/data-readiness';
import '@/app/market-workspace.css';

type Section = 'overview' | 'prices' | 'fundamentals' | 'sources';
type FundamentalTab = 'demand' | 'supply' | 'forecast' | 'capacity';
type FeedCatalog = { id: string; title: string; source: 'outlook' | 'oasis'; description: string };
const NAV = [
  { id: 'overview' as Section, label: '市场总览', icon: LayoutDashboard, subtitle: '先看全局，再进入细节' },
  { id: 'prices' as Section, label: '价格分析', icon: TrendingUp, subtitle: '日前、实时与小时价差' },
  { id: 'fundamentals' as Section, label: '供需与预测', icon: Activity, subtitle: '需求、供给与官方预测' },
  { id: 'sources' as Section, label: '数据中心', icon: Database, subtitle: '来源、质量与数据导出' },
];
const OUTLOOK_CATALOG: FeedCatalog[] = [
  { id: 'demand', title: '实际负荷与预测', source: 'outlook', description: '实际、日前、小时前需求' },
  { id: 'netdemand', title: '净负荷趋势', source: 'outlook', description: '需求扣除风电、光伏' },
  { id: 'fuelsource', title: '发电结构与进口', source: 'outlook', description: '各类电源及进口功率' },
  { id: 'storage', title: '电池与混合资源', source: 'outlook', description: '总量、独立电池、混合资源' },
  { id: 'hybrids', title: '混合资源出力', source: 'outlook', description: '混合资源的出力分项' },
  { id: 'wind_solar_wo_hybrids', title: '非混合资源风光', source: 'outlook', description: '不含混合资源的风光序列' },
  { id: 'co2', title: '碳排放趋势', source: 'outlook', description: '运行排放估计，保留原始单位' },
  { id: 'rtm_forecast', title: '当日资源充裕度', source: 'outlook', description: 'RA 容量、需求与备用要求' },
  { id: 'rtm_forecast_7day', title: '未来七日资源充裕度', source: 'outlook', description: '未来容量与需求预测' },
  { id: 'stats', title: '当前系统状态', source: 'outlook', description: '运行状态、备用与峰值' },
  { id: 'peak_and_daily', title: '可再生能源日统计', source: 'outlook', description: '峰值及日累计生产，历史日数据' },
  { id: 'peak_and_daily_hybrids', title: '混合资源日统计', source: 'outlook', description: '峰值及日累计生产，历史日数据' },
  { id: 'peak_and_daily_storage', title: '储能日统计', source: 'outlook', description: '峰值及日累计量，历史日数据' },
];
const FORECAST_CATALOG: FeedCatalog[] = FORECAST_OPTIONS.map(option => ({ id: option.id, title: option.note, source: 'oasis', description: option.group === 'load' ? '官方区域负荷数据' : '官方区域风光数据' }));
const PRICE_CATALOG: FeedCatalog[] = [
  { id: 'price_dam', title: '日前节点价格 DA', source: 'oasis', description: '小时 LMP 与价格组成' },
  { id: 'price_fmm', title: '15 分钟节点价格 FMM', source: 'oasis', description: '15 分钟 LMP 与价格组成' },
  { id: 'price_rtd', title: '5 分钟节点价格 RTD', source: 'oasis', description: '5 分钟 LMP 与价格组成' },
];
const ALL_CATALOG = [...PRICE_CATALOG, ...OUTLOOK_CATALOG, ...FORECAST_CATALOG];
const ZONES: Record<DisplayZone, string> = { 'America/Los_Angeles': '太平洋时间 PT', 'Asia/Shanghai': '北京时间', UTC: 'UTC' };
const isAvailable = (feed: DataFeed | undefined) => !!feed && ['ok', 'partial'].includes(feed.status) && !!(feed.rows.length || feed.table?.rows.length || feed.stats);
const noLoading = new Set<string>();

function priceFeeds(bootstrap: BootstrapData, date: string): Record<string, DataFeed> {
  const output: Record<string, DataFeed> = {};
  (['DAM', 'FMM', 'RTD'] as Market[]).forEach(market => {
    const original = bootstrap.markets[market]; if (!original) return;
    const intervals = original.intervals.filter(row => row.localDate === date && row.node === HUBS[0].id);
    if (!intervals.length) return;
    const id = `price_${market.toLowerCase()}`;
    output[id] = { id, title: PRICE_CATALOG.find(item => item.id === id)!.title, source: 'oasis', status: original.ok ? 'ok' : 'error', sourceUrl: original.sourceUrl, fetchedAt: original.fetchedAt, requestedDate: date, dataDate: date, timeZone: 'America/Los_Angeles', unit: '$/MWh', intervalMinutes: market === 'DAM' ? 60 : market === 'FMM' ? 15 : 5, columns: [{ key: 'price', label: 'NP15 LMP', unit: '$/MWh', kind: 'actual', primary: true }, ...['MCE', 'MCC', 'MCL', 'MGHG'].map(key => ({ key, label: key, unit: '$/MWh' }))], rows: intervals.map(row => ({ startUtc: row.startUtc, endUtc: row.endUtc, values: { price: row.quality === 'ok' ? row.price : null, ...row.components }, quality: row.quality === 'ok' ? 'ok' as const : 'missing' as const })), warnings: original.warnings, notes: ['此处为 NP15 的已验证价格快照；三个枢纽的完整归档请进入价格分析。', '零价格、负价格有效；所有价格均为美元/MWh。'] };
  });
  return output;
}

function PriceGlance({ bootstrap, onOpen }: { bootstrap: BootstrapData; onOpen: () => void }) {
  const stats = HUBS.map(hub => { const rows = buildHourlyRows(bootstrap.markets, hub.id, bootstrap.endDate, bootstrap.endDate); return { hub, da: mean(rows.map(row => row.dam)), fmm: mean(rows.map(row => row.fmm)), spread: mean(rows.filter(row => isNumber(row.dam) && isNumber(row.fmm)).map(row => row.spread)) }; });
  return <section className="mw-panel mw-price-glance"><div className="mw-panel-heading"><div><span className="mw-section-eyebrow">LATEST VERIFIED FULL DAY</span><h2>三个枢纽，一眼比较</h2><p>价格快照 · {bootstrap.endDate} PT · $/MWh</p></div><span className="mw-small-tag">完整日</span></div><div className="mw-glance-grid"><div className="mw-glance-head"><span>枢纽</span><span>DA 均价</span><span>FMM − DA</span></div>{stats.map(item => <div className="mw-glance-row" key={item.hub.id}><span><strong>{item.hub.short}</strong><small>{item.hub.name}</small></span><b>{numberText(item.da, 2)}</b><b className={isNumber(item.spread) && item.spread < 0 ? 'mw-negative' : 'mw-positive'}>{isNumber(item.spread) && item.spread > 0 ? '+' : ''}{numberText(item.spread, 2)}</b></div>)}</div><div className="mw-price-glance-note">价差仅统计 DA 与 4 个 FMM 时段均完整的小时，不代表交易收益。</div><button type="button" className="mw-wide-link" onClick={onOpen}>打开价格分析<ArrowRight size={16} /></button></section>;
}

interface MarketWorkspaceProps {
  priceBootstrap: BootstrapData;
  outlookArchive: DataArchive;
  fundamentalArchive: DataArchive;
  children: ReactNode;
}

export default function MarketWorkspace({ priceBootstrap, outlookArchive, fundamentalArchive, children }: MarketWorkspaceProps) {
  const dates = [...new Set([...Object.keys(outlookArchive.byDate), ...Object.keys(fundamentalArchive.byDate)])].sort();
  const initialDate = dates.includes(priceBootstrap.endDate) ? priceBootstrap.endDate : dates.at(-1) || priceBootstrap.endDate;
  const [section, setSection] = useState<Section>('overview');
  const [fundamentalTab, setFundamentalTab] = useState<FundamentalTab>('demand');
  const [date, setDate] = useState(initialDate);
  const [zone, setZone] = useState<DisplayZone>('America/Los_Angeles');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [inspected, setInspected] = useState('demand');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [supplyExtra, setSupplyExtra] = useState('hybrids');
  const [raId, setRaId] = useState('rtm_forecast_7day');
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  useEffect(() => { const readHash = () => { const hash = window.location.hash.slice(1).split('/')[0]; if (NAV.some(item => item.id === hash)) setSection(hash as Section); }; readHash(); window.addEventListener('hashchange', readHash); return () => window.removeEventListener('hashchange', readHash); }, []);
  const currentOutlook = outlookArchive.byDate[date];
  const currentFundamental = fundamentalArchive.byDate[date];
  const feeds = useMemo(() => ({ ...priceFeeds(priceBootstrap, date), ...currentOutlook?.feeds, ...currentFundamental?.feeds }), [priceBootstrap, date, currentOutlook, currentFundamental]);
  const available = ALL_CATALOG.filter(item => isAvailable(feeds[item.id]));
  const freshest = Object.values(feeds).filter(isAvailable).map(feed => feed.fetchedAt).filter(Boolean).sort().at(-1);
  const demand = latestMetric(feeds.demand, ['demandActual']);
  const netDemand = latestMetric(feeds.netdemand, ['netDemand']);
  const solar = latestMetric(feeds.fuelsource, ['solar']);
  const wind = latestMetric(feeds.fuelsource, ['wind']);
  const battery = latestMetric(feeds.storage, ['batteriesStandalone']);
  const stats = isAvailable(feeds.stats) && feeds.stats.dataDate === date ? feeds.stats.stats : undefined;
  const statsTime = typeof stats?.slotDate === 'string' ? stats.slotDate : null;
  const reserve = isNumber(stats?.Current_reserve) ? stats.Current_reserve : null;
  const gridState = Array.isArray(stats?.gridstatus) ? '归档状态：' + stats.gridstatus.join(' · ') : '历史交易日';
  const actualRow = feeds.demand?.dataDate === date ? feeds.demand?.rows.filter(row => row.startUtc && isNumber(row.values.demandActual)).at(-1) : undefined;
  const loadDelta = actualRow && isNumber(actualRow.values.demandDayAhead) && isNumber(actualRow.values.demandActual) ? actualRow.values.demandActual - actualRow.values.demandDayAhead : null;
  const filteredCatalog = ALL_CATALOG.filter(item => (sourceFilter === 'all' || item.source === sourceFilter) && `${item.title} ${item.id} ${item.description}`.toLowerCase().includes(search.toLowerCase().trim()));

  function navigate(next: Section, tab?: FundamentalTab) { setSection(next); if (tab) setFundamentalTab(tab); setMobileOpen(false); window.history.replaceState(null, '', `#${next}`); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function chooseDate(next: string) { if (dates.includes(next)) setDate(next); }
  function goForecast() { setFundamentalTab('forecast'); }

  return <div className="market-workspace">
    {mobileOpen && <button type="button" className="mw-nav-overlay" aria-label="关闭导航遮罩" onClick={() => setMobileOpen(false)} />}
    <aside className={`mw-sidebar ${mobileOpen ? 'mw-sidebar-open' : ''}`}><a className="mw-brand" href="#overview" onClick={event => { event.preventDefault(); navigate('overview'); }}><span><Zap size={24} strokeWidth={1.8} /></span><div>CAISO<small>MARKET DESK</small></div></a><div className="mw-workspace-label"><span>US WEST</span><div><strong>加州电力市场</strong><small>只读分享版</small></div><Globe2 size={16} /></div><span className="mw-nav-label">市场研究</span><nav aria-label="主导航">{NAV.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon size={18} /><span>{item.label}</span>{section === item.id && <i />}</button>; })}</nav><div className="mw-sidebar-bottom"><div className="mw-sidebar-health"><span className="mw-status-dot" /><div><strong>官方来源，可追溯</strong><small>OASIS + Today’s Outlook</small></div></div><a href="https://www.caiso.com/todays-outlook" target="_blank" rel="noreferrer">打开 CAISO 官网<ExternalLink size={13} /></a><p>研究与信息展示<br />预测、实际与价格口径分别保留</p></div><button type="button" className="mw-mobile-close" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X size={20} /></button></aside>
    <div className="mw-main"><header className="mw-topbar"><div><button type="button" className="mw-mobile-menu" aria-label="打开主导航" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={21} /></button><span>CAISO</span><ChevronRight size={13} /><strong>{NAV.find(item => item.id === section)?.label}</strong></div><div><span className="mw-topbar-source"><span className="mw-status-dot" />官方数据快照 · 只读分享版</span><span className="mw-avatar">CA</span></div></header>
      <main className="mw-content">
        {section !== 'prices' && <><div className="mw-page-heading"><div><span className="mw-section-eyebrow">{section === 'overview' ? 'CALIFORNIA · POWER MARKET' : section === 'fundamentals' ? 'SUPPLY, DEMAND & FORECASTS' : 'SOURCES & DATA QUALITY'}</span><h1>{section === 'overview' ? '看清市场的每一次变化' : section === 'fundamentals' ? '供需与官方预测' : '每一条数据，都有来处'}</h1><p>{section === 'overview' ? '查看已归档的价格、负荷与供给。各图表保留其数据日期，不代表实时行情。' : section === 'fundamentals' ? '按任务切换视图，保留预测粒度、区域范围与源数据口径。' : '查找数据日期、原始来源和下载文件。'}</p></div>{section === 'overview' && <button className="mw-button secondary" onClick={() => navigate('sources')}><Database size={15} />数据中心<ArrowUpRight size={14} /></button>}</div>
          <div className="mw-toolbar"><label className="mw-date-label"><CalendarDays size={16} /><span>供需快照日期 <small>PT</small></span><select style={{border:0,background:"transparent",font:"inherit",color:"inherit",minWidth:110}} aria-label="供需快照日期（太平洋时间）" value={date} onChange={event => chooseDate(event.target.value)}>{dates.map(d => <option key={d}>{d}</option>)}</select></label><label className="mw-zone-label"><Clock3 size={14} /><select aria-label="供需数据展示时区" value={zone} onChange={event => setZone(event.target.value as DisplayZone)}>{Object.entries(ZONES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} /></label><a className="mw-text-link mw-refresh" href="#prices/prediction">查看电价预测<ArrowRight size={15} /></a></div>
          <div className="mw-data-context"><span className="mw-context-badge"><Database size={12} />已归档 · 非实时</span><span>{date} PT</span><span className="mw-context-time">来源获取于 {dateTimeText(freshest, zone, true)} {zone === 'America/Los_Angeles' ? 'PT' : zone === 'UTC' ? 'UTC' : '北京'}</span><button type="button" onClick={() => navigate('sources')}>{available.length} / {ALL_CATALOG.length} 组可用<ChevronRight size={12} /></button></div>
        </>}

        <div hidden={section !== 'overview'} className="mw-section-stack">
          <div className="mw-overview-status"><span><span className="mw-status-dot" />{gridState === 'Normal' ? '电网状态正常' : gridState}</span><span>卡片显示所选日最后可用值，各指标保留自己的数据时间。</span></div>
          <section className="mw-metrics" aria-label="系统基本面摘要"><MetricCard title="系统负荷" value={demand.value} time={demand.time} zone={zone} accent onClick={() => navigate('fundamentals', 'demand')} /><MetricCard title="净负荷" value={netDemand.value} time={netDemand.time} zone={zone} onClick={() => navigate('fundamentals', 'demand')} /><MetricCard title="光伏出力" value={solar.value} time={solar.time} zone={zone} onClick={() => navigate('fundamentals', 'supply')} /><MetricCard title="风电出力" value={wind.value} time={wind.time} zone={zone} onClick={() => navigate('fundamentals', 'supply')} /><MetricCard title="独立电池净出力" value={battery.value} time={battery.time} zone={zone} label="负值充电 · 正值放电" onClick={() => navigate('fundamentals', 'supply')} /><MetricCard title="快照备用容量" value={reserve} zone={zone} label={statsTime ? `归档摘要 ${statsTime} PT` : '该日未归档状态摘要'} onClick={() => navigate('fundamentals', 'capacity')} /></section>
          <div className="mw-overview-grid"><FeedPanel feed={feeds.demand} title="负荷与预测，是否发生偏离？" subtitle="实际需求与日前、小时前预测对照" zone={zone} preferredKeys={['demandActual', 'demandDayAhead', 'demandHourAhead']} compact onInspect={() => navigate('fundamentals', 'demand')} footer={isNumber(loadDelta) ? `最后可比时点，实际负荷较日前预测 ${loadDelta > 0 ? '+' : ''}${numberText(loadDelta)} MW。` : '需求不含可调度抽水负荷及电池充电。'} /><PriceGlance bootstrap={priceBootstrap} onOpen={() => navigate('prices')} /></div>
          <div className="mw-overview-bottom"><button className="mw-explore-card" onClick={() => navigate('fundamentals', 'supply')}><span className="mw-explore-icon"><Wind size={22} /></span><div><h3>风光与储能</h3><p>查看供给结构、充放电与进口趋势。</p></div><ArrowRight size={18} /></button><button className="mw-explore-card" onClick={() => { navigate('fundamentals'); goForecast(); }}><span className="mw-explore-icon amber"><TrendingUp size={22} /></span><div><h3>官方预测</h3><p>按市场、提前时间和区域逐组查看。</p></div><ArrowRight size={18} /></button><button className="mw-explore-card" onClick={() => navigate('fundamentals', 'capacity')}><span className="mw-explore-icon blue"><ShieldCheck size={22} /></span><div><h3>未来供需状况</h3><p>查看七日 RA、备用要求与排放。</p></div><ArrowRight size={18} /></button></div>
        </div>

        <div hidden={section !== 'prices'} className="mw-price-workspace">{children}</div>

        <div hidden={section !== 'fundamentals'} className="mw-section-stack"><div className="mw-subtabs" role="tablist" aria-label="供需分析视图">{([{ id: 'demand', label: '需求与净负荷', icon: Activity }, { id: 'supply', label: '供给与储能', icon: BatteryCharging }, { id: 'forecast', label: '官方预测', icon: TrendingUp }, { id: 'capacity', label: '充裕度与排放', icon: ShieldCheck }] as const).map(tab => <button key={tab.id} type="button" role="tab" aria-selected={fundamentalTab === tab.id} className={fundamentalTab === tab.id ? 'active' : ''} onClick={() => tab.id === 'forecast' ? goForecast() : setFundamentalTab(tab.id)}><tab.icon size={16} />{tab.label}</button>)}</div>
          <div hidden={fundamentalTab !== 'demand'} className="mw-section-stack"><FeedPanel feed={feeds.demand} title="负荷：实际与预测" subtitle="日前原生为小时预测，小时前及实际为 5 分钟平均。" zone={zone} preferredKeys={['demandActual', 'demandDayAhead', 'demandHourAhead']} /><FeedPanel feed={feeds.netdemand} title="净负荷：需求扣除风光" subtitle="观察日内净负荷变化，系统口径不代表某一节点的供需。" zone={zone} preferredKeys={['netDemand', 'netDemandForecast', 'demandActual']} footer="需求及净需求均不包含可调度抽水、电池充电；不能再重复扣减充电负荷。" /></div>
          <div hidden={fundamentalTab !== 'supply'} className="mw-section-stack"><FeedPanel feed={feeds.fuelsource} title="供给结构与进口" subtitle="默认显示主要供给，点击图例加入其他资源。各序列保留官方符号。" zone={zone} preferredKeys={['solar', 'wind', 'naturalGas', 'imports', 'batteriesTotal']} /><FeedPanel feed={feeds.storage} title="电池与混合资源运行" subtitle="独立电池单列。总量和混合资源可能包含风光组件，不作为荷电状态。" zone={zone} preferredKeys={['batteriesStandalone', 'batteriesTotal', 'batteriesHybrid']} footer="负值表示充电、正值表示放电。不同列不强制平衡，不据此推算 SOC。" /><div className="mw-group-heading"><div><span className="mw-section-eyebrow">MORE SUPPLY DATA</span><h2>进一步查看</h2></div><label className="mw-select-label">数据集<select aria-label="供给补充数据集" value={supplyExtra} onChange={event => setSupplyExtra(event.target.value)}>{OUTLOOK_CATALOG.filter(item => ['hybrids', 'wind_solar_wo_hybrids', 'peak_and_daily', 'peak_and_daily_hybrids', 'peak_and_daily_storage'].includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div><FeedPanel feed={feeds[supplyExtra]} title={OUTLOOK_CATALOG.find(item => item.id === supplyExtra)?.title} zone={zone} /></div>
          <div hidden={fundamentalTab !== 'forecast'}><ForecastPanel feeds={feeds} zone={zone} loading={noLoading} /></div>
          <div hidden={fundamentalTab !== 'capacity'} className="mw-section-stack"><div className="mw-group-heading"><div><span className="mw-section-eyebrow">RESOURCE ADEQUACY</span><h2>资源充裕度与备用要求</h2></div><div className="mw-segment"><button className={raId === 'rtm_forecast' ? 'active' : ''} onClick={() => setRaId('rtm_forecast')}>当日</button><button className={raId === 'rtm_forecast_7day' ? 'active' : ''} onClick={() => setRaId('rtm_forecast_7day')}>未来七日</button></div></div><FeedPanel feed={feeds[raId]} title={raId === 'rtm_forecast_7day' ? '未来七日：容量与需求预测' : '当日：容量与需求'} subtitle="查询日期为展望文件日期，覆盖当天及未来 7 天；RA 容量不等于承诺可用容量。" zone={zone} preferredKeys={['raCapacity', 'demandDayAhead', raId === 'rtm_forecast_7day' ? 'reserveForecast' : 'reserveRequirement']} /><FeedPanel feed={feeds.co2} title="碳排放运行估计" subtitle="用于观察系统排放变化，正式排放数据以 CARB 为准。" zone={zone} /></div>
        </div>

        <div hidden={section !== 'sources'} className="mw-section-stack"><DataReadiness active={section === 'sources'} /><div className="mw-source-summary"><article><Database size={21} /><div><strong>{ALL_CATALOG.length}</strong><span>归档数据目录</span></div></article><article><CheckCircle2 size={21} /><div><strong>{available.length}</strong><span>所选日可用数据集</span></div></article><article><Clock3 size={21} /><div><strong>{dates.length}</strong><span>预载官方验证日期</span></div></article><article><ShieldCheck size={21} /><div><strong>只读</strong><span>数据查看与导出</span></div></article></div><div className="mw-notice"><Info size={16} /><span>“已获取”表示对应日期存在来源数据；历史快照不会被标记为实时行情。价格数据在这里默认查看 NP15，完整节点功能位于价格分析。</span></div><div className="mw-catalog-layout"><section className="mw-panel mw-catalog"><div className="mw-panel-heading"><h2>数据目录</h2><span className="mw-small-tag">{filteredCatalog.length} 组</span></div><div className="mw-catalog-filters"><label className="mw-search"><Search size={15} /><input aria-label="搜索数据集" placeholder="搜索负荷、风光、储能…" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="mw-segment"><button className={sourceFilter === 'all' ? 'active' : ''} onClick={() => setSourceFilter('all')}>全部</button><button className={sourceFilter === 'outlook' ? 'active' : ''} onClick={() => setSourceFilter('outlook')}>Outlook</button><button className={sourceFilter === 'oasis' ? 'active' : ''} onClick={() => setSourceFilter('oasis')}>OASIS</button></div></div><div className="mw-catalog-items">{filteredCatalog.map(item => <button key={item.id} type="button" className={inspected === item.id ? 'selected' : ''} aria-pressed={inspected === item.id} onClick={() => setInspected(item.id)}><span className={`mw-feed-source-mark ${item.source}`}><Database size={16} /></span><div><strong>{item.title}</strong><small>{item.id}</small><span>{feeds[item.id]?.rows.length ? `${feeds[item.id].rows.length.toLocaleString()} 个时段` : feeds[item.id]?.table?.rows.length ? `${feeds[item.id].table!.rows.length} 条统计` : item.description}</span></div><FeedStatus feed={feeds[item.id]} /><ChevronRight size={14} /></button>)}{!filteredCatalog.length && <div className="mw-chart-empty"><Search size={24} /><span>未找到匹配的数据集</span></div>}</div></section><div className="mw-source-inspector"><FeedPanel key={inspected} feed={feeds[inspected]} title={ALL_CATALOG.find(item => item.id === inspected)?.title} subtitle={ALL_CATALOG.find(item => item.id === inspected)?.description} columns={feeds[inspected]?.source === 'oasis' && !inspected.startsWith('price_') ? feeds[inspected].columns.filter(column => column.primary) : undefined} zone={zone} /><section className="mw-panel mw-source-detail"><div className="mw-panel-heading"><h2>来源与数据口径</h2><FileText size={18} /></div>{feeds[inspected] ? <div className="mw-source-detail-body"><dl><div><dt>发布来源</dt><dd>{SOURCE_LABELS[feeds[inspected].source]}</dd></div><div><dt>所选日期</dt><dd>{date} PT</dd></div><div><dt>来源日期</dt><dd>{feeds[inspected].dataDate || '未提供'}</dd></div><div><dt>获取时间</dt><dd>{dateTimeText(feeds[inspected].fetchedAt, zone, true)} · {ZONES[zone]}</dd></div><div><dt>数据模式</dt><dd>已验证官方快照</dd></div><div><dt>原生粒度</dt><dd>{feeds[inspected].intervalMinutes ? `${feeds[inspected].intervalMinutes} 分钟；各列以自身口径为准` : '统计或混合粒度'}</dd></div></dl>{[...feeds[inspected].notes, ...feeds[inspected].warnings].map((note, index) => <p key={index}>{note}</p>)}{feeds[inspected].error && <div className="mw-notice warning"><Info size={15} /><span>{feeds[inspected].error!.message}</span></div>}<div className="mw-action-row"><a className="mw-text-link" href={feeds[inspected].sourceUrl} target="_blank" rel="noreferrer">打开原始数据<ExternalLink size={13} /></a>{isAvailable(feeds[inspected]) && <button className="mw-text-link" onClick={() => downloadFeed(feeds[inspected], undefined, zone)}>导出完整数据<ArrowDownToLine size={13} /></button>}</div></div> : <div className="mw-source-detail-body"><p>该日期没有归档此组数据，可切换到其他日期。</p>{inspected.startsWith('price_') && <button className="mw-button secondary" onClick={() => navigate('prices')}>进入价格分析<ArrowRight size={14} /></button>}</div>}</section></div></div></div>
        <footer className="mw-page-footer"><span><ShieldCheck size={14} />真实来源 · 保留缺失 · 可追溯</span><p>查询日期采用 America/Los_Angeles。切换时区仅改变显示，不改变交易日。</p><button onClick={() => navigate('sources')}>来源与数据质量<ArrowUpRight size={13} /></button></footer>
      </main>
    </div>
  </div>;
}
