import type { DataBundle, DataFeed, FeedColumn, FeedRow } from './data-types';
import { addDays, localDayStartUtc, localParts } from './time';
import { parseCsv } from './oasis';

export const OUTLOOK_IDS = ['demand', 'netdemand', 'fuelsource', 'storage', 'hybrids', 'co2', 'rtm_forecast', 'rtm_forecast_7day', 'wind_solar_wo_hybrids', 'stats', 'peak_and_daily', 'peak_and_daily_hybrids', 'peak_and_daily_storage'] as const;
export type OutlookId = typeof OUTLOOK_IDS[number];
type ColumnDefinition = [string, string, FeedColumn['kind']?, number?];
interface FeedDefinition { title: string; unit: string; columns?: Record<string, ColumnDefinition>; notes: string[]; }
const demandNotes = ['需求和净需求不含可调度抽水负荷及电池充电负荷。', '日前预测原生为小时平均；在 5 分钟 CSV 上展示不代表预测精度提高。', '仅作信息参考，不用于账单结算或运行规划。'];
const raColumns: Record<string, ColumnDefinition> = {
  Demand: ['demandActual', '实际负荷', 'actual', 5], 'Net Demand': ['netDemand', '实际净负荷', 'actual', 5],
  'Day-ahead demand forecast': ['demandDayAhead', '日前负荷预测', 'forecast', 60],
  'Day-ahead net demand forecast': ['netDemandForecast', '日前净负荷预测', 'forecast', 60],
  'Resource adequacy capacity forecast': ['raCapacity', 'RA 容量预测', 'capacity', 60],
  'Net resource adequacy capacity forecast': ['raNetCapacity', '净 RA 容量预测', 'capacity', 60],
  'Reserve requirement': ['reserveRequirement', '备用要求', 'reserve', 60],
  'Reserve requirement forecast': ['reserveForecast', '备用要求预测', 'forecast', 60],
  'Resource adequacy credits': ['raCredits', 'RA 抵扣量', 'capacity', 60],
};
export const OUTLOOK_DEFINITIONS: Record<OutlookId, FeedDefinition> = {
  demand: { title: '负荷与预测', unit: 'MW', columns: {
    'Day ahead forecast': ['demandDayAhead', '日前负荷预测', 'forecast', 60], 'Hour ahead forecast': ['demandHourAhead', '小时前负荷预测', 'forecast', 5],
    'Current demand': ['demandActual', '实际负荷', 'actual', 5], 'Demand response': ['demandResponse', '需求响应', 'actual', 5],
  }, notes: demandNotes },
  netdemand: { title: '净负荷', unit: 'MW', columns: {
    'Hour ahead forecast': ['demandHourAhead', '小时前负荷预测', 'forecast', 5], 'Current demand': ['demandActual', '实际负荷', 'actual', 5],
    'Net demand': ['netDemand', '实际净负荷', 'actual', 5], 'Net demand forecast': ['netDemandForecast', '日前净负荷预测', 'forecast', 60],
    'Demand response': ['demandResponse', '需求响应', 'actual', 5],
  }, notes: [...demandNotes, '净负荷 = 需求减风电、光伏；这里保留 CAISO 发布的净负荷序列，不自行混合其他口径重算。'] },
  fuelsource: { title: '发电结构与进口', unit: 'MW', columns: {
    Solar: ['solar', '光伏', 'actual', 5], Wind: ['wind', '风电', 'actual', 5], Geothermal: ['geothermal', '地热', 'actual', 5],
    Biomass: ['biomass', '生物质', 'actual', 5], Biogas: ['biogas', '沼气', 'actual', 5], 'Small hydro': ['smallHydro', '小水电', 'actual', 5],
    Coal: ['coal', '煤电', 'actual', 5], Nuclear: ['nuclear', '核电', 'actual', 5], 'Natural Gas': ['naturalGas', '燃气', 'actual', 5],
    'Large Hydro': ['largeHydro', '大水电', 'actual', 5], Batteries: ['batteriesTotal', '电池汇总', 'actual', 5], Imports: ['imports', '进口', 'actual', 5], Other: ['other', '其他', 'actual', 5],
  }, notes: ['5 分钟平均出力；负值保留来源值，不截断为零。', '进口为平衡区汇总，不能据此推断具体节点或联络线拥塞。', '电池汇总可能含部分混合资源，不代表纯电池出力。'] },
  storage: { title: '储能运行', unit: 'MW', columns: {
    'Total batteries': ['batteriesTotal', '电池总量', 'actual', 5], 'Stand-alone batteries': ['batteriesStandalone', '独立电池', 'actual', 5], 'Hybrid batteries': ['batteriesHybrid', '混合资源电池', 'actual', 5],
  }, notes: ['负值表示充电，正值表示放电；这是功率，不是荷电状态 SOC。', '电池总量可能包含部分混合资源及风光出力；总量不保证等于独立电池与混合资源之和。', '2023 年起部分混合资源逐步转入独立图表，跨时期比较需注意口径变化。'] },
  hybrids: { title: '混合资源', unit: 'MW', columns: {
    'Total hybrids': ['hybridsTotal', '混合资源总量', 'actual', 5], 'Hybrid solar': ['hybridSolar', '混合资源光伏', 'actual', 5], 'Hybrid wind': ['hybridWind', '混合资源风电', 'actual', 5],
    'Hybrid batteries': ['batteriesHybrid', '混合资源电池', 'actual', 5], 'Renewable hybrids': ['renewableHybrids', '可再生混合资源', 'actual', 5], 'Non-renewable hybrids': ['nonRenewableHybrids', '非可再生混合资源', 'actual', 5],
  }, notes: ['混合资源与其他汇总序列可能存在覆盖关系，不应相加作为总供给。', '保留官方各列原值，不强行平衡总量与组成项。'] },
  co2: { title: '碳排放估计', unit: 'tCO₂/h', columns: {
    'Biogas CO2': ['co2Biogas', '沼气排放', 'actual', 5], 'Biomass CO2': ['co2Biomass', '生物质排放', 'actual', 5],
    'Natural Gas CO2': ['co2NaturalGas', '燃气排放', 'actual', 5], 'Coal CO2': ['co2Coal', '煤电排放', 'actual', 5],
    'Imports CO2': ['co2Imports', '进口排放', 'actual', 5], 'Geothermal CO2': ['co2Geothermal', '地热排放', 'actual', 5],
  }, notes: ['5 分钟平均的排放速率，单位为公吨 CO₂/小时，不是该 5 分钟的排放总量。', 'CAISO 的近似估计仅供信息展示；正式排放数据以 CARB 为准。'] },
  rtm_forecast: { title: '当日资源充裕度', unit: 'MW', columns: raColumns, notes: [...demandNotes, 'RA 为指定参与市场的容量，不能视作可随时调用的保证容量。', '保留源时间标签；不同容量及备用系列原生粒度为小时。'] },
  rtm_forecast_7day: { title: '未来 7 天资源充裕度', unit: 'MW', columns: raColumns, notes: [...demandNotes, '文件按发布日期归档，覆盖当天及未来 7 天；不能当作这些未来日期已经发生的实际运行。', 'D+1 至 D+7 日前预测通常在 05:30–09:30 PT 更新；本接口不虚构文件内未提供的精确预测发布时间。', '保留源时间标签，不将下载时刻伪装成预测发布时刻。'] },
  wind_solar_wo_hybrids: { title: '风光出力（不含混合资源）', unit: 'MW', columns: {
    'Solar without hybrids': ['solarWithoutHybrids', '光伏（不含混合）', 'actual', 5], 'Wind without hybrids': ['windWithoutHybrids', '风电（不含混合）', 'actual', 5],
  }, notes: ['此序列明确不含混合资源，避免与总风光出力混用。'] },
  stats: { title: '系统状态摘要', unit: 'MW', notes: ['仅提供当前状态，历史日期不返回当前摘要冒充历史状态。', '摘要各字段有独立时间戳；当前需求与趋势平均值可能使用不同统计口径。'] },
  peak_and_daily: { title: '可再生能源与负荷日统计', unit: 'MW / MWh', notes: ['历史日的官方峰值及日电量；峰值可能使用更细采样，不能用 5 分钟曲线峰值强行替代。', '当日统计未发布时明确显示未发布。'] },
  peak_and_daily_hybrids: { title: '混合资源日统计', unit: 'MW / MWh', notes: ['官方历史日峰值与日电量；混合资源分类可能相互覆盖，不将所有行简单相加。'] },
  peak_and_daily_storage: { title: '储能日统计', unit: 'MW / MWh', notes: ['日报负日电量表示净充电；不能当成总充电量或总放电量。', '独立电池、混合资源与总量分别保留，不能保证加总恒等。'] },
};

export class OutlookError extends Error { constructor(public code: string, message: string, public status = 502) { super(message); this.name = 'OutlookError'; } }
export function validOutlookDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new OutlookError('INVALID_DATE', '日期必须是有效的 YYYY-MM-DD。', 400);
  return date;
}
export function isOutlookId(id: string): id is OutlookId { return (OUTLOOK_IDS as readonly string[]).includes(id); }
export function outlookSourceUrl(id: OutlookId, date: string, today = localParts(new Date()).localDate) {
  validOutlookDate(date);
  if (!isOutlookId(id)) throw new OutlookError('INVALID_FEED', '数据集不在公开源白名单中。', 400);
  const base = date === today ? 'current' : `history/${date.replaceAll('-', '')}`;
  return `https://www.caiso.com/outlook/${base}/${id === 'stats' ? 'stats.txt' : `${id}.csv`}`;
}
export function emptyOutlookFeed(id: OutlookId, date: string, fetchedAt: string, today = localParts(new Date()).localDate): DataFeed {
  const d = OUTLOOK_DEFINITIONS[id];
  return { id, title: d.title, source: 'outlook', status: 'ok', sourceUrl: outlookSourceUrl(id, date, today), fetchedAt, requestedDate: date,
    dataDate: date, timeZone: 'America/Los_Angeles', unit: d.unit, intervalMinutes: id === 'stats' || id.startsWith('peak_') ? null : 5,
    columns: [], rows: [], warnings: [], notes: [...d.notes], cached: false };
}
function numberOrNull(value: string | undefined) {
  if (value == null || !value.trim() || /^(null|nan|n\/a)$/i.test(value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

/** Resolve wall-clock labels without silently choosing one occurrence of a repeated DST hour. */
export function wallTimeCandidates(date: string, hhmm: string): number[] {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59) return [];
  const minutes = Number(parts[1]) * 60 + Number(parts[2]);
  const start = localDayStartUtc(date), end = localDayStartUtc(addDays(date, 1));
  const normalized = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const approximate = start + minutes * 60000;
  return [...new Set([approximate - 3600000, approximate, approximate + 3600000])]
    .filter(t => t >= start && t < end && localParts(t).localHour === normalized).sort((a, b) => a - b);
}
function parseSourceTime(label: string, fallbackDate: string): { date: string; hhmm: string } | null {
  const full = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM))?$/i.exec(label.trim());
  if (full) { let hour = Number(full[4]); if (full[6]) hour = hour % 12 + (full[6].toUpperCase() === 'PM' ? 12 : 0); return { date: `${full[3]}-${full[1].padStart(2, '0')}-${full[2].padStart(2, '0')}`, hhmm: `${String(hour).padStart(2, '0')}:${full[5]}` }; }
  if (/^\d{1,2}:\d{2}$/.test(label.trim())) { const [h, m] = label.trim().split(':'); return { date: fallbackDate, hhmm: `${h.padStart(2, '0')}:${m}` }; }
  return null;
}

export function normalizeOutlookCsv(id: OutlookId, text: string, date: string, fetchedAt = new Date().toISOString(), lastModified?: string | null, today = localParts(new Date()).localDate): DataFeed {
  const feed = emptyOutlookFeed(id, date, fetchedAt, today); feed.lastModified = lastModified ?? null;
  const csv = parseCsv(text); if (!csv.length || /^\s*</.test(text)) throw new OutlookError('INVALID_RESPONSE', '公开源没有返回有效 CSV。');
  const headers = csv[0].map(h => h.trim());
  if (id.startsWith('peak_')) {
    const required = ['Resource', 'Peak production time', 'Peak production (MW)', 'Daily production (MWh)'];
    if (!required.every(h => headers.includes(h))) throw new OutlookError('SCHEMA_CHANGED', '日报字段发生变化，已停止解析。');
    feed.table = { columns: [{key:'resource',label:'资源'}, {key:'peakTime',label:'峰值时间（PT）'}, {key:'peakMW',label:'峰值功率',unit:'MW'}, {key:'dailyMWh',label:'日电量',unit:'MWh'}],
      rows: csv.slice(1).filter(r => r[0]?.trim()).map(r => ({ resource: r[headers.indexOf('Resource')], peakTime: r[headers.indexOf('Peak production time')], peakMW: numberOrNull(r[headers.indexOf('Peak production (MW)')]), dailyMWh: numberOrNull(r[headers.indexOf('Daily production (MWh)')]) })) };
    if (!feed.table.rows.length) { feed.status = 'unavailable'; feed.warnings.push('该日报尚未发布有效记录。'); }
    return feed;
  }
  const definitions = OUTLOOK_DEFINITIONS[id].columns;
  if (headers[0] !== 'Time' || !definitions) throw new OutlookError('SCHEMA_CHANGED', '时序文件缺少预期的 Time 列。');
  const missing = Object.keys(definitions).filter(h => !headers.includes(h));
  if (missing.length) throw new OutlookError('SCHEMA_CHANGED', `必要字段缺失：${missing.join('、')}。`);
  const selected = headers.map((h, i) => ({ source: h, index: i, def: definitions[h] })).filter(c => c.def);
  feed.columns = selected.map(c => ({ key: c.def[0], label: c.def[1], unit: feed.unit, kind: c.def[2] ?? 'other', nativeMinutes: c.def[3] ?? 5, primary: c.def[0] !== 'demandResponse' }));
  const unknown = headers.slice(1).filter(h => !(h in definitions));
  if (unknown.length) feed.warnings.push(`源新增字段尚未映射：${unknown.join('、')}。原始 CSV 可供核对。`);
  const body = csv.slice(1).filter(r => r[0]?.trim());
  const isDated = id === 'rtm_forecast' || id === 'rtm_forecast_7day';
  let dataDate = date;
  if (!isDated && date === today) {
    const now = localParts(fetchedAt);
    const actualIndices = selected.filter(c => c.def[2] === 'actual' && c.def[0] !== 'demandResponse').map(c => c.index);
    const latestActual = body.filter((r, i) => !(i === body.length - 1 && i > 0 && /^0?0:00$/.test(r[0])) && actualIndices.some(index => numberOrNull(r[index]) !== null)).at(-1);
    if (latestActual && latestActual[0] > now.localHour && now.localHour < '03:00') {
      dataDate = addDays(date, -1); feed.dataDate = dataDate; feed.status = 'partial';
      feed.warnings.push(`current 文件尚未切换至请求日期，实际归属 ${dataDate}，不能冒充 ${date} 的实际值。`);
    }
  }
  let ambiguous = 0, absent = 0, removedTail = 0;
  const occurrences = new Map<string, number>();
  for (const row of body) { const label = row[0].trim(); occurrences.set(label, (occurrences.get(label) ?? 0) + 1); }
  const used = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const raw = body[i], label = raw[0].trim();
    // CAISO appends the next midnight to day curves. It is not a second interval of the requested day.
    if (!isDated && i === body.length - 1 && i > 0 && /^0?0:00$/.test(label)) { removedTail++; continue; }
    const parsed = parseSourceTime(label, dataDate); if (!parsed) { absent++; continue; }
    const values = Object.fromEntries(selected.map(c => [c.def[0], numberOrNull(raw[c.index])]));
    const candidates = wallTimeCandidates(parsed.date, parsed.hhmm);
    const occurrence = used.get(label) ?? 0; used.set(label, occurrence + 1);
    let time: number | null = null;
    // A repeated source label twice allows matching first/second occurrence. A single label in a fold does not.
    if (candidates.length === 1) time = candidates[0];
    else if (candidates.length === 2 && occurrences.get(label) === 2) time = candidates[occurrence] ?? null;
    if (candidates.length === 0 && Object.values(values).every(v => v === null)) { absent++; continue; }
    if (time === null) ambiguous++;
    const r: FeedRow = { startUtc: time === null ? null : new Date(time).toISOString(), endUtc: time === null ? null : new Date(time + 300000).toISOString(), sourceTime: label,
      values, quality: time === null ? 'ambiguous' : Object.values(values).every(v => v === null) ? 'missing' : 'ok' };
    feed.rows.push(r);
  }
  if (ambiguous) feed.warnings.push(`${ambiguous} 行本地时间处于夏令时重复/缺失小时且无法唯一定位，保留原时间与数值，不参与曲线时间匹配。`);
  if (absent) feed.warnings.push(`${absent} 行无效或不存在的空时间标签已跳过。`);
  if (removedTail) feed.notes.push('已移除文件末尾属于下一天的 00:00 尾点。');
  if (unknown.length || ambiguous || absent) feed.status = 'partial';
  if (!feed.rows.length) { feed.status = 'unavailable'; feed.warnings.push('所选日期没有有效时序记录。'); }
  return feed;
}

export function normalizeOutlookStats(text: string, date: string, fetchedAt = new Date().toISOString(), lastModified?: string | null, today = localParts(new Date()).localDate): DataFeed {
  const feed = emptyOutlookFeed('stats', date, fetchedAt, today); feed.lastModified = lastModified ?? null;
  let stats: Record<string, unknown>;
  try { stats = JSON.parse(text); } catch { throw new OutlookError('INVALID_JSON', '系统状态摘要没有返回有效 JSON。'); }
  if (!stats || typeof stats !== 'object' || Array.isArray(stats) || !('slotDate' in stats)) throw new OutlookError('SCHEMA_CHANGED', '系统状态摘要缺少日期字段。');
  feed.stats = stats;
  const parsed = parseSourceTime(String(stats.slotDate), date);
  feed.dataDate = parsed?.date ?? null;
  if (!feed.dataDate || feed.dataDate !== date) { feed.status = 'partial'; feed.warnings.push(`状态摘要所属日期为 ${feed.dataDate ?? '未知'}，与请求日期 ${date} 不一致。`); }
  return feed;
}

export interface RawOutlookFile { id: OutlookId; date: string; sourceUrl: string; fetchedAt: string; status: number; lastModified?: string | null; text?: string; error?: string; }
export function normalizeRawOutlookFile(raw: RawOutlookFile, today = localParts(new Date()).localDate): DataFeed {
  const base = emptyOutlookFeed(raw.id, raw.date, raw.fetchedAt, today); base.sourceUrl = raw.sourceUrl;
  if (raw.status !== 200 || raw.text == null) {
    base.status = [404, 410, 0].includes(raw.status) ? 'unavailable' : 'error'; base.dataDate = null;
    base.error = { code: raw.status === 403 ? 'SOURCE_ACCESS_DENIED' : raw.status === 404 ? 'NOT_PUBLISHED' : raw.status === 0 ? 'UNAVAILABLE_FOR_DATE' : 'UPSTREAM_ERROR', message: raw.status === 403 ? 'Today’s Outlook 拒绝当前服务器读取（HTTP 403），本次未更新。已验证快照仍可查看，也可打开官方来源。' : raw.error || (raw.status === 404 ? '官方尚未发布该日期数据。' : '该日期不提供此数据集。') };
    return base;
  }
  try {
    const feed = raw.id === 'stats' ? normalizeOutlookStats(raw.text, raw.date, raw.fetchedAt, raw.lastModified, today) : normalizeOutlookCsv(raw.id, raw.text, raw.date, raw.fetchedAt, raw.lastModified, today);
    feed.sourceUrl = raw.sourceUrl; return feed;
  } catch (e) { base.status = 'error'; base.dataDate = null; base.error = {code: e instanceof OutlookError ? e.code : 'PARSE_ERROR', message: e instanceof Error ? e.message : '解析失败。'}; return base; }
}

const cache = new Map<string, {expires: number; value: DataFeed}>();
const inflight = new Map<string, Promise<DataFeed>>();
let active = 0; const waiters: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => { if (active < 3) { active++; resolve(); } else waiters.push(resolve); });
  try { return await task(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
}
async function fetchOne(id: OutlookId, date: string, today: string): Promise<DataFeed> {
  const key = `${date}:${id}`, hit = cache.get(key); if (hit && hit.expires > Date.now()) return {...hit.value, cached: true};
  if (inflight.has(key)) return inflight.get(key)!;
  const promise = limited(async () => {
    const fetchedAt = new Date().toISOString(), sourceUrl = outlookSourceUrl(id, date, today);
    if ((id === 'stats' && date !== today) || date > today) return normalizeRawOutlookFile({id,date,sourceUrl,fetchedAt,status:0,error: date > today ? '请选择当前或历史发布日；未来预测请查看未来 7 天资源充裕度。' : 'CAISO 系统摘要仅提供当前状态。'}, today);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    let result: DataFeed;
    try {
      const response = await fetch(sourceUrl, {signal: controller.signal, headers:{Accept: id === 'stats' ? 'application/json,text/plain' : 'text/csv,text/plain'}, redirect:'manual'});
      if (response.status === 403 && id === 'demand') {
        // Public source diagnostics only; no request credentials or headers are logged.
        const reader = response.body?.getReader();
        const first = reader ? await reader.read() : undefined;
        await reader?.cancel();
        console.error('CAISO_OUTLOOK_ACCESS_DENIED', {status:403, server:response.headers.get('server'), contentType:response.headers.get('content-type'), detail:first?.value ? new TextDecoder().decode(first.value.slice(0,1600)).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,700) : ''});
      }
      const length = Number(response.headers.get('Content-Length') || 0); if (length > 4 * 1024 * 1024) throw new OutlookError('RESPONSE_TOO_LARGE', '数据文件超过读取限制。');
      const text = response.ok ? await response.text() : undefined;
      if (text && text.length > 4 * 1024 * 1024) throw new OutlookError('RESPONSE_TOO_LARGE', '数据文件超过读取限制。');
      result = normalizeRawOutlookFile({id,date,sourceUrl,fetchedAt,status:response.status,lastModified:response.headers.get('Last-Modified'),text,
        error: response.status === 404 ? '官方尚未发布该日期数据。' : response.ok ? undefined : `官方数据源返回 HTTP ${response.status}。`}, today);
      if (result.status === 'ok' || result.status === 'partial' || result.status === 'unavailable') cache.set(key, {expires:Date.now() + (date === today ? 180000 : 3600000),value:result});
      if (cache.size > 180) cache.delete(cache.keys().next().value!);
    } catch (e) {
      if (!(e instanceof OutlookError)) console.error('CAISO_OUTLOOK_FETCH_FAILURE', {feed:id, name:e instanceof Error ? e.name : 'UnknownError', message:e instanceof Error ? e.message : 'Unknown upstream failure'});
      result = emptyOutlookFeed(id,date,fetchedAt,today); result.status='error'; result.dataDate=null;
      result.error={code: e instanceof Error && e.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : e instanceof OutlookError ? e.code : 'UPSTREAM_UNREACHABLE', message: e instanceof Error && e.name === 'AbortError' ? '官方数据源响应超时，请稍后重试。' : e instanceof OutlookError ? e.message : '暂时无法连接 CAISO 公开数据源。'};
    } finally { clearTimeout(timeout); }
    return result;
  });
  inflight.set(key,promise); try { return await promise; } finally { inflight.delete(key); }
}

export async function queryOutlook(date: string, ids: OutlookId[] = [...OUTLOOK_IDS]): Promise<DataBundle> {
  validOutlookDate(date); if (!ids.length || ids.some(id => !isOutlookId(id))) throw new OutlookError('INVALID_FEED', '请选择有效的公开数据集。', 400);
  const today = localParts(new Date()).localDate;
  const feeds = await Promise.all([...new Set(ids)].map(id => fetchOne(id,date,today)));
  return { ok:feeds.some(f => f.status === 'ok' || f.status === 'partial'), date, fetchedAt:new Date().toISOString(), feeds:Object.fromEntries(feeds.map(f => [f.id,f])), warnings:feeds.some(f => f.status === 'error') ? ['部分来源获取失败，其他数据仍可使用。'] : [] };
}
