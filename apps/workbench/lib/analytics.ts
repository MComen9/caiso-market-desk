import type {Market, MarketResponse, PriceInterval} from './types';
import {enumerateHours} from './time';

export interface HourlyRow {
  node: string;
  startUtc: string;
  endUtc: string;
  localDate: string;
  localHour: string;
  utcOffset: string;
  hourEnding: number;
  dam: number | null;
  fmm: number | null;
  rtd: number | null;
  spread: number | null;
  fmmCount: number;
  rtdCount: number;
  paired: boolean;
  quality: 'complete' | 'partial' | 'missing';
  damComponents: Record<string, number | null>;
  fmmComponents: Record<string, number | null>;
  rtdComponents: Record<string, number | null>;
}

export function mean(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return valid.length ? valid.reduce((sum, n) => sum + n, 0) / valid.length : null;
}

function hourlyMarket(intervals: PriceInterval[], startMs: number, minutes: number) {
  const expected = 60 / minutes;
  const slots = new Map<number, PriceInterval[]>();
  for (const interval of intervals) {
    const timestamp = Date.parse(interval.startUtc);
    const slot = (timestamp - startMs) / (minutes * 60000);
    if (!Number.isInteger(slot) || slot < 0 || slot >= expected) continue;
    if (Date.parse(interval.endUtc) - timestamp !== minutes * 60000) continue;
    const group = slots.get(slot) || [];
    group.push(interval);
    slots.set(slot, group);
  }
  const valid = [...slots.values()].filter(g => g.length === 1 && g[0].quality === 'ok' && g[0].price !== null && Number.isFinite(g[0].price)).map(g => g[0]);
  const complete = valid.length === expected;
  const componentKeys = [...new Set(intervals.flatMap(x => Object.keys(x.components)))];
  const components: Record<string, number | null> = {};
  for (const key of componentKeys) {
    const values = valid.map(x => x.components[key]);
    components[key] = complete && values.every(x => x !== null && x !== undefined && Number.isFinite(x)) ? mean(values) : null;
  }
  return {value: complete ? mean(valid.map(x => x.price)) : null, count: valid.length, components};
}

export function buildHourlyRows(markets: Partial<Record<Market, MarketResponse>>, node: string, startDate: string, endDate: string): HourlyRow[] {
  const indexed: Record<Market, Map<number, PriceInterval[]>> = {DAM: new Map(), FMM: new Map(), RTD: new Map()};
  for (const market of ['DAM', 'FMM', 'RTD'] as Market[]) {
    for (const row of markets[market]?.intervals || []) {
      if (row.node !== node || row.localDate < startDate || row.localDate > endDate) continue;
      const hour = Math.floor(Date.parse(row.startUtc) / 3600000) * 3600000;
      const group = indexed[market].get(hour) || [];
      group.push(row);
      indexed[market].set(hour, group);
    }
  }
  return enumerateHours(startDate, endDate).map(hour => {
    const t = Date.parse(hour.startUtc);
    const dam = hourlyMarket(indexed.DAM.get(t) || [], t, 60);
    const fmm = hourlyMarket(indexed.FMM.get(t) || [], t, 15);
    const rtd = hourlyMarket(indexed.RTD.get(t) || [], t, 5);
    const paired = dam.value !== null && fmm.value !== null;
    const any = dam.count + fmm.count + rtd.count > 0;
    return {...hour, node, dam: dam.value, fmm: fmm.value, rtd: rtd.value,
      spread: paired ? fmm.value! - dam.value! : null,
      fmmCount: fmm.count, rtdCount: rtd.count, paired,
      quality: paired && rtd.value !== null ? 'complete' : any ? 'partial' : 'missing',
      damComponents: dam.components, fmmComponents: fmm.components, rtdComponents: rtd.components,
    };
  });
}
