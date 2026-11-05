import { unzipSync, strFromU8 } from 'fflate';
import { parseCsv, getQueryWindow, localTimeParts, OasisError, OASIS_ENDPOINT, enqueueOasisTask, waitForOasisSlot } from './oasis';
import type { DataBundle, DataFeed, FeedColumn, FeedRow } from './data-types';
import { CORE_FUNDAMENTAL_IDS, FUNDAMENTAL_FEEDS, FUNDAMENTAL_IDS, type FundamentalId } from './fundamentals-types';

const VERSION = '1';
const CAISO_HUBS = ['NP15', 'SP15', 'ZP26'];
const MB = 1024 * 1024;
const errorMessage = (error: unknown) => error instanceof OasisError ? error.message : '当前无法连接 OASIS，请稍后重试。';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const metricKey = (resource: string, area: string) => `${resource}__${area.replace(/[^A-Za-z0-9]/g, '_')}`;

export function validateFundamentalId(value: string): FundamentalId {
  if (!Object.prototype.hasOwnProperty.call(FUNDAMENTAL_FEEDS, value)) throw new OasisError('INVALID_FEED', '不支持的数据集，请从官方预测列表中选择。', 400);
  return value as FundamentalId;
}

export function buildFundamentalUrl(id: FundamentalId, date: string) {
  validateFundamentalId(id);
  const window = getQueryWindow(date, date), config = FUNDAMENTAL_FEEDS[id];
  const format = (utc: string) => `${utc.slice(0, 10).replaceAll('-', '')}T${utc.slice(11, 16)}-0000`;
  const params = new URLSearchParams({ queryname: config.queryname, version: VERSION, market_run_id: config.market,
    resultformat: '6', startdatetime: format(window.startUtc), enddatetime: format(window.endUtc) });
  if (config.execution) params.set('execution_type', config.execution);
  return `${OASIS_ENDPOINT}?${params}`;
}

function notesFor(id: FundamentalId) {
  const config = FUNDAMENTAL_FEEDS[id];
  const notes = [
    '数据直接来自 CAISO OASIS，单位 MW；区间时间由原报表 UTC 时间确定。',
    '区域是独立序列；CA ISO-TAC 与其他 TAC/BAA 不得直接相加。外部区域不代表 CAISO 系统。',
  ];
  if (config.kind === 'forecast') notes.push('这是 CAISO 官方负荷或风光预测，不是节点电价预测。原报表未提供逐条实际发布时间，publishTimeUtc 保留为空；不能据此恢复历史预测发布批次。');
  if (config.family === 'load') notes.push('OASIS 实际小时负荷包含储能充电负荷，与 Today’s Outlook 不含充电的需求趋势口径不同；跨源误差计算需先核对口径。');
  else notes.push('CAISO 汇总仅由 NP15、SP15、ZP26 三个枢纽同资源、同区间的完整值相加；其余 BAA 未纳入。原报表分区值保留。');
  return notes;
}

export function emptyFundamental(id: FundamentalId, date: string, fetchedAt = new Date().toISOString()): DataFeed {
  const config = FUNDAMENTAL_FEEDS[id];
  return { id, title: config.title, source: 'oasis', status: 'unavailable', sourceUrl: buildFundamentalUrl(id, date),
    fetchedAt, requestedDate: date, dataDate: null, timeZone: 'America/Los_Angeles', unit: 'MW', intervalMinutes: config.minutes,
    columns: [], rows: [], notes: notesFor(id), warnings: [], cached: false };
}

function parseTimestamp(value: string | undefined) {
  if (!value || !/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) throw new OasisError('INVALID_TIMESTAMP', 'OASIS 区间缺少 UTC 时区，已停止解析。');
  const stamp = Date.parse(value); if (!Number.isFinite(stamp)) throw new OasisError('INVALID_TIMESTAMP', 'OASIS 返回无效时间。');
  return new Date(stamp).toISOString();
}
function parseValue(value: string | undefined) {
  if (value == null || value.trim() === '' || /^(nan|null|n\/a)$/i.test(value.trim())) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}

/** Pivot only exact source intervals; duplicate conflicts become null rather than being averaged. */
export function normalizeFundamentalCsv(texts: string | string[], id: FundamentalId, date: string, fetchedAt = new Date().toISOString()): DataFeed {
  const config = FUNDAMENTAL_FEEDS[id], window = getQueryWindow(date, date), feed = emptyFundamental(id, date, fetchedAt);
  const columns = new Map<string, FeedColumn>(), rows = new Map<string, FeedRow>(), conflicted = new Set<string>();
  let sourceRowCount = 0, discarded = 0;
  for (const text of typeof texts === 'string' ? [texts] : texts) {
    const csv = parseCsv(text); if (!csv.length) continue;
    const headers = csv[0].map(h => h.trim().toUpperCase()), index = (key: string) => headers.indexOf(key);
    const startIndex = index('INTERVALSTARTTIME_GMT'), endIndex = index('INTERVALENDTIME_GMT'), valueIndex = index('MW');
    const areaIndex = index(config.family === 'load' ? 'TAC_AREA_NAME' : 'TRADING_HUB'), typeIndex = index('RENEWABLE_TYPE');
    const marketIndex = index('MARKET_RUN_ID'), executionIndex = index('EXECUTION_TYPE');
    if ([startIndex, endIndex, valueIndex, areaIndex, marketIndex].some(n => n < 0) || config.family === 'renewables' && typeIndex < 0)
      throw new OasisError('SCHEMA_CHANGED', 'OASIS 报表缺少必要字段，已停止解析。');
    for (const input of csv.slice(1)) {
      if (input[marketIndex]?.trim() !== config.market) { discarded++; continue; }
      if (config.execution && executionIndex >= 0 && input[executionIndex]?.trim() !== config.execution) { discarded++; continue; }
      const startUtc = parseTimestamp(input[startIndex]), endUtc = parseTimestamp(input[endIndex]);
      if (startUtc < window.startUtc || startUtc >= window.endUtc) continue;
      const duration = (Date.parse(endUtc) - Date.parse(startUtc)) / 60000;
      if (duration !== config.minutes) throw new OasisError('INVALID_INTERVAL', `${config.title}返回${duration}分钟区间，与原生${config.minutes}分钟口径不符。`);
      const area = input[areaIndex]?.trim(); if (!area) continue;
      const resource = config.family === 'load' ? 'load' : input[typeIndex]?.trim().toLowerCase();
      if (!['load', 'solar', 'wind'].includes(resource)) { discarded++; continue; }
      const key = metricKey(resource, area), intervalKey = `${startUtc}|${endUtc}`;
      const label = resource === 'load' ? '负荷' : resource === 'solar' ? '光伏' : '风电';
      const previousColumn = columns.get(key);
      if (previousColumn && previousColumn.area !== area) throw new OasisError('SCHEMA_CHANGED', '区域字段生成了重复标识，已停止解析。');
      columns.set(key, { key, label: `${area} · ${label}`, area, resource, unit: 'MW', kind: config.kind,
        nativeMinutes: config.minutes, primary: config.family === 'load' && area === 'CA ISO-TAC' });
      if (!rows.has(intervalKey)) rows.set(intervalKey, { startUtc, endUtc, values: {}, publishTimeUtc: null, quality: 'ok' });
      const row = rows.get(intervalKey)!, value = parseValue(input[valueIndex]), cellKey = `${intervalKey}|${key}`;
      if (conflicted.has(cellKey)) continue;
      if (Object.prototype.hasOwnProperty.call(row.values, key) && row.values[key] !== value) {
        row.values[key] = null; row.quality = 'missing'; conflicted.add(cellKey);
      } else row.values[key] = value;
      sourceRowCount++;
    }
  }
  if (!rows.size) return { ...feed, error: { code: 'NO_DATA', message: 'OASIS 尚未返回该日期与数据集的记录。' } };
  if (config.family === 'renewables') {
    for (const resource of ['solar', 'wind']) {
      const sourceKeys = CAISO_HUBS.map(area => metricKey(resource, area));
      const key = metricKey(resource, 'CAISO');
      columns.set(key, { key, label: `CAISO · ${resource === 'solar' ? '光伏' : '风电'}`, area: 'CAISO', resource,
        unit: 'MW', kind: config.kind, nativeMinutes: config.minutes, primary: true });
      for (const row of rows.values()) {
        const values = sourceKeys.map(k => row.values[k]);
        row.values[key] = values.every(isFiniteNumber) ? values.reduce((sum, value) => sum + value, 0) : null;
      }
    }
  }
  const orderedColumns = [...columns.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || (a.area || '').localeCompare(b.area || '') || (a.resource || '').localeCompare(b.resource || ''));
  const orderedRows = [...rows.values()].sort((a, b) => a.startUtc!.localeCompare(b.startUtc!));
  for (const row of orderedRows) for (const column of orderedColumns) if (!(column.key in row.values)) row.values[column.key] = null;
  const expected = (Date.parse(window.endUtc) - Date.parse(window.startUtc)) / (config.minutes * 60000);
  const primary = orderedColumns.filter(column => column.primary);
  const complete = primary.length > 0 && primary.every(column => orderedRows.filter(row => isFiniteNumber(row.values[column.key])).length === expected);
  const warnings = [] as string[];
  for (const column of primary) {
    const count = orderedRows.filter(row => isFiniteNumber(row.values[column.key])).length;
    if (count !== expected) warnings.push(`${column.label} 有效区间 ${count}/${expected}；未发布或缺失区间保持为空。`);
  }
  if (!primary.length) warnings.push('原报表未包含 CAISO 系统序列，已保留其他区域并明确区域名称。');
  if (conflicted.size) warnings.push(`${conflicted.size} 个重复区间存在值冲突，已置空，未作平均或任取一条。`);
  if (discarded) warnings.push(`${discarded} 条不符合请求市场、执行类型或资源类型的记录未纳入。`);
  return { ...feed, status: complete && !conflicted.size ? 'ok' : 'partial', columns: orderedColumns, rows: orderedRows,
    dataDate: date, warnings, stats: { rawRowsParsed: sourceRowCount, expectedIntervals: expected, nativeMinutes: config.minutes,
      report: config.queryname, version: VERSION, marketRunId: config.market, executionType: config.execution, publishTimeAvailable: false } };
}

function xmlError(text: string) {
  const code = text.match(/<(?:[\w-]+:)?ERR_CODE(?:\s[^>]*)?>([^<]*)<\//i)?.[1]?.trim();
  const desc = text.match(/<(?:[\w-]+:)?ERR_DESC(?:\s[^>]*)?>([^<]*)<\//i)?.[1]?.trim();
  if (code) throw new OasisError(code === '1000' ? 'NO_DATA' : `OASIS_${code}`, code === '1000' ? 'OASIS 尚未发布该日期的数据。' : `OASIS 报表错误 ${code}：${desc || '暂时无法生成报表。'}`, code === '1000' ? 200 : 502);
}

export function decodeFundamentalArchive(bytes: Uint8Array, id: FundamentalId, date: string, fetchedAt?: string): DataFeed {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) { xmlError(strFromU8(bytes)); throw new OasisError('INVALID_RESPONSE', 'OASIS 返回非 ZIP 内容。'); }
  let size = 0, files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes, { filter: file => {
    if (!/\.(csv|xml)$/i.test(file.name)) return false;
    size += file.originalSize; if (size > 32 * MB) throw new OasisError('REPORT_TOO_LARGE', '展开后的基本面报表超过 32 MB。');
    return true;
  } }); } catch (e) { if (e instanceof OasisError) throw e; throw new OasisError('INVALID_ZIP', 'OASIS 报表不完整，请重试。'); }
  const texts: string[] = [];
  for (const [name, body] of Object.entries(files)) { const text = strFromU8(body); if (/\.xml$/i.test(name)) xmlError(text); else texts.push(text); }
  return normalizeFundamentalCsv(texts, id, date, fetchedAt);
}

const cache = new Map<string, { expires: number; feed: DataFeed }>();
const inFlight = new Map<string, Promise<DataFeed>>();

async function bodyBounded(response: Response) {
  const max = 8 * MB;
  if (Number(response.headers.get('content-length')) > max) throw new OasisError('REPORT_TOO_LARGE', 'OASIS 压缩报表超过 8 MB。');
  if (!response.body) throw new OasisError('EMPTY_RESPONSE', 'OASIS 返回空响应。');
  const chunks: Uint8Array[] = [], reader = response.body.getReader(); let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > max) { await reader.cancel(); throw new OasisError('REPORT_TOO_LARGE', 'OASIS 压缩报表超过 8 MB。'); } chunks.push(value); }
  const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}

export async function queryFundamental(id: FundamentalId, date: string): Promise<DataFeed> {
  validateFundamentalId(id); const sourceUrl = buildFundamentalUrl(id, date), key = `${id}|${date}`;
  const cached = cache.get(key); if (cached && cached.expires > Date.now()) return { ...cached.feed, cached: true };
  if (inFlight.has(key)) return inFlight.get(key)!;
  const operation = async () => {
    const base = emptyFundamental(id, date);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await waitForOasisSlot();
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
        try {
          const response = await fetch(sourceUrl, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/zip, application/octet-stream, */*' } });
          if (response.status === 429) { await response.body?.cancel(); if (!attempt) continue; throw new OasisError('RATE_LIMITED', 'OASIS 请求频率受限，请稍后重试。', 429); }
          if (!response.ok) throw new OasisError('UPSTREAM_HTTP', `OASIS 暂时不可用（HTTP ${response.status}）。`);
          const feed = decodeFundamentalArchive(await bodyBounded(response), id, date, new Date().toISOString());
          feed.lastModified = response.headers.get('last-modified');
          cache.set(key, { expires: Date.now() + 5 * 60000, feed });
          for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
          while (cache.size > 24) cache.delete(cache.keys().next().value!);
          return feed;
        } catch (e) { if (controller.signal.aborted) throw new OasisError('UPSTREAM_TIMEOUT', 'OASIS 响应超过 25 秒，请稍后重试。', 504); throw e; }
        finally { clearTimeout(timeout); }
      }
      throw new OasisError('UPSTREAM_UNAVAILABLE', 'OASIS 暂时无法连接。');
    } catch (e) {
      if (!(e instanceof OasisError)) console.error('CAISO_FUNDAMENTALS_FETCH_FAILURE', {feed:id, name:e instanceof Error ? e.name : 'UnknownError', message:e instanceof Error ? e.message : 'Unknown upstream failure'});
      const code = e instanceof OasisError ? e.code : 'UPSTREAM_UNAVAILABLE';
      return { ...base, fetchedAt: new Date().toISOString(), status: code === 'NO_DATA' ? 'unavailable' : 'error',
        error: { code, message: errorMessage(e) } } as DataFeed;
    }
  };
  const work = enqueueOasisTask(operation); inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

export function fundamentalQuery(params: URLSearchParams) {
  const allowed = new Set(['date', 'feed']);
  for (const key of params.keys()) if (!allowed.has(key)) throw new OasisError('INVALID_PARAMETER', `不支持参数 ${key}。`, 400);
  const date = params.get('date') || localTimeParts(new Date()).localDate;
  getQueryWindow(date, date);
  const rawIds = params.get('feed')?.split(',').map(id => id.trim()).filter(Boolean);
  const ids = rawIds?.length ? [...new Set(rawIds)].map(validateFundamentalId) : CORE_FUNDAMENTAL_IDS;
  if (ids.length > 3) throw new OasisError('TOO_MANY_FEEDS', '每次最多查询 3 个基本面数据集，请分批加载。', 400);
  return { date, ids };
}

export async function queryFundamentals(date: string, ids: FundamentalId[] = CORE_FUNDAMENTAL_IDS): Promise<DataBundle> {
  if (!ids.length || ids.length > FUNDAMENTAL_IDS.length) throw new OasisError('INVALID_FEED', '请选择至少一个基本面数据集。', 400);
  const feeds: Record<string, DataFeed> = {};
  for (const id of ids) feeds[id] = await queryFundamental(id, date);
  return { ok: Object.values(feeds).some(feed => feed.status === 'ok' || feed.status === 'partial'), date,
    fetchedAt: new Date().toISOString(), feeds, warnings: Object.values(feeds).filter(feed => feed.error).map(feed => `${feed.title}：${feed.error!.message}`) };
}
