import { env } from 'cloudflare:workers';
import type { RecordSummary } from './strategy-types';

export class ResearchError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

function database(): D1Database {
  if (!env.DB) throw new ResearchError('STORAGE_UNAVAILABLE', '研究记录存储尚不可用，请稍后重试。当前内容没有保存成功。', 503);
  return env.DB;
}

export async function sha256(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function saveResearchRecord(summary: RecordSummary, payload: unknown) {
  const db = database();
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > 7_500_000)
    throw new ResearchError('RECORD_TOO_LARGE', '本次记录过大。请缩短日期范围或减少节点后运行。', 413);
  const parts: string[] = [];
  for (let i = 0; i < body.length;) {
    let end = Math.min(i + 100_000, body.length);
    // Keep UTF-16 surrogate pairs intact before SQLite encodes each part as UTF-8.
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xD800 && last <= 0xDBFF) end--;
    parts.push(body.slice(i, end)); i = end;
  }
  const statements = [db.prepare('INSERT INTO research_records (id, kind, name, created_at, digest, summary_json, part_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(summary.id, summary.kind, summary.name, summary.createdAt, summary.digest, JSON.stringify(summary), parts.length),
    ...parts.map((part, i) => db.prepare('INSERT INTO research_record_parts (record_id, part, payload) VALUES (?, ?, ?)').bind(summary.id, i, part))];
  await db.batch(statements);
}

export async function listResearchRecords(): Promise<RecordSummary[]> {
  const db = database();
  const pages = await Promise.all(['price','forecast','run'].map(kind=>
    db.prepare('SELECT summary_json FROM research_records WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(kind).all<{summary_json: string}>()));
  return pages.flatMap(page=>page.results.map(row=>JSON.parse(row.summary_json) as RecordSummary))
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
}

export async function readResearchRecord<T>(id: string, kind: RecordSummary['kind']): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new ResearchError('INVALID_ID', '记录编号无效。');
  const db = database();
  const record = await db.prepare('SELECT kind, part_count FROM research_records WHERE id = ?').bind(id).first<{kind: string; part_count: number}>();
  if (!record || record.kind !== kind) throw new ResearchError('RECORD_NOT_FOUND', '未找到这份记录，请刷新列表后重试。', 404);
  const parts = await db.prepare('SELECT part, payload FROM research_record_parts WHERE record_id = ? ORDER BY part').bind(id).all<{part: number; payload: string}>();
  if (parts.results.length !== record.part_count || parts.results.some((p, i) => p.part !== i))
    throw new ResearchError('RECORD_INCOMPLETE', '记录内容不完整，已停止读取。', 500);
  return JSON.parse(parts.results.map(row => row.payload).join('')) as T;
}
