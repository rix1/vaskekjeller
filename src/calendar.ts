import type { Booking, Machine, Tenant } from "./db.ts";
import { zonedToUtc } from "./time.ts";

// "Add to calendar": a single-event .ics for one reservation (one or two machines at the
// same time). A download, not a subscription, so there is no feed, token or refresh.

/** Escape a TEXT value per RFC 5545 (backslash, semicolon, comma, newlines). */
export function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Fold a content line to at most 75 octets; continuation lines start with one
 * space (RFC 5545 §3.1). Splits between code points so UTF-8 is never cut.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const segments: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      segments.push(current);
      current = ch;
      bytes = size;
      limit = 74; // the leading space counts
    } else {
      current += ch;
      bytes += size;
    }
  }
  segments.push(current);
  return segments.join("\r\n ");
}

const stampUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** "Vask & tørk", "Vask" or "Tørk"; machine names when a room has more of a kind. */
export function machinesLabel(machines: Machine[]): string {
  const washers = machines.filter((m) => m.kind === "washer").length;
  const dryers = machines.length - washers;
  if (washers <= 1 && dryers <= 1) return washers && dryers ? "Vask & tørk" : dryers ? "Tørk" : "Vask";
  return machines.map((m) => m.name).join(" + ");
}

/** The iCalendar document for one reservation: the bookings share a date, time and apartment. */
export function buildEvent(tenant: Tenant, bookings: Booking[], machines: Machine[], origin: string, at = new Date()): string {
  const b = bookings[0]!;
  const used = machines.filter((m) => bookings.some((x) => x.machine_id === m.id));
  const names = used.map((m) => m.name).join(" + ");
  const note = bookings.find((x) => x.note)?.note;
  const url = `${origin}/${tenant.slug}?date=${b.date}`;
  const description = [names, note && `Kommentar: ${note}`, `Se dagen: ${url}`];
  const stamp = stampUtc(at);
  const lines: string[] = [];
  const prop = (line: string) => lines.push(foldLine(line));
  prop("BEGIN:VCALENDAR");
  prop("VERSION:2.0");
  prop("PRODID:-//Vaskekjeller//Vasketider//NO");
  prop("CALSCALE:GREGORIAN");
  prop("METHOD:PUBLISH");
  prop("BEGIN:VEVENT");
  // Stable per reservation, so adding it again updates the event instead of duplicating it.
  prop(`UID:${b.date}-${b.start_min}-${b.end_min}-${encodeURIComponent(b.apartment)}@${tenant.slug}.vaskekjeller`);
  prop(`DTSTAMP:${stamp}`);
  prop(`DTSTART:${stampUtc(zonedToUtc(b.date, b.start_min, tenant.timezone))}`);
  prop(`DTEND:${stampUtc(zonedToUtc(b.date, b.end_min, tenant.timezone))}`);
  prop(`SUMMARY:${escapeText(`${machinesLabel(used)} · ${tenant.name}`)}`);
  prop(`LOCATION:${escapeText(tenant.name)}`);
  prop(`DESCRIPTION:${escapeText(description.filter(Boolean).join("\n"))}`);
  prop(`URL:${url}`);
  prop("TRANSP:OPAQUE");
  prop("END:VEVENT");
  prop("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
