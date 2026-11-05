import type { GridStatusConnection } from './data-types';
import { getQueryWindow } from './oasis';

const BASE = 'https://api.gridstatus.io/v1';
const MAX_ROWS = 1000;
const cache = new Map<string, {until: number; body: unknown}>();
let verifiedAt = 0;

export class GridStatusError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}

function getKey() { return (process.env.GRIDSTATUS_API_KEY || '').trim(); }

export function connectionStatus(): GridStatusConnection {
  const configured = !!getKey();
  return { configured, status: !configured ? 'not_configured' : verifiedAt ? 'connected' : 'ready',
    message: !configured ? '尚未配置 GridStatus API Key。CAISO 官方公开数据可正常独立使用。'
      : verifiedAt ? '连接已验证。可访问范围以当前账号授权为准。'
        : '已配置凭据，点击验证连接以检查账号可访问的数据集。' };
}

/** Only fixed GridStatus paths can be reached. No secret or raw upstream errors are returned. */
async function api(path: string, query?: URLSearchParams): Promise<any> {
  const key = getKey();
  if (!key) throw new GridStatusError('NOT_CONFIGURED', '需要在网站服务端配置 GRIDSTATUS_API_KEY 后使用。', 503);
  const cacheKey = path + '?' + (query?.toString() || '');
  const cached = cache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.body;
  const url = BASE + path + (query ? '?' + query.toString() : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {headers: {'x-api-key': key, Accept: 'application/json'}, signal: controller.signal, redirect: 'manual'});
    if (response.status === 401 || response.status === 403) throw new GridStatusError('ACCESS_DENIED', 'GridStatus 拒绝访问，请检查 Key、数据集权限或账号套餐。', 403);
    if (response.status === 429) throw new GridStatusError('RATE_LIMITED', 'GridStatus 请求频率或账号额度受限，请稍后重试并检查用量。', 429);
    if (!response.ok) throw new GridStatusError('UPSTREAM_HTTP', `GridStatus 暂时无法返回数据（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new GridStatusError('TOO_LARGE', '返回数据超过单次读取上限，请缩短日期范围。');
    if (!response.body) throw new GridStatusError('EMPTY_RESPONSE', 'GridStatus 返回了空响应。');
    const reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
    while (true) { const {value, done} = await reader.read(); if (done) break; total += value.byteLength; if (total > 8 * 1024 * 1024) { await reader.cancel(); throw new GridStatusError('TOO_LARGE', '返回数据超过单次读取上限。'); } chunks.push(value); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GridStatusError('SCHEMA_CHANGED', 'GridStatus 返回了无法识别的格式。'); }
    if (body.status_code && body.status_code !== 200) throw new GridStatusError('QUERY_FAILED', 'GridStatus 未完成本次查询，请检查授权和查询条件。');
    cache.set(cacheKey, {until: Date.now() + 5 * 60000, body});
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    return body;
  } catch (error) {
    if (error instanceof GridStatusError) throw error;
    throw new GridStatusError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE', controller.signal.aborted ? 'GridStatus 响应超过 20 秒，请稍后重试。' : '暂时无法连接 GridStatus。');
  } finally { clearTimeout(timer); }
}

export async function availableDatasets(): Promise<GridStatusConnection> {
  const body = await api('/datasets');
  if (!Array.isArray(body.data)) throw new GridStatusError('SCHEMA_CHANGED', 'GridStatus 数据目录结构发生变化。');
  const datasets = body.data.filter((d: any) => typeof d.id === 'string' && /^caiso_[a-z0-9_]+$/.test(d.id)).map((d: any) => ({id:d.id, name:String(d.name || d.id), earliest:d.earliest_available_time_utc || null, latest:d.latest_available_time_utc || null}));
  verifiedAt = Date.now();
  return {...connectionStatus(), status:'connected', datasets, message:`连接已验证，账号可访问 ${datasets.length} 个 CAISO 数据集。`};
}

export function validateGridStatusQuery(params: URLSearchParams) {
  const dataset = params.get('dataset') || '';
  if (!/^caiso_[a-z0-9_]{1,100}$/.test(dataset)) throw new GridStatusError('INVALID_DATASET', '请选择有效的 CAISO 数据集。', 400);
  const start = params.get('start') || '', end = params.get('end') || start;
  let window: {startUtc:string;endUtc:string};
  try { window = getQueryWindow(start, end); } catch { throw new GridStatusError('INVALID_DATE', '请选择有效的 1 至 7 个太平洋交易日。', 400); }
  const limit = Number(params.get('limit') || 300);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new GridStatusError('INVALID_LIMIT', '单次返回行数应为 1 至 1000。', 400);
  const query = new URLSearchParams({start_time:window.startUtc, end_time:window.endUtc, limit:String(limit), page_size:String(limit), return_format:'json'});
  return {dataset,start,end,limit,query};
}

export async function queryGridStatus(params: URLSearchParams) {
  const {dataset,start,end,limit,query} = validateGridStatusQuery(params);
  const body = await api(`/datasets/${dataset}/query`, query);
  if (!Array.isArray(body.data)) throw new GridStatusError('SCHEMA_CHANGED', 'GridStatus 返回的数据结构无法识别。');
  return {ok:true, dataset, source:'GridStatus Hosted API', sourceUrl:`https://www.gridstatus.io/datasets/${dataset}`,
    fetchedAt:new Date().toISOString(), startDate:start, endDate:end, limit, rows:body.data,
    limited:body.data.length >= limit || !!body.meta?.hasNextPage,
    note:'这是按账号权限返回的有界查询；达到行数上限不表示数据已完整。预测来源及发布时间请以数据集元数据为准。'};
}

export async function gridStatusUsage() {
  const body = await api('/api_usage');
  // The upstream usage object is numeric/account-usage data, never a credential response.
  return {ok:true, source:'GridStatus Hosted API', fetchedAt:new Date().toISOString(), usage:body.data ?? body};
}
