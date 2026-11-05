import type { ForecastPoint } from './strategy-types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const NODE = /^[A-Z0-9][A-Z0-9_.-]{1,99}$/;
const MAX_BYTES = 5 * 1024 * 1024;

function csvRows(text: string): string[][] {
  const result: string[][] = []; let row: string[] = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else if (quoted && index + 1 < text.length && ![',', '\r', '\n'].includes(text[index + 1])) throw new Error(`CSV 第 ${result.length + 1} 行的结束引号后包含多余字符。`);
      else if (!quoted && field.trim()) throw new Error(`CSV 第 ${result.length + 1} 行的引号位置无效。`);
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field); if (row.some(value => value.trim())) result.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请检查文件。');
  if (field.length || row.length) { row.push(field); if (row.some(value => value.trim())) result.push(row); }
  return result;
}

export function forecastTimestamp(value: unknown, label: string, wholeHour = false): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim()))
    throw new Error(`${label} 必须是带 Z 或 UTC 偏移的 ISO 时间，不能使用无时区的本地时间。`);
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) throw new Error(`${label} 时间无效。`);
  // Date.parse normalizes February 30; reject invalid calendar dates before normalization.
  const date = value.trim().slice(0, 10), calendar = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date) throw new Error(`${label} 日期不存在。`);
  if (wholeHour && ms % 3600000 !== 0) throw new Error(`${label} 必须对应整点 UTC 小时；本平台按一小时策略时段计算。`);
  return new Date(ms).toISOString();
}

export function normalizeForecastPoints(values: unknown, fallbackModel = ''): ForecastPoint[] {
  if (!Array.isArray(values) || !values.length || values.length > 20000) throw new Error('预测文件需要 1–20,000 行数据。');
  const seen = new Set<string>();
  return values.map((raw, index) => {
    const label = `预测第 ${index + 1} 行`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 必须是对象。`);
    const value = raw as Record<string, unknown>;
    const node = typeof value.node === 'string' ? value.node.trim().toUpperCase() : '';
    if (!NODE.test(node)) throw new Error(`${label} 的 node 不是有效的节点代码。`);
    const startUtc = forecastTimestamp(value.startUtc, `${label} startUtc`, true);
    const issuedAt = forecastTimestamp(value.issuedAt, `${label} issuedAt`);
    if (Date.parse(issuedAt) >= Date.parse(startUtc)) throw new Error(`${label} 的发布时间必须早于目标小时；不能把事后信息标作预测。`);
    const number = (key: string, allowNull = false) => {
      const rawNumber = value[key];
      if (allowNull && (rawNumber === null || rawNumber === undefined || rawNumber === '')) return null;
      const parsed = typeof rawNumber === 'string' && rawNumber.trim() !== '' ? Number(rawNumber.trim()) : rawNumber;
      if (!finite(parsed) || Math.abs(parsed) > 100000) throw new Error(`${label} ${key} 必须是 -100000 至 100000 范围内的有限数值。`);
      return parsed;
    };
    const predictedDa = number('predictedDa')!, predictedSpread = number('predictedSpread')!, sigma = number('sigma', true);
    if (sigma !== null && sigma < 0) throw new Error(`${label} sigma 不能为负数。`);
    const modelVersion = typeof value.modelVersion === 'string' && value.modelVersion.trim() ? value.modelVersion.trim() : fallbackModel.trim();
    if (!modelVersion || modelVersion.length > 120) throw new Error(`${label} 需要 1–120 字符的 modelVersion。`);
    const key = `${node}|${startUtc}|${issuedAt}`;
    if (seen.has(key)) throw new Error(`${label} 与其他行的节点、目标小时、发布时间重复；请保留明确的单一版本。`);
    seen.add(key);
    const trainingEndUtc = value.trainingEndUtc == null || value.trainingEndUtc === '' ? undefined : forecastTimestamp(value.trainingEndUtc, `${label} trainingEndUtc`);
    if (trainingEndUtc && trainingEndUtc > issuedAt) throw new Error(`${label} 的训练数据终点晚于预测发布时间，存在可确认的事后信息。`);
    const sampleCount = value.sampleCount == null ? undefined : value.sampleCount;
    if (sampleCount !== undefined && (!finite(sampleCount) || !Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 1000000)) throw new Error(`${label} sampleCount 必须是 1–1000000 的整数。`);
    return {node, startUtc, predictedDa, predictedSpread, sigma, issuedAt, modelVersion, ...(trainingEndUtc ? {trainingEndUtc} : {}), ...(sampleCount !== undefined ? {sampleCount} : {})};
  }).sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.node.localeCompare(b.node) || a.issuedAt.localeCompare(b.issuedAt));
}

export function parseForecastImport(text: string, metadata: {name: string; source: string; modelVersion: string}, createdAt: string): {points: ForecastPoint[]; warnings: string[]} {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('预测文件不能超过 5 MB。');
  if (!metadata.name?.trim() || metadata.name.length > 120) throw new Error('请输入 1–120 字符的预测批次名称。');
  if (!metadata.source?.trim() || metadata.source.length > 300) throw new Error('请输入 1–300 字符的预测来源名称或说明。');
  const recorded = forecastTimestamp(createdAt, '导入时间');
  let values: unknown;
  if (/^[\s\uFEFF]*[\[{]/.test(text)) {
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 预测文件格式无效。'); }
    values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).points : null;
  } else {
    const rows = csvRows(text);
    if (rows.length < 2) throw new Error('CSV 需要表头和至少一行预测数据。');
    const headers = rows[0].map(value => value.trim());
    if (new Set(headers).size !== headers.length) throw new Error('CSV 表头包含重复字段。');
    const required = ['node', 'startUtc', 'predictedDa', 'predictedSpread', 'sigma', 'issuedAt'];
    const missing = required.filter(key => !headers.includes(key));
    if (missing.length) throw new Error(`CSV 缺少字段：${missing.join(', ')}。请使用页面模板。`);
    values = rows.slice(1).map((row, index) => {
      if (row.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数与表头不一致。`);
      return Object.fromEntries(headers.map((header, column) => [header, row[column].trim()]));
    });
  }
  const points = normalizeForecastPoints(values, metadata.modelVersion);
  if (points.some(point => point.issuedAt > recorded)) throw new Error('预测的 issuedAt 晚于本次导入时间，请检查时区或源文件；平台不接受未来发布的声明。');
  const warnings = [
    'issuedAt 是文件提供者声明的发布时间，平台不会据此证明它当时已存在。createdAt 是本平台实际接收时间。',
    '“已归档时间”回测只使用在决策截点前已被平台接收的批次；事后导入的历史文件仅可做按声明时间重放。',
  ];
  const noSigma = points.filter(point => point.sigma === null || point.sigma === 0).length;
  if (noSigma) warnings.push(`${noSigma} 行未提供正的 sigma；启用 k 门槛的策略会跳过这些时段。`);
  if (new Set(points.map(point => point.modelVersion)).size > 1) warnings.push('此批次包含多个 modelVersion；每个结果时段将保留实际采用的版本。');
  return {points, warnings};
}
