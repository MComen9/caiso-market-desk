export const MARKET_TIME_ZONE = 'America/Los_Angeles';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function localParts(value: string | number | Date) {
  const date = new Date(value);
  const p = Object.fromEntries(formatter.formatToParts(date).map(x => [x.type, x.value]));
  const localDate = `${p.year}-${p.month}-${p.day}`;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMinutes = Math.round((wall - date.getTime()) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const n = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return {localDate, localHour: `${p.hour}:${p.minute}`, utcOffset, hourEnding: +p.hour + 1};
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function localDayStartUtc(date: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const p = localParts(guess);
    const localAsUtc = Date.parse(`${p.localDate}T${p.localHour}:00Z`);
    const next = wall - (localAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function enumerateHours(startDate: string, endDate: string) {
  const result: Array<{startUtc: string; endUtc: string; localDate: string; localHour: string; utcOffset: string; hourEnding: number}> = [];
  const end = localDayStartUtc(addDays(endDate, 1));
  for (let t = localDayStartUtc(startDate); t < end; t += 3600000) {
    result.push({startUtc: new Date(t).toISOString(), endUtc: new Date(t + 3600000).toISOString(), ...localParts(t)});
  }
  return result;
}

export function latestCompleteDate(now = new Date()) {
  return addDays(localParts(now).localDate, -1);
}
