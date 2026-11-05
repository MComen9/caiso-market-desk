import { unzipSync, strFromU8 } from 'fflate';
import { HUBS, type Market, type MarketResponse, type PriceInterval } from './types';

export const OASIS_ENDPOINT = 'https://oasis.caiso.com/oasisapi/SingleZip';
export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
export const REPORTS = {
  DAM: { queryname: 'PRC_LMP', version: '12', market_run_id: 'DAM', valueColumn: 'MW', minutes: 60 },
  FMM: { queryname: 'PRC_RTPD_LMP', version: '3', market_run_id: 'RTPD', valueColumn: 'PRC', minutes: 15 },
  RTD: { queryname: 'PRC_INTVL_LMP', version: '3', market_run_id: 'RTM', valueColumn: 'VALUE', minutes: 5 },
} as const;

export interface MarketQuery { market: Market; startDate: string; endDate: string; nodes: string[] }

export class OasisError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); this.name = 'OasisError'; }
}

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
});

export function localTimeParts(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(localFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return { localDate: `${parts.year}-${parts.month}-${parts.day}`, localHour: `${parts.hour}:${parts.minute}`,
    utcOffset: (parts.timeZoneName || 'GMT').replace('GMT', '') || '+00:00', year: Number(parts.year),
    month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function dateNumber(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OasisError('INVALID_DATE', '日期必须使用 YYYY-MM-DD 格式。', 400);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw new OasisError('INVALID_DATE', '日期不存在，请检查年月日。', 400);
  return time;
}

export function shiftDate(value: string, delta: number) { return new Date(dateNumber(value) + delta * 86400000).toISOString().slice(0, 10); }

export function pacificMidnightUtc(value: string) {
  const target = dateNumber(value);
  let guess = target + 8 * 3600000;
  for (let i = 0; i < 4; i++) {
    const p = localTimeParts(guess);
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const adjustment = target - local;
    guess += adjustment;
    if (!adjustment) return new Date(guess).toISOString();
  }
  throw new OasisError('TIME_ZONE_ERROR', '无法确定所选日期的太平洋时间边界。', 400);
}

export function getQueryWindow(startDate: string, endDate: string) {
  const start = dateNumber(startDate), end = dateNumber(endDate);
  if (end < start) throw new OasisError('INVALID_RANGE', '结束日期不能早于开始日期。', 400);
  if (end - start > 6 * 86400000) throw new OasisError('RANGE_TOO_LONG', '单次最多查询 7 个交易日，请缩短日期范围。', 400);
  return { startUtc: pacificMidnightUtc(startDate), endUtc: pacificMidnightUtc(shiftDate(endDate, 1)) };
}

export function validateQuery(input: MarketQuery): MarketQuery {
  if (!Object.prototype.hasOwnProperty.call(REPORTS, input.market))
    throw new OasisError('INVALID_MARKET', '市场类型必须为 DAM、FMM 或 RTD。', 400);
  getQueryWindow(input.startDate, input.endDate);
  const nodes = [...new Set(input.nodes.map(n => n.trim().toUpperCase()).filter(Boolean))];
  if (!nodes.length || nodes.length > 6) throw new OasisError('INVALID_NODES', '每次请选择 1 至 6 个节点。', 400);
  if (nodes.some(n => !/^[A-Z0-9][A-Z0-9_.-]{1,99}$/.test(n)))
    throw new OasisError('INVALID_NODE', '节点代码只允许字母、数字、下划线、点和连字符。', 400);
  return { market: input.market, startDate: input.startDate, endDate: input.endDate, nodes };
}

function apiTime(value: string) { return value.slice(0, 10).replaceAll('-', '') + 'T' + value.slice(11, 16) + '-0000'; }

export function buildSourceUrl(input: MarketQuery) {
  const query = validateQuery(input), report = REPORTS[query.market];
  const window = getQueryWindow(query.startDate, query.endDate);
  const url = new URL(OASIS_ENDPOINT);
  url.search = new URLSearchParams({ queryname: report.queryname, version: report.version,
    market_run_id: report.market_run_id, resultformat: '6', startdatetime: apiTime(window.startUtc),
    enddatetime: apiTime(window.endUtc), node: query.nodes.join(',') }).toString();
  return url.toString();
}

/** RFC 4180 style CSV parser, including quoted commas, escaped quotes and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(field); field = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(v => v.length)) rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new OasisError('INVALID_CSV', 'OASIS 返回的 CSV 引号不完整。');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function priceNumber(value: string | undefined) {
  if (value == null || value.trim() === '' || /^(null|n\/a|nan)$/i.test(value.trim())) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}

function timestamp(value: string | undefined) {
  if (!value || !/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) throw new OasisError('INVALID_TIMESTAMP', '上游区间时间缺少有效 UTC 时区。');
  const time = Date.parse(value); if (!Number.isFinite(time)) throw new OasisError('INVALID_TIMESTAMP', '上游返回了无效的区间时间。');
  return new Date(time).toISOString();
}

/** One output row per node and exact UTC interval. Components are never added across duplicates. */
export function normalizeCsv(text: string, market: Market): PriceInterval[] {
  const rows = parseCsv(text); if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toUpperCase());
  const idx = (name: string) => headers.indexOf(name);
  const startIndex = idx('INTERVALSTARTTIME_GMT'), endIndex = idx('INTERVALENDTIME_GMT');
  const nodeIndex = ['NODE', 'NODE_ID', 'NODE_ID_XML'].map(idx).find(i => i >= 0) ?? -1;
  const componentIndex = idx('LMP_TYPE');
  const valueIndex = [REPORTS[market].valueColumn, 'VALUE', 'PRC', 'MW'].map(idx).find(i => i >= 0) ?? -1;
  const hourIndex = idx('OPR_HR');
  if ([startIndex, endIndex, nodeIndex, componentIndex, valueIndex].some(i => i < 0))
    throw new OasisError('SCHEMA_CHANGED', 'OASIS 报表缺少必要列，已停止解析以避免错误数据。');
  const groups = new Map<string, { value: PriceInterval; seen: Set<string>; conflicts: Set<string> }>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i], component = row[componentIndex]?.trim().toUpperCase();
    if (!['LMP', 'MCE', 'MCC', 'MCL', 'MGHG'].includes(component)) continue;
    const node = row[nodeIndex]?.trim().toUpperCase(); if (!node) continue;
    const startUtc = timestamp(row[startIndex]), endUtc = timestamp(row[endIndex]);
    const minutes = (Date.parse(endUtc) - Date.parse(startUtc)) / 60000;
    if (minutes !== REPORTS[market].minutes) throw new OasisError('INVALID_INTERVAL', `${market} 返回了非预期的 ${minutes} 分钟区间。`);
    const key = `${node}|${startUtc}|${endUtc}`;
    let item = groups.get(key);
    if (!item) {
      const local = localTimeParts(startUtc), reportedHour = Number(row[hourIndex]);
      item = { value: { node, startUtc, endUtc, localDate: local.localDate, localHour: local.localHour,
        utcOffset: local.utcOffset, hourEnding: Number.isInteger(reportedHour) && reportedHour > 0 ? reportedHour : local.hour + 1,
        minutes, price: null, components: {}, quality: 'missing' }, seen: new Set(), conflicts: new Set() };
      groups.set(key, item);
    }
    const value = priceNumber(row[valueIndex]);
    const previous = component === 'LMP' ? item.value.price : item.value.components[component];
    if (item.conflicts.has(component)) continue;
    if (item.seen.has(component) && previous !== value) {
      item.conflicts.add(component); item.value.quality = 'conflict';
      if (component === 'LMP') item.value.price = null; else item.value.components[component] = null;
      continue;
    }
    item.seen.add(component);
    if (component === 'LMP') item.value.price = value; else item.value.components[component] = value;
  }
  return [...groups.values()].map(({ value, conflicts }) => ({ ...value,
    quality: conflicts.size ? 'conflict' as const : value.price === null ? 'missing' as const : 'ok' as const }))
    .sort((a, b) => a.node.localeCompare(b.node) || a.startUtc.localeCompare(b.startUtc));
}

function xmlFailure(text: string) {
  const code = text.match(/<(?:[\w-]+:)?ERR_CODE(?:\s[^>]*)?>([^<]*)<\//i)?.[1]?.trim();
  const description = text.match(/<(?:[\w-]+:)?ERR_DESC(?:\s[^>]*)?>([^<]*)<\//i)?.[1]?.trim();
  if (!code) return null;
  return new OasisError(code === '1000' ? 'NO_DATA' : `OASIS_${code}`,
    code === '1000' ? 'OASIS 未返回所选节点和日期的数据，请核对节点代码或稍后重试。' : `OASIS 报表错误 ${code}：${description || '暂时无法生成报表。'}`,
    code === '1000' ? 200 : 502);
}

export function decodeOasisArchive(bytes: Uint8Array, market: Market) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    const text = strFromU8(bytes); const error = xmlFailure(text); if (error) throw error;
    throw new OasisError('INVALID_RESPONSE', 'OASIS 返回了非 ZIP 内容，可能正在维护或限制访问。');
  }
  let originalSize = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: file => {
      if (!/\.(csv|xml)$/i.test(file.name)) return false;
      originalSize += file.originalSize;
      if (originalSize > 50 * 1024 * 1024) throw new OasisError('REPORT_TOO_LARGE', '报表展开后超过 50 MB，请缩短查询范围。');
      return true;
    } });
  } catch (error) { if (error instanceof OasisError) throw error; throw new OasisError('INVALID_ZIP', 'OASIS ZIP 数据不完整，请重新查询。'); }
  const values: PriceInterval[] = [];
  for (const [name, body] of Object.entries(files)) {
    const text = strFromU8(body);
    if (/\.xml$/i.test(name)) { const error = xmlFailure(text); if (error) throw error; }
    else if (/\.csv$/i.test(name)) values.push(...normalizeCsv(text, market));
  }
  if (!values.length) throw new OasisError('NO_DATA', '报表中没有可用的节点价格记录。', 200);
  // Most reports contain one CSV. Cross-file duplicate intervals are collapsed, conflicts remain explicit.
  const merged = new Map<string, PriceInterval>();
  for (const row of values) {
    const key = `${row.node}|${row.startUtc}|${row.endUtc}`, previous = merged.get(key);
    if (!previous) merged.set(key, row);
    else if (previous.price !== row.price || ['MCE', 'MCC', 'MCL', 'MGHG'].some(key => previous.components[key] !== row.components[key]))
      merged.set(key, { ...previous, price: null, quality: 'conflict' });
  }
  return [...merged.values()].sort((a, b) => a.node.localeCompare(b.node) || a.startUtc.localeCompare(b.startUtc));
}

const cache = new Map<string, { expires: number; result: MarketResponse }>();
const pending = new Map<string, Promise<MarketResponse>>();
let upstreamQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Shared per-isolate gate for price and fundamental OASIS reports. */
export function enqueueOasisTask<T>(operation: () => Promise<T>): Promise<T> {
  const work = upstreamQueue.then(operation, operation);
  upstreamQueue = work.then(() => undefined, () => undefined);
  return work;
}

export async function waitForOasisSlot() {
  const spacing = 8000 - (Date.now() - lastRequestAt);
  if (spacing > 0) await sleep(spacing);
  lastRequestAt = Date.now();
}

async function boundedBody(response: Response) {
  const limit = 10 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new OasisError('REPORT_TOO_LARGE', '压缩报表超过 10 MB，请缩短查询范围。');
  if (!response.body) throw new OasisError('EMPTY_RESPONSE', 'OASIS 返回了空响应。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new OasisError('REPORT_TOO_LARGE', '压缩报表超过 10 MB，请缩短查询范围。'); }
    chunks.push(value);
  }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function fetchArchive(sourceUrl: string, market: Market) {
  // The fixed endpoint is the only reachable host; caller input cannot introduce another URL.
  for (let attempt = 0; attempt < 2; attempt++) {
    // A conservative spacing from the integration probe, not an asserted CAISO rate-limit rule.
    await waitForOasisSlot();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      // Workers supports manual/follow only. Reject non-2xx below without following a redirect.
      const response = await fetch(sourceUrl, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/zip, application/octet-stream, */*' } });
      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt === 0) { clearTimeout(timer); await sleep(8000); continue; }
        throw new OasisError('RATE_LIMITED', 'OASIS 暂时限制请求频率，请稍后重试。已有快照仍可查看。', 429);
      }
      if (!response.ok) throw new OasisError('UPSTREAM_HTTP', `OASIS 暂时无法访问（HTTP ${response.status}）。`);
      return decodeOasisArchive(await boundedBody(response), market);
    } catch (error) {
      if (error instanceof OasisError) throw error;
      if (controller.signal.aborted) throw new OasisError('UPSTREAM_TIMEOUT', 'OASIS 响应超过 25 秒，请稍后重试或缩短日期范围。', 504);
      console.error('CAISO_OASIS_FETCH_FAILURE', error instanceof Error ? {name: error.name, message: error.message} : {name:'UnknownError'});
      throw new OasisError('UPSTREAM_UNAVAILABLE', '当前无法连接 OASIS，请稍后重试。');
    } finally { clearTimeout(timer); }
  }
  throw new OasisError('UPSTREAM_UNAVAILABLE', 'OASIS 暂时不可用。');
}

export async function queryMarket(input: MarketQuery): Promise<MarketResponse> {
  const query = validateQuery(input), window = getQueryWindow(query.startDate, query.endDate), sourceUrl = buildSourceUrl(query);
  const key = `${query.market}|${query.startDate}|${query.endDate}|${[...query.nodes].sort().join(',')}`;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return { ...existing.result, cached: true };
  for (const [cacheKey, item] of cache) if (item.expires <= Date.now()) cache.delete(cacheKey);
  if (pending.has(key)) return pending.get(key)!;
  const operation = async (): Promise<MarketResponse> => {
    const base: MarketResponse = { ok: false, market: query.market, source: 'CAISO OASIS', sourceUrl,
      fetchedAt: new Date().toISOString(), cached: false, request: { ...query, ...window }, intervals: [], warnings: [] };
    try {
      const intervals = (await fetchArchive(sourceUrl, query.market)).filter(row =>
        query.nodes.includes(row.node) && row.startUtc >= window.startUtc && row.startUtc < window.endUtc);
      const warnings: string[] = [];
      const expected = (Date.parse(window.endUtc) - Date.parse(window.startUtc)) / (REPORTS[query.market].minutes * 60000);
      for (const node of query.nodes) {
        const usable = intervals.filter(row => row.node === node && row.quality === 'ok' && row.price !== null).length;
        if (usable !== expected) warnings.push(`${node} 有效区间 ${usable}/${expected}；未发布或缺失区间保持为空。`);
      }
      const conflicts = intervals.filter(row => row.quality === 'conflict').length;
      if (conflicts) warnings.push(`${conflicts} 个区间存在重复值冲突，已标记，不可作为完整价格使用。`);
      const result: MarketResponse = { ...base, ok: true, fetchedAt: new Date().toISOString(), intervals, warnings };
      cache.set(key, { expires: Date.now() + 5 * 60000, result });
      // Bound retained price rows as well as query count to fit a Worker isolate's memory budget.
      while (cache.size > 12 || [...cache.values()].reduce((sum, item) => sum + item.result.intervals.length, 0) > 20000)
        cache.delete(cache.keys().next().value!);
      return result;
    } catch (error) {
      const failure = error instanceof OasisError ? error : new OasisError('UPSTREAM_UNAVAILABLE', 'OASIS 查询暂时失败。');
      return { ...base, fetchedAt: new Date().toISOString(), error: { code: failure.code, message: failure.message } };
    }
  };
  const work = enqueueOasisTask(operation);
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

export function queryFromSearchParams(params: URLSearchParams): MarketQuery {
  const yesterday = shiftDate(localTimeParts(new Date()).localDate, -1);
  return validateQuery({ market: (params.get('market') || 'DAM').toUpperCase() as Market,
    startDate: params.get('start') || yesterday, endDate: params.get('end') || params.get('start') || yesterday,
    nodes: params.has('nodes') ? (params.get('nodes') || '').split(',') : HUBS.map(h => h.id) });
}
