import type { Child, FC } from "hono/jsx";
import { KIND_LABEL, slotKey, type Booking, type Machine, type Tenant, type WaitEntry } from "./db.ts";
import { fmtDay, fmtMinute, slotIsOver, type LocalNow, type Slot } from "./time.ts";

export const FLASH: Record<string, string> = {
  booked: "Booket! 🧺",
  cancelled: "Bookingen er avbestilt.",
  taken: "Beklager, noen var raskere – den tiden er allerede tatt.",
  limit: "Du har nådd maks antall aktive bookinger.",
  invalid: "Ugyldig forespørsel.",
  over: "Den tiden er allerede passert.",
  "no-apt": "Velg leiligheten din først.",
  "bad-apt": "Ukjent leilighetsnummer.",
  waiting: "Du står på ventelisten. Slå på varsler for å få beskjed når tiden blir ledig.",
  unwaited: "Du er fjernet fra ventelisten.",
  note: "Kommentaren er lagret.",
  "wrong-password": "Feil passord.",
  saved: "Lagret.",
};

export const Layout: FC<{ title: string; children: Child; tenant?: Tenant; vapidKey?: string }> = (p) => (
  <html lang="nb">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#1f4f7a" />
      <title>{p.title}</title>
      <link rel="stylesheet" href="/style.css" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <script type="module" src="/app.js" defer></script>
    </head>
    <body data-slug={p.tenant?.slug} data-vapid={p.vapidKey}>
      {p.children}
    </body>
  </html>
);

const Flash: FC<{ code?: string }> = ({ code }) =>
  code && FLASH[code] ? <p class={`flash ${["taken", "limit", "invalid", "over", "bad-apt", "wrong-password"].includes(code) ? "err" : ""}`}>{FLASH[code]}</p> : null;

const Hidden: FC<{ fields: Record<string, string | number> }> = ({ fields }) => (
  <>
    {Object.entries(fields).map(([k, v]) => (
      <input type="hidden" name={k} value={String(v)} />
    ))}
  </>
);

export const PasswordPage: FC<{ tenant: Tenant; action: string; heading: string; flash?: string }> = (p) => (
  <Layout title={p.tenant.name} tenant={p.tenant}>
    <main class="narrow">
      <h1>{p.heading}</h1>
      <Flash code={p.flash} />
      <form method="post" action={p.action} class="stack">
        <label>
          Passord
          <input type="password" name="password" required autofocus autocomplete="current-password" />
        </label>
        <button>Logg inn</button>
      </form>
    </main>
  </Layout>
);

export const ApartmentPicker: FC<{ tenant: Tenant; apartments: string[]; current?: string }> = (p) => (
  <form method="post" action={`/${p.tenant.slug}/apartment`} class="apt-picker">
    <label>
      Hvilken leilighet bor du i?
      {p.apartments.length ? (
        <select name="apartment" required>
          <option value="">Velg…</option>
          {p.apartments.map((a) => (
            <option value={a} selected={a === p.current}>
              {a}
            </option>
          ))}
        </select>
      ) : (
        <input name="apartment" required placeholder="f.eks. H0203" value={p.current ?? ""} autocomplete="off" />
      )}
    </label>
    <button>Lagre</button>
  </form>
);

type BoardProps = {
  tenant: Tenant;
  machines: Machine[];
  days: string[];
  slots: Slot[];
  bookings: Booking[];
  waitlist: WaitEntry[];
  apartment?: string;
  apartments: string[];
  now: LocalNow;
  flash?: string;
  changeApt: boolean;
  vapidKey: string;
};

export const BoardPage: FC<BoardProps> = (p) => {
  const bySlot = new Map(p.bookings.map((b) => [slotKey(b.machine_id, b.date, b.start_min), b]));
  const waitCount = new Map<string, number>();
  const myWaits = new Set<string>();
  for (const w of p.waitlist) {
    const k = slotKey(w.machine_id, w.date, w.start_min);
    waitCount.set(k, (waitCount.get(k) ?? 0) + 1);
    if (w.apartment === p.apartment) myWaits.add(k);
  }
  const machineName = new Map(p.machines.map((m) => [m.id, m.name]));
  const mine = p.bookings.filter((b) => b.apartment === p.apartment && !slotIsOver(b.date, b.end_min, p.now));
  const myWaitEntries = p.waitlist.filter((w) => w.apartment === p.apartment);
  const base = `/${p.tenant.slug}`;

  return (
    <Layout title={`Vaskekjeller – ${p.tenant.name}`} tenant={p.tenant} vapidKey={p.vapidKey}>
      <header class="top">
        <h1>{p.tenant.name}</h1>
        {p.apartment && !p.changeApt && (
          <p class="whoami">
            Leilighet <strong>{p.apartment}</strong> · <a href={`${base}?bytt=1`}>bytt</a>
          </p>
        )}
      </header>
      <main>
        <Flash code={p.flash} />
        {(!p.apartment || p.changeApt) && <ApartmentPicker tenant={p.tenant} apartments={p.apartments} current={p.apartment} />}

        {p.apartment && (
          <div id="push-banner" class="push-banner" hidden>
            <span id="push-text">Få varsel når en tid du venter på blir ledig.</span>
            <button type="button" id="push-toggle">
              Slå på varsler
            </button>
          </div>
        )}

        {p.apartment && (mine.length > 0 || myWaitEntries.length > 0) && (
          <section class="mine">
            <h2>Dine tider</h2>
            <ul>
              {mine.map((b) => (
                <li>
                  <a href={`#d-${b.date}`}>
                    {fmtDay(b.date, "short")} {fmtMinute(b.start_min)}–{fmtMinute(b.end_min)}
                  </a>{" "}
                  · {machineName.get(b.machine_id) ?? "?"}
                  {b.note && <em> – {b.note}</em>}
                </li>
              ))}
              {myWaitEntries.map((w) => (
                <li class="muted">
                  Venteliste: {fmtDay(w.date, "short")} {fmtMinute(w.start_min)} · {machineName.get(w.machine_id) ?? "?"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {p.machines.length === 0 && <p>Ingen maskiner er satt opp ennå.</p>}

        {p.days.map((date) => (
          <section class="day" id={`d-${date}`}>
            <h2>{fmtDay(date)}</h2>
            <div class="table-wrap">
              <table class="board">
                <thead>
                  <tr>
                    <th class="time">Tid</th>
                    {p.machines.map((m) => (
                      <th>
                        {m.name}
                        <small>{KIND_LABEL[m.kind]}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.slots.map((s) => {
                    const over = slotIsOver(date, s.end, p.now);
                    return (
                      <tr class={over ? "over" : ""}>
                        <td class="time">
                          {fmtMinute(s.start)}
                          <br />
                          {fmtMinute(s.end)}
                        </td>
                        {p.machines.map((m) => {
                          const k = slotKey(m.id, date, s.start);
                          const b = bySlot.get(k);
                          const slotFields = { machine_id: m.id, date, start: s.start };
                          const label = `${m.name}, ${fmtDay(date, "short")} ${fmtMinute(s.start)}–${fmtMinute(s.end)}`;
                          if (!b) {
                            if (over || !p.apartment) return <td class="cell free">{over ? "" : "Ledig"}</td>;
                            return (
                              <td class="cell free">
                                <form method="post" action={`${base}/book`} data-book={label}>
                                  <Hidden fields={slotFields} />
                                  <button class="slot-btn">Ledig</button>
                                </form>
                              </td>
                            );
                          }
                          const isMine = b.apartment === p.apartment;
                          const waiting = waitCount.get(k) ?? 0;
                          return (
                            <td class={`cell taken ${isMine ? "mine" : ""}`}>
                              <span class="apt">{isMine ? "Deg" : b.apartment}</span>
                              {b.note && <span class="note">{b.note}</span>}
                              {!over && isMine && (
                                <form method="post" action={`${base}/cancel`} data-confirm={`Avbestille ${label}?`}>
                                  <Hidden fields={{ booking_id: b.id }} />
                                  <button class="link">Avbestill</button>
                                </form>
                              )}
                              {!over && !isMine && p.apartment && (
                                <form method="post" action={`${base}/${myWaits.has(k) ? "unwait" : "wait"}`} data-wait>
                                  <Hidden fields={slotFields} />
                                  <button class="link">{myWaits.has(k) ? "Forlat venteliste" : "Venteliste"}</button>
                                </form>
                              )}
                              {!over && waiting > 0 && <span class="waiting">{waiting} venter</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </main>

      <dialog id="book-dialog">
        <form method="dialog" class="stack">
          <h3 id="book-title">Book</h3>
          <label>
            Kommentar (valgfritt)
            <input name="note" maxlength={140} placeholder="f.eks. trenger bare 30 min" autocomplete="off" />
          </label>
          <menu>
            <button value="cancel" type="submit" class="secondary">
              Avbryt
            </button>
            <button value="ok" type="submit">
              Book
            </button>
          </menu>
        </form>
      </dialog>
      <footer class="foot">
        <a href={`${base}/admin`}>Admin</a>
      </footer>
    </Layout>
  );
};
