export type LocalNow = { date: string; minute: number };

/** Current date and minute-of-day in the tenant's timezone. */
export function localNow(timeZone: string, at = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function fmtMinute(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

const weekdayFmt = new Intl.DateTimeFormat("nb-NO", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const shortFmt = new Intl.DateTimeFormat("nb-NO", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function fmtDay(date: string, style: "long" | "short" = "long"): string {
  const s = (style === "long" ? weekdayFmt : shortFmt).format(new Date(`${date}T00:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 0 = Monday … 6 = Sunday */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export type Slot = { start: number; end: number };

export function slotsFor(t: { day_start_min: number; day_end_min: number; slot_min: number }): Slot[] {
  const out: Slot[] = [];
  for (let s = t.day_start_min; s + t.slot_min <= t.day_end_min; s += t.slot_min) {
    out.push({ start: s, end: s + t.slot_min });
  }
  return out;
}

/** A slot can be booked/cancelled until it has ended. */
export function slotIsOver(date: string, endMin: number, now: LocalNow): boolean {
  return date < now.date || (date === now.date && endMin <= now.minute);
}
