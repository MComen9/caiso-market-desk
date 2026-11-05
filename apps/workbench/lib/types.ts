export type Market = 'DAM' | 'FMM' | 'RTD';

export interface PriceInterval {
  node: string;
  startUtc: string;
  endUtc: string;
  localDate: string;
  localHour: string;
  utcOffset: string;
  hourEnding: number;
  minutes: number;
  price: number | null;
  components: Record<string, number | null>;
  quality: 'ok' | 'missing' | 'conflict';
}

export interface MarketResponse {
  ok: boolean;
  market: Market;
  source: 'CAISO OASIS';
  sourceUrl: string;
  fetchedAt: string;
  cached: boolean;
  request: {startDate: string; endDate: string; nodes: string[]; startUtc: string; endUtc: string};
  intervals: PriceInterval[];
  warnings: string[];
  error?: {code: string; message: string};
}

export interface BootstrapData {
  label: string;
  startDate: string;
  endDate: string;
  markets: Partial<Record<Market, MarketResponse>>;
}

export const HUBS = [
  {id: 'TH_NP15_GEN-APND', short: 'NP15', name: '北加州', description: 'Northern California'},
  {id: 'TH_SP15_GEN-APND', short: 'SP15', name: '南加州', description: 'Southern California'},
  {id: 'TH_ZP26_GEN-APND', short: 'ZP26', name: '中部区域', description: 'Central California'},
] as const;

export const MARKET_LABELS: Record<Market, string> = {DAM: '日前 DA', FMM: '15 分钟 FMM', RTD: '5 分钟实时'};
