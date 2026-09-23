import type { FC } from "hono/jsx";
import { KIND_LABEL, type Booking, type Machine, type Tenant } from "./db.ts";
import { fmtDay, fmtMinute } from "./time.ts";
import { FLASH, Layout } from "./views.tsx";

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

const Nav: FC<{ tenant: Tenant; active: "overview" | "settings" }> = ({ tenant, active }) => (
  <nav class="admin-nav">
    <a href={`/${tenant.slug}/admin`} class={active === "overview" ? "active" : ""}>
      Oversikt
    </a>
    <a href={`/${tenant.slug}/admin/settings`} class={active === "settings" ? "active" : ""}>
      Innstillinger
    </a>
    <a href={`/${tenant.slug}`}>Til bookingsiden</a>
    <form method="post" action={`/${tenant.slug}/admin/logout`}>
      <button class="link">Logg ut</button>
    </form>
  </nav>
);

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
  const totals = stats.daily.reduce((a, d) => ({ views: a.views + d.views, visitors: a.visitors + d.visitors, notif: a.notif + d.notifications }), {
    views: 0,
    visitors: 0,
    notif: 0,
  });

  return (
    <Layout title={`Admin – ${tenant.name}`} tenant={tenant}>
      <main>
        <h1>Admin · {tenant.name}</h1>
        <Nav tenant={tenant} active="overview" />
        {flash && FLASH[flash] && <p class="flash">{FLASH[flash]}</p>}

        <section>
          <h2>Siste 30 dager</h2>
          <div class="kpis">
            <div>
              <strong>{stats.bookings30}</strong>bookinger
            </div>
            <div>
              <strong>{stats.cancelled30}</strong>avbestillinger
            </div>
            <div>
              <strong>{stats.apartments30}</strong>leiligheter har booket
            </div>
            <div>
              <strong>{stats.utilization30 === null ? "–" : `${Math.round(stats.utilization30 * 100)} %`}</strong>utnyttelse
            </div>
            <div>
              <strong>{totals.visitors}</strong>besøkende (unike per dag)
            </div>
            <div>
              <strong>{totals.notif}</strong>venteliste-varsler sendt
            </div>
            <div>
              <strong>{stats.pushDevices}</strong>enheter med varsler
            </div>
            <div>
              <strong>{stats.waiting}</strong>på venteliste nå
            </div>
          </div>

          <h3>Sidevisninger per dag</h3>
          <div class="bars" role="img" aria-label="Sidevisninger per dag, siste 30 dager">
            {stats.daily.map((d) => (
              <div class="bar" style={`height:${(d.views / maxViews) * 100}%`} title={`${d.day}: ${d.views} visninger, ${d.visitors} besøkende`} />
            ))}
          </div>
          <p class="muted">
            Ingen cookies eller IP-adresser lagres for statistikk – kun daglige totaler. Unike besøkende telles med en hash som roteres hver dag.
          </p>

          <h3>Populære tider (siste 90 dager)</h3>
          {starts.length === 0 ? (
            <p class="muted">Ingen data ennå.</p>
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

        <section>
          <h2>Kommende bookinger</h2>
          {upcoming.length === 0 ? (
            <p class="muted">Ingen.</p>
          ) : (
            <div class="table-wrap">
              <table class="list">
                <thead>
                  <tr>
                    <th>Når</th>
                    <th>Maskin</th>
                    <th>Leilighet</th>
                    <th>Kommentar</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((b) => (
                    <tr>
                      <td>
                        {fmtDay(b.date, "short")} {fmtMinute(b.start_min)}–{fmtMinute(b.end_min)}
                      </td>
                      <td>{b.machine}</td>
                      <td>{b.apartment}</td>
                      <td>{b.note}</td>
                      <td>
                        <form method="post" action={`/${tenant.slug}/admin/bookings/${b.id}/cancel`} data-confirm={`Avbestille bookingen til ${b.apartment}?`}>
                          <button class="link">Avbestill</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </Layout>
  );
};

export const AdminSettings: FC<{ tenant: Tenant; machines: Machine[]; flash?: string; error?: string }> = ({ tenant, machines, flash, error }) => {
  const base = `/${tenant.slug}/admin`;
  return (
    <Layout title={`Innstillinger – ${tenant.name}`} tenant={tenant}>
      <main>
        <h1>Admin · {tenant.name}</h1>
        <Nav tenant={tenant} active="settings" />
        {flash && FLASH[flash] && <p class="flash">{FLASH[flash]}</p>}
        {error && <p class="flash err">{error}</p>}

        <section>
          <h2>Tider og regler</h2>
          <form method="post" action={`${base}/settings`} class="stack">
            <label>
              Navn
              <input name="name" required value={tenant.name} />
            </label>
            <div class="row">
              <label>
                Første tid starter
                <input name="day_start" type="time" required value={fmtMinute(tenant.day_start_min)} />
              </label>
              <label>
                Siste tid slutter
                <input name="day_end" type="time" required value={fmtMinute(tenant.day_end_min)} />
              </label>
              <label>
                Lengde per tid (minutter)
                <input name="slot_min" type="number" min={15} max={720} step={15} required value={tenant.slot_min} />
              </label>
            </div>
            <div class="row">
              <label>
                Kan booke så mange dager frem
                <input name="horizon" type="number" min={1} max={90} required value={tenant.booking_horizon_days} />
              </label>
              <label>
                Maks aktive bookinger per leilighet (0 = ubegrenset)
                <input name="max_active" type="number" min={0} max={100} required value={tenant.max_active_bookings} />
              </label>
            </div>
            <label>
              Gyldige leilighetsnumre (ett per linje, tomt = alle tillatt)
              <textarea name="apartments" rows={5}>
                {tenant.apartments ?? ""}
              </textarea>
            </label>
            <p class="muted">Eksisterende bookinger beholder tidene sine hvis du endrer oppsettet, men vises bare i oversikten hvis de passer med de nye tidene.</p>
            <button>Lagre</button>
          </form>
        </section>

        <section>
          <h2>Maskiner</h2>
          <div class="table-wrap">
            <table class="list">
              <thead>
                <tr>
                  <th>Navn</th>
                  <th>Type</th>
                  <th>Rekkefølge</th>
                  <th>Aktiv</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr>
                    <td>
                      <input form={`m${m.id}`} name="name" value={m.name} required />
                    </td>
                    <td>
                      <select form={`m${m.id}`} name="kind">
                        {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
                          <option value={k} selected={k === m.kind}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input form={`m${m.id}`} name="sort_order" type="number" value={m.sort_order} class="num" />
                    </td>
                    <td>
                      <input form={`m${m.id}`} name="active" type="checkbox" value="1" checked={!!m.active} />
                    </td>
                    <td>
                      <form id={`m${m.id}`} method="post" action={`${base}/machines/${m.id}`}>
                        <button class="secondary">Lagre</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Legg til maskin</h3>
          <form method="post" action={`${base}/machines`} class="row">
            <label>
              Navn
              <input name="name" required placeholder="f.eks. Vaskemaskin 2" />
            </label>
            <label>
              Type
              <select name="kind">
                {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
                  <option value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <button>Legg til</button>
          </form>
          <p class="muted">Deaktiver en maskin i stedet for å slette den, så beholdes historikken.</p>
        </section>

        <section>
          <h2>Tilgang</h2>
          <form method="post" action={`${base}/access`} class="stack">
            <p>
              Beboerpassord er <strong>{tenant.access_password_hash ? "på" : "av"}</strong>. Når det er på, må beboere skrive inn et felles passord én gang per
              enhet.
            </p>
            <label>
              Nytt beboerpassord (tomt = fjern passord)
              <input name="access_password" type="text" autocomplete="off" />
            </label>
            <button class="secondary">Oppdater beboerpassord</button>
          </form>
          <form method="post" action={`${base}/admin-password`} class="stack">
            <label>
              Nytt adminpassord (min. 8 tegn)
              <input name="admin_password" type="password" minlength={8} required autocomplete="new-password" />
            </label>
            <button class="secondary">Bytt adminpassord</button>
          </form>
        </section>
      </main>
    </Layout>
  );
};
