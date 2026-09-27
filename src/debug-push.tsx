// Push test page for admins (/<slug>/admin/debug): runs the two notification flows end to end on a real slot,
// with a made-up household as the other party, so an admin can check that pushes reach their phone.
import type { FC } from "hono/jsx";
import { AdminPage } from "./admin-views.tsx";
import type { Booking, Machine, Tenant, WaitEntry } from "./db.ts";
import type { PushOutcome } from "./push.ts";
import { fmtDay, fmtMinute, type LocalNow, type Slot } from "./time.ts";

/** The other household in the tests. Real apartments are normalized (upper case, no spaces), so none can be this. */
export const TEST_APARTMENT = "TEST (varsler)";
/** Comment on the admin's own test booking, which is how the cleanup finds it again. */
export const TEST_NOTE = "Test av varsler – slettes ved opprydding";

export type TestSlot = { machine: Pick<Machine, "id" | "name">; date: string; start: number; end: number };

/** The first slot that has not started, that nobody holds and nobody waits for; a washer when one is free. */
export function pickTestSlot(
  machines: Machine[],
  days: string[],
  slots: Slot[],
  now: LocalNow,
  bookings: Pick<Booking, "machine_id" | "date" | "start_min" | "end_min">[],
  waitlist: Pick<WaitEntry, "machine_id" | "date" | "start_min">[],
): TestSlot | undefined {
  const ordered = [...machines.filter((m) => m.kind === "washer"), ...machines.filter((m) => m.kind !== "washer")];
  for (const date of days)
    for (const s of slots) {
      if (date === now.date && s.start <= now.minute) continue;
      const machine = ordered.find(
        (m) =>
          !bookings.some((b) => b.machine_id === m.id && b.date === date && b.start_min < s.end && b.end_min > s.start) &&
          !waitlist.some((w) => w.machine_id === m.id && w.date === date && w.start_min === s.start),
      );
      if (machine) return { machine, date, start: s.start, end: s.end };
    }
  return undefined;
}

export type DebugTest = "freed" | "waiting" | "cleanup";
export type DebugError = "no-apt" | "no-slot";
export type DebugResult = { test: DebugTest; error?: DebugError; slot?: TestSlot; outcome?: PushOutcome };

const when = (s: TestSlot) => `${s.machine.name} ${fmtDay(s.date, "short").toLowerCase()} ${fmtMinute(s.start)}–${fmtMinute(s.end)}`;

const outcomeLabel = (o: PushOutcome) => (o.sent ? "Sendt" : o.devices ? "Feilet" : "Ingen enheter");

function outcomeText(o: PushOutcome, apartment: string) {
  if (!o.devices) return `Ikke sendt: Leil. ${apartment} har ingen enheter med varsler på.`;
  const parts = [`Sendt til ${o.sent} av ${o.devices} ${o.devices === 1 ? "enhet" : "enheter"}.`];
  if (o.gone) parts.push(`${o.gone} var utløpt og er fjernet.`);
  if (o.failed) parts.push(`${o.failed} feilet. Se loggen i Cloudflare.`);
  return parts.join(" ");
}

const ResultCard: FC<{ result: DebugResult; apartment?: string; horizon: number }> = ({ result, apartment, horizon }) => {
  const { test, error, slot, outcome } = result;
  if (test === "cleanup")
    return (
      <section class="card debug-result ok" role="status">
        <h2>Ryddet opp</h2>
        <p>Bookingene og ventelisteplassene til {TEST_APARTMENT} er fjernet, og testbookingen din er avbestilt.</p>
      </section>
    );
  const heading = test === "freed" ? "Test 1: tiden ble ledig" : "Test 2: noen venter på tiden din";
  if (error)
    return (
      <section class="card debug-result error" role="status">
        <h2>{heading}</h2>
        <p>
          {error === "no-apt"
            ? "Velg leilighet på bookingsiden på denne enheten først."
            : `Fant ingen ledig tid uten venteliste de neste ${horizon} dagene.`}
        </p>
      </section>
    );
  if (!slot || !outcome || !apartment) return null;
  return (
    <section class={`card debug-result ${outcome.sent ? "ok" : "error"}`} role="status">
      <div class="card-head">
        <h2>{heading}</h2>
        <span class="debug-pill">{outcomeLabel(outcome)}</span>
      </div>
      {test === "freed" ? (
        <p>
          {TEST_APARTMENT} booket {when(slot)}, Leil. {apartment} ble satt på ventelisten, og {TEST_APARTMENT} avbestilte.
          Da skal Leil. {apartment} få «{slot.machine.name} er ledig!».
        </p>
      ) : (
        <p>
          Leil. {apartment} booket {when(slot)}, og {TEST_APARTMENT} satte seg på ventelisten. Da skal Leil. {apartment} få
          «Noen venter på tiden din».
        </p>
      )}
      <p>
        <strong>{outcomeText(outcome, apartment)}</strong>
      </p>
      <p class="hint">
        {test === "freed"
          ? "Testbookingen og ventelisteplassen er allerede fjernet."
          : "Bookingen og ventelisteplassen ligger der til du trykker «Rydd opp», så du kan åpne tiden fra varselet."}
      </p>
    </section>
  );
};

export const DebugPushPage: FC<{
  tenant: Tenant;
  /** The apartment this device uses on the booking page; the tests run as it. */
  apartment?: string;
  /** Devices with notifications on for that apartment. */
  devices: number;
  vapidKey: string;
  result?: DebugResult;
}> = (p) => {
  const base = `/${p.tenant.slug}`;
  const action = (path: string) => `${base}/admin/debug/${path}`;
  const disabled = !p.apartment;
  return (
    <AdminPage tenant={p.tenant} title="Test varsler" active="debug" head={<script type="module" src="/debug.js" defer></script>}>
      <div class="admin-stack debug-stack">
        {p.result && <ResultCard result={p.result} apartment={p.apartment} horizon={p.tenant.booking_horizon_days} />}

        <section class="card" aria-labelledby="enheten">
          <div class="card-head">
            <h2 id="enheten">Denne enheten</h2>
            <p>
              Testene bruker leiligheten du har valgt på bookingsiden, og bare denne vaskekjelleren. Den andre parten er en egen
              testhusstand, «{TEST_APARTMENT}», som fjernes etterpå.
            </p>
          </div>
          {p.apartment ? (
            <>
              <p>
                Testene kjøres som <strong>Leil. {p.apartment}</strong>.{" "}
                {p.devices
                  ? `${p.devices} ${p.devices === 1 ? "enhet" : "enheter"} har varsler på for denne leiligheten.`
                  : "Ingen enheter har varsler på for denne leiligheten ennå."}
              </p>
              <div
                id="device-status"
                class="device-status"
                data-apartment={p.apartment}
                data-vapid={p.vapidKey}
                data-api={`${base}/admin/debug`}
              >
                <p id="device-text">Sjekker varsler på denne enheten …</p>
                <button type="button" id="device-subscribe" class="button" hidden>
                  Slå på varsler for Leil. {p.apartment}
                </button>
              </div>
            </>
          ) : (
            <p>
              Denne enheten har ikke valgt leilighet. <a href={base}>Åpne bookingsiden</a>, velg leiligheten din, og kom tilbake
              hit.
            </p>
          )}
        </section>

        <section class="card" aria-labelledby="test-ledig">
          <div class="card-head">
            <h2 id="test-ledig">1. En tid blir ledig</h2>
            <p>
              {TEST_APARTMENT} booker en ledig tid snart, du settes på ventelisten, og {TEST_APARTMENT} avbestiller. Da skal du få
              «… er ledig!», akkurat som når en nabo avbestiller.
            </p>
          </div>
          <form method="post" action={action("freed")}>
            <button class="button" disabled={disabled}>
              Kjør test 1
            </button>
          </form>
        </section>

        <section class="card" aria-labelledby="test-venter">
          <div class="card-head">
            <h2 id="test-venter">2. Noen venter på tiden din</h2>
            <p>
              Du booker en ledig tid snart (med kommentaren «{TEST_NOTE}»), og {TEST_APARTMENT} setter seg på ventelisten. Da skal
              du få «Noen venter på tiden din».
            </p>
          </div>
          <form method="post" action={action("waiting")}>
            <button class="button" disabled={disabled}>
              Kjør test 2
            </button>
          </form>
        </section>

        <section class="card" aria-labelledby="rydd-opp">
          <div class="card-head">
            <h2 id="rydd-opp">Rydd opp</h2>
            <p>
              Fjerner alle bookinger og ventelisteplasser til {TEST_APARTMENT}, og avbestiller testbookingen din fra test 2, så
              naboer som har satt seg på ventelisten får beskjed. Hver test rydder også opp etter forrige test før den starter.
            </p>
          </div>
          <form method="post" action={action("cleanup")}>
            <button class="button secondary">Rydd opp</button>
          </form>
        </section>
      </div>
    </AdminPage>
  );
};
