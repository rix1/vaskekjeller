import type { Machine } from "./db.ts";

export type BookingOption = { key: string; label: string; machines: Machine[] };

/** Reserve one washer and one dryer, never every machine in a larger laundry room. */
export function bookingOptions(machines: Machine[]): BookingOption[] {
  const washers = machines.filter((m) => m.kind === "washer");
  const dryers = machines.filter((m) => m.kind === "dryer");
  const pairs = washers.flatMap((washer) =>
    dryers.map((dryer) => ({
      key: `pair-${washer.id}-${dryer.id}`,
      label: washers.length === 1 && dryers.length === 1 ? "Vask & tørk" : `${washer.name} + ${dryer.name}`,
      machines: [washer, dryer],
    })),
  );
  return [
    ...pairs,
    ...machines.map((m) => ({
      key: String(m.id),
      label:
        machines.length === 2 && washers.length === 1 && dryers.length === 1 ? (m.kind === "washer" ? "Kun vask" : "Kun tørk") : m.name,
      machines: [m],
    })),
  ];
}
