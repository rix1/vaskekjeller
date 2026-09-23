import type { Child, FC } from "hono/jsx";
import { bookingOptions } from "./booking-options.ts";
import { KIND_LABEL, slotKey, type Booking, type Machine, type MachineKind, type Tenant, type WaitEntry } from "./db.ts";
import { addDays, fmtDay, fmtMinute, slotIsOver, type LocalNow, type Slot } from "./time.ts";

export const FLASH: Record<string, string> = {
  booked: "Tiden er din. God vask!",
  apartment: "Leiligheten er lagret på denne enheten.",
  cancelled: "Bookingen er avbestilt.",
  taken: "Beklager, noen var raskere – den tiden er allerede tatt.",
  limit: "Du har nådd maks antall aktive bookinger.",
  invalid: "Ugyldig forespørsel.",
  over: "Den tiden er allerede passert.",
  "no-apt": "Velg leiligheten din først.",
  "bad-apt": "Ukjent leilighetsnummer.",
  waiting: "Du står på ventelisten. Slå på varsler for å få beskjed når tiden blir ledig eller får en ny kommentar.",
  unwaited: "Du er fjernet fra ventelisten.",
  note: "Kommentaren er lagret.",
  "wrong-password": "Feil passord.",
  saved: "Lagret.",
};

export const Layout: FC<{
  title: string;
  children: Child;
  tenant?: Tenant;
  vapidKey?: string;
}> = (p) => (
  <html lang="nb">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f6f5f0" />
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

// Codes that explain why something did not happen stay until closed.
const ERROR_CODES = ["taken", "limit", "invalid", "over", "no-apt", "bad-apt", "wrong-password"];

// Server-rendered toasts: CSS fades them out without JavaScript, client/app.ts adds stacking and dismissal.
export const Toaster: FC<{ code?: string; error?: string; dismissHref: string; children?: Child }> = (p) => {
  const message = p.error ?? (p.code ? FLASH[p.code] : undefined);
  const isError = !!p.error || ERROR_CODES.includes(p.code ?? "");
  return (
    <div class="toaster">
      {p.children ||
        (message && (
          <Toast tone={isError ? "error" : "success"} dismissHref={p.dismissHref}>
            <p class="toast-title">{message}</p>
          </Toast>
        ))}
    </div>
  );
};

export const Toast: FC<{ tone: "success" | "error"; long?: boolean; dismissHref: string; action?: Child; children: Child }> = (p) => (
  <div class={`toast ${p.tone}${p.tone === "error" ? "" : p.long ? " auto long" : " auto"}`} role={p.tone === "error" ? "alert" : "status"}>
    <span class="toast-icon">
      <Icon name={p.tone === "error" ? "alert" : "check"} size={16} />
    </span>
    <div class="toast-text">{p.children}</div>
    {p.action}
    <a class="toast-close" href={p.dismissHref} aria-label="Lukk varsel">
      <span aria-hidden="true">×</span>
    </a>
  </div>
);

const Hidden: FC<{ fields: Record<string, string | number> }> = ({ fields }) => (
  <>
    {Object.entries(fields).map(([k, v]) => (
      <input type="hidden" name={k} value={String(v)} />
    ))}
  </>
);

export const PasswordPage: FC<{
  tenant: Tenant;
  action: string;
  heading: string;
  flash?: string;
}> = (p) => (
  <Layout title={p.tenant.name} tenant={p.tenant}>
    <main class="narrow">
      <h1>{p.heading}</h1>
      <form method="post" action={p.action} class="stack">
        <label>
          Passord
          <input type="password" name="password" required autofocus autocomplete="current-password" />
        </label>
        <button>Logg inn</button>
      </form>
    </main>
    <Toaster code={p.flash} dismissHref={p.action} />
  </Layout>
);

export const ApartmentPicker: FC<{
  tenant: Tenant;
  apartments: string[];
  current?: string;
  context?: string;
}> = (p) => (
  <form method="post" action={`/${p.tenant.slug}/apartment${p.context ?? ""}`} class="apt-picker">
    <label>
      Leiligheten din
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
        <input name="apartment" required placeholder="F.eks. A3" value={p.current ?? ""} autocomplete="off" />
      )}
    </label>
    <button>
      {p.current ? "Lagre" : "Fortsett"}
      <span aria-hidden="true"> ↗</span>
    </button>
  </form>
);

const Icon: FC<{
  name?: MachineKind | "arrow" | "clock" | "check" | "home" | "calendar" | "alert";
  size?: number;
}> = ({ name = "washer", size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {name === "washer" ? (
      <>
        <rect x="4" y="2" width="16" height="20" rx="3" />
        <circle cx="12" cy="14" r="5" />
        <path d="M8 5h.01M11 5h.01M15 5h2M8 14c3-3 5 3 8 0" />
      </>
    ) : name === "dryer" ? (
      <>
        <rect x="4" y="2" width="16" height="20" rx="3" />
        <circle cx="12" cy="14" r="5" />
        <path d="M8 5h.01M15 5h2M10.5 11.5c-1 1 1 2 0 3s1 2 0 3M13.5 11.5c-1 1 1 2 0 3s1 2 0 3" />
      </>
    ) : name === "arrow" ? (
      <path d="M5 12h14m-5-5 5 5-5 5" />
    ) : name === "clock" ? (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ) : name === "check" ? (
      <path d="m5 12 4 4L19 6" />
    ) : name === "alert" ? (
      <path d="M12 7v6m0 4h.01" stroke-width="2.2" />
    ) : name === "home" ? (
      <>
        <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" />
      </>
    ) : (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-14 4h2m4 0h2" />
      </>
    )}
  </svg>
);

/** Short and definite machine names for per-machine status in the paired view. */
const KIND_SHORT: Record<MachineKind, string> = { washer: "Vask", dryer: "Tørk" };
const KIND_DEFINITE: Record<MachineKind, string> = { washer: "vaskemaskinen", dryer: "tørketrommelen" };

const MachineIcons: FC<{ machines: Machine[]; size?: number }> = ({ machines, size = 17 }) => (
  <span class="machine-icons">
    {machines.map((m) => (
      <Icon name={m.kind} size={size} />
    ))}
  </span>
);

type BoardProps = {
  tenant: Tenant;
  /** Includes inactive machines, so past days still show who used them. */
  machines: Machine[];
  /** Every viewable day, from the look-back window through the booking horizon. */
  days: string[];
  /** Monday-to-Sunday weeks covering `days`. */
  weeks: string[][];
  slots: Slot[];
  bookings: Booking[];
  waitlist: WaitEntry[];
  apartment?: string;
  apartments: string[];
  now: LocalNow;
  flash?: string;
  vapidKey: string;
  selectedDate?: string;
  mode?: string;
  bookedIds?: string;
  hideHint?: boolean;
};

export const BoardPage: FC<BoardProps> = (p) => {
  const base = `/${p.tenant.slug}`;
  const options = bookingOptions(p.machines.filter((m) => m.active));
  const option = options.find((o) => o.key === p.mode) ?? options[0];
  const selected = p.days.includes(p.selectedDate ?? "") ? p.selectedDate! : p.now.date;
  const past = selected < p.now.date;
  // Past days follow what was booked, even if machines or opening hours have changed since.
  const overlaps = (b: Booking, s: Slot) => b.start_min < s.end && b.end_min > s.start;
  const dayBookings = p.bookings.filter((b) => b.date === selected);
  const pastMachines = p.machines.filter((m) => m.active || dayBookings.some((b) => b.machine_id === m.id));
  const pastSlots = [
    ...p.slots,
    ...dayBookings.filter((b) => !p.slots.some((s) => overlaps(b, s))).map((b) => ({ start: b.start_min, end: b.end_min })),
  ]
    .filter((s, i, all) => all.findIndex((o) => o.start === s.start && o.end === s.end) === i)
    .sort((a, b) => a.start - b.start);
  const mode = option?.key ?? "";
  const query = (date = selected, key = mode) => `?date=${date}&mode=${key}`;
  const url = (date = selected, key = mode) => `${base}${query(date, key)}`;
  const action = (path: string) => `${base}/${path}${query()}`;
  const dayLabel = (date: string) =>
    date === p.now.date ? "I dag" : date === addDays(p.now.date, 1) ? "I morgen" : fmtDay(date, "short").split(" ")[0]!.replace(".", "");
  const conflicts = (date: string, slot: Slot) =>
    p.bookings.filter(
      (b) => option?.machines.some((m) => m.id === b.machine_id) && b.date === date && b.start_min < slot.end && b.end_min > slot.start,
    );
  const available = (date: string) =>
    !option ? 0 : p.slots.filter((s) => !slotIsOver(date, s.end, p.now) && !conflicts(date, s).length).length;
  // A slot is partly free when some, but not all, machines of the selected option are taken.
  const partlyFree = (date: string, slot: Slot) => {
    const taken = conflicts(date, slot);
    return taken.length > 0 && !!option?.machines.some((m) => !taken.some((b) => b.machine_id === m.id));
  };
  const dayStatus = (date: string) => {
    if (date < p.now.date) return { text: "Passert", label: "passert", state: "past" };
    const open = p.slots.filter((s) => !slotIsOver(date, s.end, p.now));
    const free = available(date);
    const partial = open.filter((s) => partlyFree(date, s)).length;
    if (!option) return { text: "", label: "ingen maskiner", state: "" };
    if (free > 0) return { text: `${free} ledige`, label: `${free} ledige tider`, state: "" };
    if (partial > 0)
      return { text: "Delvis", label: `delvis ledig, ${partial} ${partial === 1 ? "tid" : "tider"} med én maskin ledig`, state: "partial" };
    if (!open.length) return { text: "Passert", label: "ingen flere tider", state: "" };
    return { text: "Fullt", label: "fullt", state: "full" };
  };
  const mine = p.bookings.filter((b) => b.apartment === p.apartment && !slotIsOver(b.date, b.end_min, p.now));
  const justBooked = p.flash === "booked" ? mine.filter((b) => (p.bookedIds ?? "").split(",").includes(String(b.id))) : [];
  const groups = new Map<string, Booking[]>();
  for (const b of mine) {
    const key = `${b.date}|${b.start_min}|${b.end_min}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const myWaits = p.waitlist.filter((w) => w.apartment === p.apartment && !slotIsOver(w.date, w.start_min + p.tenant.slot_min, p.now));
  const machineName = (id: number) => p.machines.find((m) => m.id === id)?.name ?? "Maskin";
  const groupLabel = (bookings: Booking[]) => bookings.map((b) => machineName(b.machine_id)).join(" + ");
  /** Other households waiting for any machine in this reservation, counted once each. */
  const waiters = (bookings: Booking[]) =>
    new Set(
      p.waitlist
        .filter(
          (w) =>
            w.apartment !== p.apartment &&
            bookings.some((b) => b.machine_id === w.machine_id && b.date === w.date && b.start_min === w.start_min),
        )
        .map((w) => w.apartment),
    ).size;
  const weekIndex = p.weeks.findIndex((w) => w.includes(selected));
  const week = p.weeks[weekIndex] ?? [];
  // Opening a week selects today when it is in that week, else its first viewable day.
  const weekTarget = (w: string[]) => (w.includes(p.now.date) ? p.now.date : w.find((d) => p.days.includes(d))!);
  const prevWeek = p.weeks[weekIndex - 1];
  const nextWeek = p.weeks[weekIndex + 1];
  const duration =
    p.tenant.slot_min % 60 === 0 ? `${p.tenant.slot_min / 60} ${p.tenant.slot_min === 60 ? "time" : "timer"}` : `${p.tenant.slot_min} min`;
  const month = new Intl.DateTimeFormat("nb-NO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${selected}T12:00:00Z`));

  return (
    <Layout title={`Vaskekjeller · ${p.tenant.name}`} tenant={p.tenant} vapidKey={p.vapidKey}>
      <header class="top resident-top">
        <a class="brand" href={base} aria-label="Vaskekjeller, hjem">
          <span class="brand-icon">
            <Icon size={25} />
          </span>
          <span>
            Vaskekjeller<small>{p.tenant.name}</small>
          </span>
        </a>
        {p.apartment ? (
          <details class="apartment-menu">
            <summary class="apartment-chip" aria-label={`Leilighet ${p.apartment}, endre leilighet`}>
              <Icon name="home" size={16} />
              <span>
                Leilighet <strong>{p.apartment}</strong>
              </span>
              <span class="muted" aria-hidden="true">
                ⌄
              </span>
            </summary>
            <div class="apartment-popover">
              <section>
                <strong>Endre leilighet</strong>
                <p>Velg leiligheten du vil reservere for.</p>
                <ApartmentPicker tenant={p.tenant} apartments={p.apartments} current={p.apartment} context={query()} />
              </section>
            </div>
          </details>
        ) : (
          <span class="header-caption">Et felles rom. Litt enklere.</span>
        )}
      </header>
      <main class="resident-main">
        <div class="page-intro">
          <div>
            <p class="eyebrow">PLASS TIL HVERDAGEN</p>
            <h1>Når vil du vaske?</h1>
            <p class="intro-copy">Velg en dag. Finn en tid. Så er den din.</p>
          </div>
          <div class="opening">
            <span class="status-dot" />
            <span>
              Åpent {fmtMinute(p.tenant.day_start_min)}–{fmtMinute(p.tenant.day_end_min)}
              <small>Felles vaskerom</small>
            </span>
          </div>
        </div>
        {groups.size > 0 && (
          <a class="mobile-mine-link" href="#mine">
            <Icon name="calendar" size={17} />
            Dine tider <span>{groups.size}</span>
            <Icon name="arrow" size={16} />
          </a>
        )}
        {!p.apartment && (
          <section class="welcome" id="apartment-start">
            <div>
              <Icon name="home" />
              <h2>Hei, nabo.</h2>
              <p>Velg leiligheten din én gang, så er du klar til å reservere.</p>
            </div>
            <ApartmentPicker tenant={p.tenant} apartments={p.apartments} context={query()} />
          </section>
        )}
        <div class="booking-layout">
          <section class="schedule" aria-label="Reserver vasketid">
            <div class="schedule-toolbar">
              <h2>Finn en ledig tid</h2>
              <span class="duration">
                <Icon name="clock" size={15} />
                {duration} per tid
              </span>
            </div>
            <nav class="machine-options" aria-label="Velg maskiner">
              {options.map((o) => (
                <a href={url(selected, o.key)} aria-current={o.key === mode ? "true" : undefined} class={o.key === mode ? "selected" : ""}>
                  <MachineIcons machines={o.machines} />
                  {o.label}
                </a>
              ))}
            </nav>
            <div class="calendar-toolbar">
              <span class="month">{month}</span>
              <div class="calendar-actions">
                <a href={url(p.now.date)} class="today-link">
                  I dag
                </a>
                <a
                  class={`icon-button ${prevWeek ? "" : "disabled"}`}
                  aria-label="Forrige uke"
                  aria-disabled={prevWeek ? undefined : "true"}
                  href={prevWeek ? url(weekTarget(prevWeek)) : undefined}
                >
                  ‹
                </a>
                <a
                  class={`icon-button ${nextWeek ? "" : "disabled"}`}
                  aria-label="Neste uke"
                  aria-disabled={nextWeek ? undefined : "true"}
                  href={nextWeek ? url(weekTarget(nextWeek)) : undefined}
                >
                  ›
                </a>
              </div>
            </div>
            <nav class="date-strip" aria-label="Velg dag">
              {week.map((date) => {
                const status = dayStatus(date);
                return p.days.includes(date) ? (
                  <a
                    href={url(date)}
                    data-date={date}
                    class={`date-item ${date === selected ? "selected" : ""} ${status.state}`}
                    aria-current={date === selected ? "date" : undefined}
                    aria-label={`${dayLabel(date)}, ${fmtDay(date)}, ${status.label}`}
                  >
                    <span>{dayLabel(date)}</span>
                    <strong>{Number(date.slice(-2))}</strong>
                    <small>{status.text}</small>
                  </a>
                ) : (
                  <span
                    class="date-item unavailable"
                    data-date={date}
                    aria-disabled="true"
                    aria-label={`${fmtDay(date)}, ikke tilgjengelig`}
                  >
                    <span>{dayLabel(date)}</span>
                    <strong>{Number(date.slice(-2))}</strong>
                    <small aria-hidden="true">–</small>
                  </span>
                );
              })}
            </nav>
            <div class="day-heading">
              <h3>
                {dayLabel(selected) === "I dag" || dayLabel(selected) === "I morgen" ? `${dayLabel(selected)}, ` : ""}
                {fmtDay(selected).toLowerCase()}
              </h3>
              {past ? (
                <span>Hvem brukte maskinene</span>
              ) : (
                <span>
                  <span class="legend-dot" /> Ledig
                </span>
              )}
            </div>
            <div class="slots" id={`d-${selected}`}>
              {!option && !past && (
                <div class="empty-state">
                  <Icon />
                  <h3>Vaskerommet gjøres klart</h3>
                  <p>Ingen maskiner er lagt til ennå.</p>
                </div>
              )}
              {past &&
                pastSlots.map((s) => {
                  const usage = pastMachines.map((m) => ({
                    machine: m,
                    bookings: dayBookings.filter((b) => b.machine_id === m.id && overlaps(b, s)),
                  }));
                  const used = usage.some((u) => u.bookings.length);
                  return (
                    <article class={`time-slot elapsed past-slot ${used ? "used" : ""}`}>
                      <div class="slot-time">
                        <strong>
                          {fmtMinute(s.start)}
                          <span class="time-dash">–</span>
                          {fmtMinute(s.end)}
                        </strong>
                        <span>Passert</span>
                      </div>
                      {used ? (
                        <ul class="slot-usage" aria-label={`Hvem brukte maskinene ${fmtMinute(s.start)}–${fmtMinute(s.end)}`}>
                          {usage.map(({ machine, bookings }) => (
                            <li>
                              <span class="usage-machine">{machine.name}</span>
                              {bookings.length ? (
                                bookings.map((b) => (
                                  <span class="usage-who">
                                    <strong>
                                      Leil. {b.apartment}
                                      {b.apartment === p.apartment ? " (deg)" : ""}
                                    </strong>
                                    {b.note && <small>“{b.note}”</small>}
                                  </span>
                                ))
                              ) : (
                                <span class="usage-who idle">Ikke i bruk</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p class="slot-usage idle">Ingen brukte maskinene</p>
                      )}
                    </article>
                  );
                })}
              {option &&
                !past &&
                p.slots.map((s) => {
                  const over = slotIsOver(selected, s.end, p.now);
                  const ongoing = selected === p.now.date && s.start < p.now.minute && !over;
                  const occupied = conflicts(selected, s);
                  const own = occupied.filter((b) => b.apartment === p.apartment);
                  const other = occupied.filter((b) => b.apartment !== p.apartment);
                  const free = !occupied.length && !over;
                  const ownAll = own.length > 0 && !other.length && option.machines.every((m) => own.some((b) => b.machine_id === m.id));
                  const paired = option.machines.length > 1;
                  const partial = !over && partlyFree(selected, s);
                  const freeMachines = option.machines.filter((m) => !occupied.some((b) => b.machine_id === m.id));
                  const holder = (b: Booking) => (b.apartment === p.apartment ? "Deg" : `Leil. ${b.apartment}`);
                  const time = `${fmtDay(selected)} ${fmtMinute(s.start)}–${fmtMinute(s.end)}`;
                  const label = `${option.label}, ${time}`;
                  return (
                    <article
                      class={`time-slot ${over ? "elapsed" : free ? "available" : ownAll ? "reserved" : partial ? "partial" : "occupied"}`}
                    >
                      <div class="slot-time">
                        <strong>
                          {fmtMinute(s.start)}
                          <span class="time-dash">–</span>
                          {fmtMinute(s.end)}
                        </strong>
                        <span>{ongoing ? `Pågår · til ${fmtMinute(s.end)}` : duration}</span>
                      </div>
                      <div class="slot-status">
                        <strong>
                          {over ? (
                            "Passert"
                          ) : ownAll ? (
                            <>
                              <Icon name="check" size={16} /> Din tid
                            </>
                          ) : free ? (
                            <>
                              <span class="status-dot" />
                              {paired ? "Begge ledige" : "Ledig"}
                            </>
                          ) : partial ? (
                            <>
                              <span class="status-dot half" />
                              Delvis ledig
                            </>
                          ) : (
                            "Reservert"
                          )}
                        </strong>
                        {!over && !free && !ownAll && paired ? (
                          <small class="machine-status">
                            {option.machines.map((m) => {
                              const bookings = occupied.filter((b) => b.machine_id === m.id);
                              return (
                                <span class={bookings.length ? "" : "free"}>
                                  <Icon name={m.kind} size={14} />
                                  {KIND_SHORT[m.kind]}: {bookings.length ? [...new Set(bookings.map(holder))].join(", ") : "ledig"}
                                </span>
                              );
                            })}
                          </small>
                        ) : (
                          <small>
                            {over
                              ? ""
                              : free
                                ? option.machines.map((m) => KIND_LABEL[m.kind]).join(" + ")
                                : [...new Set(occupied.map(holder))].join(" · ")}
                          </small>
                        )}
                      </div>
                      <div class="slot-action">
                        {free &&
                          (p.apartment ? (
                            <form method="post" action={action("book")} data-reserve>
                              <Hidden
                                fields={{
                                  mode,
                                  date: selected,
                                  start: s.start,
                                }}
                              />
                              <button class="reserve-button" aria-label={`Reserver ${label}`}>
                                Reserver
                                <Icon name="arrow" size={16} />
                              </button>
                            </form>
                          ) : (
                            <a class="button secondary" href="#apartment-start">
                              Velg leilighet
                            </a>
                          ))}
                        {partial &&
                          (p.apartment ? (
                            freeMachines.map((m) => (
                              <details class="slot-details slot-confirm">
                                <summary
                                  class="reserve-button"
                                  aria-label={`Reserver ${KIND_SHORT[m.kind].toLowerCase()}, ${m.name}, ${time}`}
                                >
                                  <Icon name={m.kind} size={15} />
                                  Reserver {KIND_SHORT[m.kind].toLowerCase()}
                                </summary>
                                <div class="slot-popover">
                                  <p>
                                    Kun {KIND_DEFINITE[m.kind]} er ledig. Vil du reservere den?
                                    <small>
                                      {m.name} · {fmtMinute(s.start)}–{fmtMinute(s.end)}
                                    </small>
                                  </p>
                                  <div class="confirm-actions">
                                    <form method="post" action={action("book")} data-reserve>
                                      <Hidden fields={{ mode: String(m.id), date: selected, start: s.start }} />
                                      <button class="small-button" aria-label={`Ja, reserver ${m.name}, ${time}`}>
                                        Ja
                                      </button>
                                    </form>
                                    <a class="button secondary" href={url()} data-close>
                                      Nei
                                    </a>
                                  </div>
                                </div>
                              </details>
                            ))
                          ) : (
                            <a class="button secondary" href="#apartment-start">
                              Velg leilighet
                            </a>
                          ))}
                        {!over && ownAll && (
                          <a class="manage-link" href={`#reservation-${own[0]!.id}`}>
                            Se din tid <span aria-hidden="true">↗</span>
                          </a>
                        )}
                        {!over && occupied.length > 0 && !ownAll && (
                          <details class="slot-details">
                            <summary>
                              Se detaljer <span aria-hidden="true">⌄</span>
                            </summary>
                            <div class="slot-popover">
                              <strong>
                                {fmtMinute(s.start)}–{fmtMinute(s.end)}
                              </strong>
                              {option.machines.map((m) => {
                                const bookings = occupied.filter((b) => b.machine_id === m.id);
                                const waiting = myWaits.some(
                                  (w) => slotKey(w.machine_id, w.date, w.start_min) === slotKey(m.id, selected, s.start),
                                );
                                return (
                                  <div>
                                    <span>{m.name}</span>
                                    {bookings.length ? (
                                      bookings.map((b) => (
                                        <small>
                                          Leil. {b.apartment}
                                          {b.note ? ` · ${b.note}` : ""}
                                        </small>
                                      ))
                                    ) : (
                                      <small>Ledig</small>
                                    )}
                                    {p.apartment &&
                                      (bookings.length ? (
                                        bookings.every((b) => b.apartment === p.apartment) ? (
                                          <a href={`#reservation-${bookings[0]!.id}`}>Din reservasjon ↗</a>
                                        ) : (
                                          <form method="post" action={action(waiting ? "unwait" : "wait")}>
                                            <Hidden
                                              fields={{
                                                machine_id: m.id,
                                                date: selected,
                                                start: s.start,
                                              }}
                                            />
                                            <button class="link">{waiting ? "Forlat venteliste" : "Sett meg på venteliste"}</button>
                                          </form>
                                        )
                                      ) : (
                                        <a href={url(selected, String(m.id))}>Reserver bare denne ↗</a>
                                      ))}
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                        {over && <span class="muted">—</span>}
                      </div>
                    </article>
                  );
                })}
            </div>
            {!past && !p.hideHint && (
              <div class="schedule-note">
                <Icon name="check" size={16} />
                <span>
                  {option?.machines.length === 2 ? "Ett trykk reserverer begge maskinene." : "Ett trykk reserverer tiden."} Du kan
                  avbestille under Dine tider.
                </span>
              </div>
            )}
            {option && !past && available(selected) === 0 && (
              <p class="next-day">
                {dayStatus(selected).state === "partial"
                  ? "Ingen tider med alle maskinene ledige denne dagen."
                  : "Ingen ledige tider igjen denne dagen."}{" "}
                {p.days.find((d) => d > selected && available(d) > 0) ? (
                  <a href={url(p.days.find((d) => d > selected && available(d) > 0)!)}>Se neste ledige dag →</a>
                ) : (
                  "Prøv en annen maskin eller sett deg på venteliste."
                )}
              </p>
            )}
          </section>
          <aside class="sidebar">
            <section class="my-bookings" id="mine">
              <div class="aside-heading">
                <h2>Dine tider</h2>
                <span class="count">{groups.size}</span>
              </div>
              {!groups.size && (
                <div class="empty-bookings">
                  <span class="empty-icon">
                    <Icon name="calendar" size={27} />
                  </span>
                  <h3>En ren start</h3>
                  <p>
                    Du har ingen reservasjoner ennå.
                    <br />
                    Finn en tid som passer deg.
                  </p>
                </div>
              )}
              {[...groups.values()].map((bookings, index) => {
                const b = bookings[0]!;
                const ids = bookings.map((x) => x.id).join(",");
                const waiting = waiters(bookings);
                return (
                  <article class={`reservation-card ${index === 0 ? "next-reservation" : ""}`} id={`reservation-${b.id}`}>
                    {bookings.slice(1).map((x) => (
                      <span id={`reservation-${x.id}`} />
                    ))}
                    <div class="reservation-kicker">
                      <span>{index === 0 ? "DIN NESTE VASK" : "RESERVERT"}</span>
                      <Icon name="check" size={17} />
                    </div>
                    <h3>{dayLabel(b.date) === "I dag" || dayLabel(b.date) === "I morgen" ? dayLabel(b.date) : fmtDay(b.date, "short")}</h3>
                    <p class="reservation-time">
                      {fmtMinute(b.start_min)}–{fmtMinute(b.end_min)}
                    </p>
                    <p class="reservation-machines">{groupLabel(bookings)}</p>
                    {b.note && <p class="reservation-note">“{b.note}”</p>}
                    {waiting > 0 && (
                      <p class="reservation-waiting">
                        <span class="waiting-dot" aria-hidden="true" />
                        <span>
                          <strong>{waiting} venter på denne tiden</strong> –{" "}
                          {b.note ? "endre kommentaren" : "legg til en kommentar"} for å gi dem beskjed.
                        </span>
                      </p>
                    )}
                    <div class="reservation-actions">
                      <details>
                        <summary>{b.note ? "Endre kommentar" : "Legg til kommentar"}</summary>
                        <form method="post" action={`${base}/note${query(b.date)}`} class="note-form">
                          <Hidden fields={{ booking_ids: ids }} />
                          <label>
                            Kommentar til naboene
                            <input
                              name="note"
                              maxlength={140}
                              value={b.note ?? ""}
                              placeholder="F.eks. ferdig litt før"
                              aria-describedby={waiting > 0 ? `note-hint-${b.id}` : undefined}
                            />
                          </label>
                          {waiting > 0 && (
                            <small class="note-hint" id={`note-hint-${b.id}`}>
                              {waiting} venter – de får beskjed om kommentaren din.
                            </small>
                          )}
                          <button class="small-button">Lagre</button>
                        </form>
                      </details>
                      <form
                        method="post"
                        action={`${base}/cancel${query(b.date)}`}
                        data-confirm={`Avbestille ${groupLabel(bookings)}, ${fmtDay(b.date)} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)}?`}
                      >
                        <Hidden fields={{ booking_ids: ids }} />
                        <button class="link cancel-link">Avbestill</button>
                      </form>
                    </div>
                  </article>
                );
              })}
              {p.tenant.max_active_bookings > 0 && (
                <p class="booking-limit">
                  {groups.size} av {p.tenant.max_active_bookings} aktive tider brukt
                </p>
              )}
            </section>
            {myWaits.length > 0 && (
              <section class="waitlist-section">
                <h2>På venteliste</h2>
                {myWaits.map((w) => (
                  <div class="wait-entry">
                    <strong>
                      {fmtDay(w.date, "short")} · {fmtMinute(w.start_min)}
                    </strong>
                    <small>{machineName(w.machine_id)}</small>
                    <form method="post" action={`${base}/unwait${query(w.date)}`}>
                      <Hidden
                        fields={{
                          machine_id: w.machine_id,
                          date: w.date,
                          start: w.start_min,
                        }}
                      />
                      <button class="link">Forlat venteliste</button>
                    </form>
                  </div>
                ))}
                <div id="push-banner" class="push-banner" hidden>
                  <span id="push-text">Få varsel når en tid du venter på blir ledig eller får en ny kommentar.</span>
                  <button type="button" id="push-toggle">
                    Slå på varsler
                  </button>
                </div>
                <p class="muted">Ventelisten reserverer ikke automatisk. Først til mølla når tiden blir ledig.</p>
              </section>
            )}
            <section class="good-neighbor">
              <span class="neighbor-symbol" aria-hidden="true">
                ✳
              </span>
              <h3>Litt omtanke. God flyt.</h3>
              <p>Ferdig før tiden? Legg til en kommentar. Endrede planer? Frigi tiden til en nabo.</p>
              <div class="room-hours">
                <Icon name="clock" size={16} />
                <span>
                  {fmtMinute(p.tenant.day_start_min)}–{fmtMinute(p.tenant.day_end_min)} hver dag
                </span>
              </div>
            </section>
          </aside>
        </div>
      </main>
      <Toaster code={p.flash} dismissHref={url()}>
        {justBooked.length > 0 && (
          <Toast
            tone="success"
            long
            dismissHref={url()}
            action={
              <form method="post" action={action("cancel")} class="toast-action">
                <Hidden fields={{ booking_ids: justBooked.map((b) => b.id).join(",") }} />
                <button class="toast-button">Angre</button>
              </form>
            }
          >
            <p class="toast-title">Tiden er din!</p>
            <p class="toast-detail">
              {fmtDay(justBooked[0]!.date, "short")} · {fmtMinute(justBooked[0]!.start_min)}–{fmtMinute(justBooked[0]!.end_min)} ·{" "}
              {groupLabel(justBooked)}
            </p>
          </Toast>
        )}
      </Toaster>
      <footer class="foot resident-foot">
        <span>Felles vaskerom, færre løse tråder.</span>
        <a href={`${base}/admin`}>
          Administrasjon <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </Layout>
  );
};
