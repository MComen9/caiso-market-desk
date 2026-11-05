/** Shared contract for public CAISO fundamental feeds. All times are ISO UTC. */
export type FeedStatus = 'ok' | 'partial' | 'error' | 'unavailable' | 'not_configured';
export type SourceKind = 'outlook' | 'oasis' | 'gridstatus';
export interface FeedColumn {
  key: string;
  label: string;
  unit: string;
  kind?: 'actual' | 'forecast' | 'capacity' | 'reserve' | 'other';
  nativeMinutes?: number | null;
  /** Primary display series; regional totals must never be added together. */
  primary?: boolean;
  area?: string;
  resource?: string;
}
export interface FeedRow {
  startUtc: string | null;
  endUtc: string | null;
  /** Preserve an ambiguous source clock label instead of inventing a DST fold. */
  sourceTime?: string;
  values: Record<string, number | null>;
  publishTimeUtc?: string | null;
  quality?: 'ok' | 'missing' | 'ambiguous';
}
export interface FeedTable {
  columns: {key: string; label: string; unit?: string}[];
  rows: Record<string, string | number | null>[];
}
export interface DataFeed {
  id: string;
  title: string;
  source: SourceKind;
  status: FeedStatus;
  sourceUrl: string;
  fetchedAt: string;
  lastModified?: string | null;
  requestedDate: string;
  dataDate: string | null;
  timeZone: 'America/Los_Angeles';
  unit: string;
  intervalMinutes: number | null;
  columns: FeedColumn[];
  rows: FeedRow[];
  /** Non-timeseries records, e.g. daily MWh / peaks. */
  table?: FeedTable;
  /** Current statistics keep source field names and source timestamps. */
  stats?: Record<string, unknown>;
  warnings: string[];
  notes: string[];
  error?: {code: string; message: string};
  cached?: boolean;
}
export interface DataBundle {
  ok: boolean;
  date: string;
  fetchedAt: string;
  feeds: Record<string, DataFeed>;
  warnings: string[];
}
export interface DataArchive {
  generatedAt: string;
  byDate: Record<string, DataBundle>;
}
export interface GridStatusConnection {
  configured: boolean;
  status: 'not_configured' | 'ready' | 'connected' | 'error';
  message: string;
  datasets?: {id: string; name: string; earliest?: string | null; latest?: string | null}[];
  error?: {code: string; message: string};
}
