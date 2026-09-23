import type { Child, FC } from "hono/jsx";
import { KIND_LABEL, normalizeApartment, type Booking, type Machine, type Tenant } from "./db.ts";
import { fmtDay, fmtMinute, slotsFor } from "./time.ts";
import { FLASH, Icon, Layout, Toast, Toaster } from "./views.tsx";

export type Stats = {
  daily: { day: string; views: number; visitors: number; notifications: number }[];
  bookings30: number;
  cancelled30: number;
  apartments30: number;
  utilization30: number | null;
  heat: { weekday: number; start_min: number; n: number }[];
  pushDevices: number;
  waiting: number;
};

const ADMIN_FLASH: Record<string, string> = {
  ...FLASH,
  "machine-added": "Maskinen er lagt til.",
  "machine-saved": "Maskinen er lagret.",
  "machine-on": "Maskinen kan bookes igjen.",
  "machine-off": "Maskinen er slått av. Eksisterende bookinger beholdes.",
  "access-on": "Beboerpassord er slått på.",
  "access-changed": "Beboerpassordet er endret. Beboere må logge inn på nytt.",
  "access-off": "Beboerpassord er slått av. Alle med lenken kan se bookingsiden.",
  "admin-password": "Adminpassordet er byttet.",
};

/** Slot lengths offered in the schedule picker, in minutes. */
export const SLOT_LENGTHS = [30, 60, 90, 120, 180];

export const slotLengthLabel = (min: number) =>
  min % 60 === 0 ? `${min / 60} t` : min > 60 && min % 30 === 0 ? `${String(min / 60).replace(".", ",")} t` : `${min} min`;

// Keep in sync with schedulePreview in client/admin.ts, which updates it while the admin types.
const hour = (min: number) => (min % 60 === 0 ? String(min / 60).padStart(2, "0") : fmtMinute(min));

export function schedulePreview(start: number | null, end: number | null, slot: number): string {
  if (start === null || end === null || start >= end) return "Velg når første tid starter og siste tid slutter.";
  if (!Number.isInteger(slot) || slot < 1) return "Velg en lengde per tid.";
  const slots = slotsFor({ day_start_min: start, day_end_min: end, slot_min: slot });
  if (!slots.length) return "Ingen tider får plass. Velg en kortere lengde eller lengre åpningstid.";
  const shown = slots.length > 6 ? [...slots.slice(0, 5), null, slots.at(-1)!] : slots;
  const list = shown.map((s) => (s ? `${hour(s.start)}–${hour(s.end)}` : "…")).join(", ");
  const rest = end - slots.at(-1)!.end;
  return `${slots.length} ${slots.length === 1 ? "tid" : "tider"} per dag: ${list}.${rest ? ` De siste ${rest} min før ${fmtMinute(end)} blir ikke brukt.` : ""}`;
}

/** Normalized apartment list with duplicates listed once each. Keep in sync with client/admin.ts. */
export function apartmentSummary(text: string) {
  const all = text.split(/[\n,]/).map(normalizeApartment).filter(Boolean);
  const unique = [...new Set(all)];
  const duplicates = unique.filter((a) => all.indexOf(a) !== all.lastIndexOf(a));
  return { unique, duplicates };
}

const apartmentCount = (n: number) => (n === 0 ? "Ingen liste – alle numre er tillatt" : `${n} ${n === 1 ? "leilighet" : "leiligheter"}`);

type IconName = "up" | "down" | "plus" | "copy" | "key" | "shield" | "close" | "external";

const AdminIcon: FC<{ name: IconName; size?: number }> = ({ name, size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {name === "up" ? (
      <path d="m6 15 6-6 6 6" />
    ) : name === "down" ? (
      <path d="m6 9 6 6 6-6" />
    ) : name === "plus" ? (
      <path d="M12 5v14M5 12h14" />
    ) : name === "copy" ? (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h8" />
      </>
    ) : name === "key" ? (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 8-8m-3 3 2 2m-4 0 2 2" />
      </>
    ) : name === "shield" ? (
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" />
    ) : name === "close" ? (
      <path d="M6 6l12 12M18 6 6 18" />
    ) : (
      <path d="M8 16 16 8m-7 0h7v7" />
    )}
  </svg>
);

const AdminPage: FC<{
  tenant: Tenant;
  title: string;
  active: "overview" | "settings";
  flash?: string;
  /** Error toast shown instead of the flash message, e.g. after a failed validation. */
  alert?: Child;
  children: Child;
}> = (p) => {
  const base = `/${p.tenant.slug}`;
  const message = p.flash && ADMIN_FLASH[p.flash];
  const here = p.active === "overview" ? `${base}/admin` : `${base}/admin/settings`;
  return (
    <Layout
      title={`${p.title} · ${p.tenant.name}`}
      tenant={p.tenant}
      head={
        <>
          <link rel="stylesheet" href="/admin.css" />
          <script type="module" src="/admin.js" defer></script>
        </>
      }
    >
      <header class="top resident-top admin-top">
        <a class="brand" href={`${base}/admin`} aria-label="Vaskekjeller administrasjon">
          <span class="brand-icon">
            <Icon size={25} />
          </span>
          <span>
            Vaskekjeller<small>Admin · {p.tenant.name}</small>
          </span>
        </a>
        <div class="admin-top-actions">
          <a class="header-link" href={base}>
            Bookingsiden <AdminIcon name="external" size={15} />
          </a>
          <form method="post" action={`${base}/admin/logout`}>
            <button class="header-link">Logg ut</button>
          </form>
        </div>
      </header>
      <main class="admin-main">
        <div class="page-intro admin-intro">
          <div>
            <p class="eyebrow">ADMINISTRASJON</p>
            <h1>{p.title}</h1>
          </div>
          <nav class="admin-tabs" aria-label="Administrasjon">
            <a href={`${base}/admin`} aria-current={p.active === "overview" ? "page" : undefined}>
              Oversikt
            </a>
            <a href={`${base}/admin/settings`} aria-current={p.active === "settings" ? "page" : undefined}>
              Innstillinger
            </a>
          </nav>
        </div>
        {p.children}
      </main>
      <Toaster dismissHref={here}>
        {p.alert ? (
          <Toast tone="error" dismissHref={here}>
            {p.alert}
          </Toast>
        ) : (
          message && (
            <Toast tone={p.flash === "wrong-password" ? "error" : "success"} dismissHref={here}>
              <p class="toast-title">{message}</p>
            </Toast>
          )
        )}
      </Toaster>
    </Layout>
  );
};

const WEEKDAYS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];

export const AdminOverview: FC<{ tenant: Tenant; stats: Stats; upcoming: (Booking & { machine: string })[]; flash?: string }> = ({
  tenant,
  stats,
  upcoming,
  flash,
}) => {
  const maxViews = Math.max(1, ...stats.daily.map((d) => d.views));
  const starts = [...new Set(stats.heat.map((h) => h.start_min))].sort((a, b) => a - b);
  const maxHeat = Math.max(1, ...stats.heat.map((h) => h.n));
  const heatAt = (wd: number, s: number) => stats.heat.find((h) => h.weekday === wd && h.start_min === s)?.n ?? 0;
  const totals = stats.daily.reduce(
    (a, d) => ({ views: a.views + d.views, visitors: a.visitors + d.visitors, notif: a.notif + d.notifications }),
    {
      views: 0,
      visitors: 0,
      notif: 0,
    },
  );
  const kpis: [string | number, string][] = [
    [stats.bookings30, "bookinger"],
    [stats.cancelled30, "avbestillinger"],
    [stats.apartments30, "leiligheter har booket"],
    [stats.utilization30 === null ? "–" : `${Math.round(stats.utilization30 * 100)} %`, "utnyttelse"],
    [totals.visitors, "besøkende (unike per dag)"],
    [totals.notif, "venteliste-varsler sendt"],
    [stats.pushDevices, "enheter med varsler"],
    [stats.waiting, "på venteliste nå"],
  ];

  return (
    <AdminPage tenant={tenant} title="Oversikt" active="overview" flash={flash}>
      <div class="admin-stack">
        <section class="card" aria-labelledby="siste-30">
          <div class="card-head">
            <h2 id="siste-30">Siste 30 dager</h2>
          </div>
          <div class="kpis">
            {kpis.map(([value, label]) => (
              <div>
                <strong>{value}</strong>
                {label}
              </div>
            ))}
          </div>
          <h3 class="card-subhead">Sidevisninger per dag</h3>
          <div class="bars" role="img" aria-label="Sidevisninger per dag, siste 30 dager">
            {stats.daily.map((d) => (
              <div
                class="bar"
                style={`height:${(d.views / maxViews) * 100}%`}
                title={`${d.day}: ${d.views} visninger, ${d.visitors} besøkende`}
              />
            ))}
          </div>
          <p class="hint">
            Ingen cookies eller IP-adresser lagres for statistikk – kun daglige totaler. Unike besøkende telles med en hash som roteres hver
            dag.
          </p>
        </section>

        <section class="card" aria-labelledby="populaere">
          <div class="card-head">
            <h2 id="populaere">Populære tider</h2>
            <p>Bookinger de siste 90 dagene, per ukedag og starttid.</p>
          </div>
          {starts.length === 0 ? (
            <p class="empty-note">Ingen data ennå.</p>
          ) : (
            <div class="table-wrap">
              <table class="heat">
                <thead>
                  <tr>
                    <th></th>
                    {WEEKDAYS.map((w) => (
                      <th>{w}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {starts.map((s) => (
                    <tr>
                      <th>{fmtMinute(s)}</th>
                      {WEEKDAYS.map((_, wd) => {
                        const n = heatAt(wd, s);
                        return (
                          <td style={`--a:${n / maxHeat}`} title={`${n} bookinger`}>
                            {n || ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section class="card" aria-labelledby="kommende">
          <div class="card-head">
            <h2 id="kommende">Kommende bookinger</h2>
            <span class="count">{upcoming.length}</span>
          </div>
          {upcoming.length === 0 ? (
            <p class="empty-note">Ingen kommende bookinger.</p>
          ) : (
            <ul class="upcoming">
              {upcoming.map((b) => (
                <li>
                  <span class="upcoming-when">
                    <strong>{fmtDay(b.date, "short")}</strong>
                    {fmtMinute(b.start_min)}–{fmtMinute(b.end_min)}
                  </span>
                  <span class="upcoming-what">
                    <strong>Leil. {b.apartment}</strong>
                    {b.machine}
                    {b.note && <em>“{b.note}”</em>}
                  </span>
                  <form
                    method="post"
                    action={`/${tenant.slug}/admin/bookings/${b.id}/cancel`}
                    data-confirm={`Avbestille bookingen til ${b.apartment}?`}
                  >
                    <button class="text-button danger">Avbestill</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminPage>
  );
};

/** A dialog that is a centered modal on desktop and a bottom drawer on phones.
 * Without JavaScript the trigger links to `#id`, and CSS shows the dialog as its `:target`.
 * `closeTo` is the settings page URL, not just a `#section`, so a dialog the server reopened
 * after a validation error (`open`, at the POST URL) also closes without JavaScript. */
const Sheet: FC<{ id: string; title: string; closeTo: string; open?: boolean; children: Child }> = (p) => (
  <dialog id={p.id} class="sheet" aria-labelledby={`${p.id}-title`} open={p.open} data-autoshow={p.open ? "" : undefined} closedby="any">
    <div class="sheet-panel">
      <div class="sheet-handle" aria-hidden="true" />
      <div class="sheet-head">
        <h2 id={`${p.id}-title`}>{p.title}</h2>
        <a href={p.closeTo} class="sheet-close" data-dialog-close aria-label="Lukk">
          <AdminIcon name="close" />
        </a>
      </div>
      {p.children}
    </div>
  </dialog>
);

const FieldError: FC<{ id: string; error?: string }> = ({ id, error }) =>
  error ? (
    <p class="field-error" id={`${id}-error`}>
      {error}
    </p>
  ) : null;

/** Accessibility attributes that tie an input to its hint and inline error. */
const described = (id: string, error?: string, hint = false) => ({
  id,
  "aria-invalid": error ? "true" : undefined,
  "aria-describedby": [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined,
});

export const SECTIONS = [
  ["generelt", "Generelt"],
  ["tider", "Tider og regler"],
  ["leiligheter", "Leiligheter"],
  ["maskiner", "Maskiner"],
  ["tilgang", "Tilgang"],
] as const;

export type SettingsState = {
  /** Validation messages keyed by field name. */
  errors?: Record<string, string>;
  /** Submitted values to show again after a validation error. */
  values?: Record<string, string>;
  /** Dialog to reopen, e.g. after a validation error inside it. */
  dialog?: string;
  /** Anchor of the card whose form failed validation. */
  card?: string;
};

export const AdminSettings: FC<
  { tenant: Tenant; machines: Machine[]; residentPassword: string | null; flash?: string } & SettingsState
> = ({ tenant, machines, residentPassword, flash, errors = {}, values = {}, dialog, card }) => {
  const base = `/${tenant.slug}/admin`;
  const back = (section: string) => `${base}/settings#${section}`;
  const v = (name: string, fallback: string) => values[name] ?? fallback;
  const slot = Number(v("slot_min", String(tenant.slot_min)));
  const apartmentsText = v("apartments", tenant.apartments ?? "");
  const apartments = apartmentSummary(apartmentsText);
  const passwordOn = !!tenant.access_password_hash;
  const kinds = Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[];
  const parse = (hhmm: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const dayStart = v("day_start", fmtMinute(tenant.day_start_min));
  const dayEnd = v("day_end", fmtMinute(tenant.day_end_min));

  return (
    <AdminPage
      tenant={tenant}
      title="Innstillinger"
      active="settings"
      flash={flash}
      alert={
        Object.keys(errors).length > 0 && (
          <>
            <p class="toast-title">Noe må rettes før det kan lagres.</p>
            <p class="toast-detail">
              {card ? <a href={`#${card}`}>Gå til feltet som er markert.</a> : "Se feltet som er markert."}
            </p>
          </>
        )
      }
    >
      <div class="settings-layout">
        <nav class="toc" aria-label="Innstillinger">
          <p class="toc-title">På denne siden</p>
          <ul>
            {SECTIONS.map(([id, label]) => (
              <li>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div class="admin-stack">
          <section class="card" id="generelt" aria-labelledby="generelt-title">
            <div class="card-head">
              <h2 id="generelt-title">Generelt</h2>
              <p>Navnet beboerne ser øverst på bookingsiden.</p>
            </div>
            <form method="post" action={`${base}/settings`} class="card-form">
              <input type="hidden" name="section" value="generelt" />
              <div class="field">
                <label for="name">Navn på borettslag eller bygg</label>
                <input name="name" required maxlength={80} value={v("name", tenant.name)} {...described("name", errors.name)} />
                <FieldError id="name" error={errors.name} />
              </div>
              <div class="card-foot">
                <button>Lagre</button>
              </div>
            </form>
          </section>

          <section class="card" id="tider" aria-labelledby="tider-title">
            <div class="card-head">
              <h2 id="tider-title">Tider og regler</h2>
              <p>Hvordan dagen deles opp, og hvor mye hver leilighet kan booke.</p>
            </div>
            <form method="post" action={`${base}/settings`} class="card-form" data-schedule>
              <input type="hidden" name="section" value="tider" />
              <div class="field-row">
                <div class="field">
                  <label for="day_start">Første tid starter</label>
                  <input name="day_start" type="time" required value={dayStart} {...described("day_start", errors.day_start)} />
                  <FieldError id="day_start" error={errors.day_start} />
                </div>
                <div class="field">
                  <label for="day_end">Siste tid slutter</label>
                  <input name="day_end" type="time" required value={dayEnd} {...described("day_end", errors.day_end)} />
                  <FieldError id="day_end" error={errors.day_end} />
                </div>
              </div>
              <fieldset class="field" aria-describedby={["slot-preview", errors.slot_min && "slot_min-error"].filter(Boolean).join(" ")}>
                <legend>Lengde per tid</legend>
                <div class="segmented">
                  {SLOT_LENGTHS.map((m) => (
                    <label>
                      <input
                        type="radio"
                        name="slot_min"
                        value={m}
                        checked={m === slot}
                        required
                        aria-invalid={errors.slot_min ? "true" : undefined}
                      />
                      <span>{slotLengthLabel(m)}</span>
                    </label>
                  ))}
                </div>
                <p class="slot-preview" id="slot-preview" aria-live="polite">
                  {schedulePreview(parse(dayStart), parse(dayEnd), slot)}
                </p>
                <FieldError id="slot_min" error={errors.slot_min} />
              </fieldset>
              <div class="field-row">
                <div class="field">
                  <label for="horizon">Kan booke dager frem</label>
                  <input
                    name="horizon"
                    type="number"
                    inputmode="numeric"
                    min={1}
                    max={90}
                    required
                    value={v("horizon", String(tenant.booking_horizon_days))}
                    {...described("horizon", errors.horizon)}
                  />
                  <FieldError id="horizon" error={errors.horizon} />
                </div>
                <div class="field">
                  <label for="max_active">Maks aktive tider per leilighet</label>
                  <input
                    name="max_active"
                    type="number"
                    inputmode="numeric"
                    min={0}
                    max={100}
                    required
                    value={v("max_active", String(tenant.max_active_bookings))}
                    {...described("max_active", errors.max_active, true)}
                  />
                  <p class="field-hint" id="max_active-hint">
                    0 betyr ubegrenset.
                  </p>
                  <FieldError id="max_active" error={errors.max_active} />
                </div>
              </div>
              <div class="card-foot">
                <p class="hint">Eksisterende bookinger beholder tidene sine, men vises bare hvis de passer med de nye tidene.</p>
                <button>Lagre</button>
              </div>
            </form>
          </section>

          <section class="card" id="leiligheter" aria-labelledby="leiligheter-title">
            <div class="card-head">
              <h2 id="leiligheter-title">Leiligheter</h2>
              <p>Beboere velger fra denne listen. Er den tom, kan de skrive inn hvilket nummer som helst.</p>
            </div>
            <form method="post" action={`${base}/settings`} class="card-form" data-apartments>
              <input type="hidden" name="section" value="leiligheter" />
              <div class="field">
                <label for="apartments">Leilighetsnumre, ett per linje</label>
                <textarea name="apartments" rows={8} spellcheck={false} {...described("apartments", errors.apartments, true)}>
                  {apartmentsText}
                </textarea>
                <p class="field-hint apartment-summary" id="apartments-hint" aria-live="polite">
                  <strong data-apartment-count>{apartmentCount(apartments.unique.length)}</strong>
                  <span class="warn" data-apartment-duplicates hidden={!apartments.duplicates.length}>
                    {apartments.duplicates.length > 0 && `Duplikater: ${apartments.duplicates.join(", ")}. De slås sammen når du lagrer.`}
                  </span>
                </p>
                <FieldError id="apartments" error={errors.apartments} />
              </div>
              <div class="card-foot">
                <button>Lagre</button>
              </div>
            </form>
          </section>

          <section class="card" id="maskiner" aria-labelledby="maskiner-title">
            <div class="card-head">
              <h2 id="maskiner-title">Maskiner</h2>
              <p>Rekkefølgen her er rekkefølgen beboerne ser. Trykk på et navn for å endre det.</p>
            </div>
            {machines.length === 0 ? (
              <p class="empty-note">Ingen maskiner ennå. Legg til den første.</p>
            ) : (
              <ul class="machine-list">
                {machines.map((m, i) => {
                  const error = errors[`machine-${m.id}`];
                  return (
                    <li class={`machine-row ${m.active ? "" : "inactive"}`} id={`maskin-${m.id}`}>
                      <form id={`machine-${m.id}`} method="post" action={`${base}/machines/${m.id}`} data-autosave />
                      <div class="machine-order">
                        <form method="post" action={`${base}/machines/${m.id}/move`} data-inline>
                          <input type="hidden" name="dir" value="up" />
                          <button class="icon-btn" aria-label={`Flytt ${m.name} opp`} disabled={i === 0} data-focus-key={`up-${m.id}`}>
                            <AdminIcon name="up" />
                          </button>
                        </form>
                        <form method="post" action={`${base}/machines/${m.id}/move`} data-inline>
                          <input type="hidden" name="dir" value="down" />
                          <button
                            class="icon-btn"
                            aria-label={`Flytt ${m.name} ned`}
                            disabled={i === machines.length - 1}
                            data-focus-key={`down-${m.id}`}
                          >
                            <AdminIcon name="down" />
                          </button>
                        </form>
                      </div>
                      <div class="machine-fields">
                        <input
                          form={`machine-${m.id}`}
                          name="name"
                          value={values.machine_id === String(m.id) ? v("machine_name", m.name) : m.name}
                          required
                          maxlength={60}
                          class="inline-input"
                          aria-label="Navn"
                          data-focus-key={`name-${m.id}`}
                          {...(error ? { "aria-invalid": "true", "aria-describedby": `machine-${m.id}-error` } : {})}
                        />
                        <select
                          form={`machine-${m.id}`}
                          name="kind"
                          class="inline-select"
                          aria-label={`Type for ${m.name}`}
                          data-focus-key={`kind-${m.id}`}
                        >
                          {kinds.map((k) => (
                            <option value={k} selected={k === m.kind}>
                              {KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        <noscript>
                          <button form={`machine-${m.id}`} class="small-button secondary">
                            Lagre
                          </button>
                        </noscript>
                        <FieldError id={`machine-${m.id}`} error={error} />
                      </div>
                      <form method="post" action={`${base}/machines/${m.id}/active`} data-inline class="machine-switch">
                        <input type="hidden" name="active" value={m.active ? "0" : "1"} />
                        <button
                          class="switch"
                          role="switch"
                          aria-checked={m.active ? "true" : "false"}
                          aria-label={`${m.name} kan bookes`}
                          data-focus-key={`active-${m.id}`}
                        >
                          <span class="switch-thumb" />
                        </button>
                        <span class="switch-label" aria-hidden="true">
                          {m.active ? "På" : "Av"}
                        </span>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
            <div class="card-foot">
              <p class="hint">Slå av en maskin i stedet for å slette den, så beholdes historikken.</p>
              <a href="#legg-til-maskin" class="button secondary" data-dialog="legg-til-maskin">
                <AdminIcon name="plus" size={16} />
                Legg til maskin
              </a>
            </div>
          </section>

          <section class="card" id="tilgang" aria-labelledby="tilgang-title">
            <div class="card-head">
              <h2 id="tilgang-title">Tilgang</h2>
              <p>Hvem som kan se bookingsiden og administrere den.</p>
            </div>
            <div class="setting-row">
              <span class="setting-icon">
                <AdminIcon name="key" />
              </span>
              <div class="setting-text">
                <h3 id="beboerpassord-label">Beboerpassord</h3>
                <p>
                  {passwordOn
                    ? "På. Beboere skriver inn en felles kode én gang per enhet."
                    : "Av. Alle med lenken kan se og bruke bookingsiden."}
                </p>
              </div>
              <a
                href={passwordOn ? "#slaa-av-beboerpassord" : "#beboerpassord"}
                data-dialog={passwordOn ? "slaa-av-beboerpassord" : "beboerpassord"}
                class="switch"
                role="switch"
                aria-checked={passwordOn ? "true" : "false"}
                aria-labelledby="beboerpassord-label"
                aria-haspopup="dialog"
              >
                <span class="switch-thumb" />
              </a>
            </div>
            {passwordOn &&
              (residentPassword !== null ? (
                <div class="secret">
                  <input type="checkbox" id="vis-beboerpassord" class="secret-toggle sr-only" />
                  <code class="secret-value">
                    <span class="secret-masked">
                      <span aria-hidden="true">••••••••</span>
                      <span class="sr-only">Skjult</span>
                    </span>
                    <span class="secret-plain">{residentPassword}</span>
                  </code>
                  <div class="secret-actions">
                    <label for="vis-beboerpassord" class="text-button">
                      <span class="secret-show">Vis</span>
                      <span class="secret-hide">Skjul</span>
                      <span class="sr-only"> beboerpassord</span>
                    </label>
                    <button type="button" class="text-button" data-copy hidden>
                      <AdminIcon name="copy" size={15} />
                      <span data-copy-label>Kopier</span>
                    </button>
                    <a href="#beboerpassord" data-dialog="beboerpassord" class="text-button">
                      Endre
                    </a>
                  </div>
                </div>
              ) : (
                <div class="secret notice">
                  <p>
                    Passordet ble satt før det kunne vises her. <strong>Sett et nytt passord for å kunne vise det.</strong>
                  </p>
                  <a href="#beboerpassord" data-dialog="beboerpassord" class="text-button">
                    Sett nytt passord
                  </a>
                </div>
              ))}
            <div class="setting-row">
              <span class="setting-icon">
                <AdminIcon name="shield" />
              </span>
              <div class="setting-text">
                <h3>Adminpassord</h3>
                <p>Brukes for å logge inn her. Det lagres som en enveis-hash og kan aldri vises.</p>
              </div>
              <a href="#adminpassord" data-dialog="adminpassord" class="button secondary small">
                Bytt
              </a>
            </div>
          </section>
          {/* Later sections (audit log, danger zone) go here and in SECTIONS. */}
        </div>
      </div>

      <Sheet id="legg-til-maskin" title="Legg til maskin" closeTo={back("maskiner")} open={dialog === "legg-til-maskin"}>
        <form method="post" action={`${base}/machines`} class="sheet-form">
          <div class="field">
            <label for="new-machine-name">Navn</label>
            <input
              name="name"
              required
              maxlength={60}
              placeholder="F.eks. Vaskemaskin 2"
              value={dialog === "legg-til-maskin" ? v("machine_name", "") : ""}
              {...described("new-machine-name", errors.new_machine)}
            />
            <FieldError id="new-machine-name" error={errors.new_machine} />
          </div>
          <fieldset class="field">
            <legend>Type</legend>
            <div class="segmented">
              {kinds.map((k, i) => (
                <label>
                  <input
                    type="radio"
                    name="kind"
                    value={k}
                    checked={dialog === "legg-til-maskin" && values.machine_kind ? values.machine_kind === k : i === 0}
                  />
                  <span>{KIND_LABEL[k]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div class="sheet-actions">
            <a href={back("maskiner")} class="button ghost" data-dialog-close>
              Avbryt
            </a>
            <button>Legg til</button>
          </div>
        </form>
      </Sheet>

      <Sheet
        id="beboerpassord"
        title={passwordOn ? "Endre beboerpassord" : "Slå på beboerpassord"}
        closeTo={back("tilgang")}
        open={dialog === "beboerpassord"}
      >
        <form method="post" action={`${base}/access`} class="sheet-form">
          <div class="field">
            <label for="access_password">{passwordOn ? "Nytt beboerpassord" : "Beboerpassord"}</label>
            <input
              name="access_password"
              type="text"
              required
              maxlength={100}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              {...described("access_password", errors.access_password, true)}
            />
            <p class="field-hint" id="access_password-hint">
              {passwordOn
                ? "Alle beboere må skrive inn det nye passordet neste gang de åpner bookingsiden."
                : "En felles kode, som en dørkode. Du kan alltid se den igjen her."}
            </p>
            <FieldError id="access_password" error={errors.access_password} />
          </div>
          <div class="sheet-actions">
            <a href={back("tilgang")} class="button ghost" data-dialog-close>
              Avbryt
            </a>
            <button>{passwordOn ? "Lagre passord" : "Slå på"}</button>
          </div>
        </form>
      </Sheet>

      {passwordOn && (
        <Sheet id="slaa-av-beboerpassord" title="Slå av beboerpassord?" closeTo={back("tilgang")}>
          <p class="sheet-copy">Alle med lenken kan da se bookingsiden og reservere tider.</p>
          <form method="post" action={`${base}/access/off`} class="sheet-actions">
            <a href={back("tilgang")} class="button ghost" data-dialog-close>
              Avbryt
            </a>
            <button class="danger">Slå av</button>
          </form>
        </Sheet>
      )}

      <Sheet id="adminpassord" title="Bytt adminpassord" closeTo={back("tilgang")} open={dialog === "adminpassord"}>
        <form method="post" action={`${base}/admin-password`} class="sheet-form">
          <input type="text" name="username" autocomplete="username" value={`${tenant.slug}-admin`} hidden />
          <div class="field">
            <label for="admin_password">Nytt adminpassord</label>
            <input
              name="admin_password"
              type="password"
              minlength={8}
              required
              autocomplete="new-password"
              {...described("admin_password", errors.admin_password, true)}
            />
            <p class="field-hint" id="admin_password-hint">
              Minst 8 tegn. Andre som er logget inn som admin blir logget ut.
            </p>
            <FieldError id="admin_password" error={errors.admin_password} />
          </div>
          <div class="field">
            <label for="admin_password_confirm">Gjenta passordet</label>
            <input
              name="admin_password_confirm"
              type="password"
              minlength={8}
              required
              autocomplete="new-password"
              {...described("admin_password_confirm", errors.admin_password_confirm)}
            />
            <FieldError id="admin_password_confirm" error={errors.admin_password_confirm} />
          </div>
          <div class="sheet-actions">
            <a href={back("tilgang")} class="button ghost" data-dialog-close>
              Avbryt
            </a>
            <button>Bytt passord</button>
          </div>
        </form>
      </Sheet>
    </AdminPage>
  );
};
