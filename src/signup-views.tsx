import type { Child, FC } from "hono/jsx";
import { AdminIcon, described, FieldError, RecoveryCodeBlock, schedulePreview, SLOT_LENGTHS, slotLengthLabel } from "./admin-views.tsx";
import { KIND_LABEL, type MachineKind, type Tenant } from "./db.ts";
import { SLUG_MAX, TURNSTILE_ACTION } from "./signup.ts";
import { fmtMinute, parseHHMM } from "./time.ts";
import { Icon, Layout, Toast, Toaster } from "./views.tsx";

/** The signup flow, in order. Steps 1–3 happen before the building exists; the rest are admin pages. */
export const STEPS = ["Navn", "Adresse", "Adminpassord", "Tider", "Maskiner", "Beboerpassord", "Gjenopprettingskode", "Del"] as const;

type Errors = Record<string, string | undefined>;

const FlowPage: FC<{
  title: string;
  /** 1-based step in STEPS; pages outside the signup flow (password reset) leave it out. */
  step?: number;
  tenant?: Tenant;
  /** Error toast, e.g. after a failed validation. */
  alert?: Child;
  dismissHref?: string;
  scripts?: ("admin" | "signup" | "turnstile")[];
  children: Child;
}> = (p) => (
  <Layout
    title={p.tenant ? `${p.title} · ${p.tenant.name}` : `${p.title} · Vaskekjeller`}
    tenant={p.tenant}
    head={
      <>
        <link rel="stylesheet" href="/admin.css" />
        <link rel="stylesheet" href="/signup.css" />
        {p.scripts?.includes("admin") && <script type="module" src="/admin.js" defer></script>}
        {p.scripts?.includes("signup") && <script type="module" src="/signup.js" defer></script>}
        {p.scripts?.includes("turnstile") && (
          <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        )}
      </>
    }
  >
    <header class="top resident-top signup-top">
      <span class="brand">
        <span class="brand-icon">
          <Icon size={25} />
        </span>
        <span>
          Vaskekjeller<small>{p.tenant ? p.tenant.name : "Kom i gang"}</small>
        </span>
      </span>
    </header>
    <main class="admin-main signup-main">
      {p.step && <Progress step={p.step} />}
      {p.children}
    </main>
    <Toaster dismissHref={p.dismissHref ?? "#"}>
      {p.alert && (
        <Toast tone="error" dismissHref={p.dismissHref ?? "#"}>
          {p.alert}
        </Toast>
      )}
    </Toaster>
  </Layout>
);

const Progress: FC<{ step: number }> = ({ step }) => (
  <div class="progress">
    <p class="eyebrow" id="progress-label">
      STEG {step} AV {STEPS.length} · {STEPS[step - 1]!.toUpperCase()}
    </p>
    <ol class="progress-bar" aria-labelledby="progress-label">
      {STEPS.map((label, i) => (
        <li class={i + 1 < step ? "done" : i + 1 === step ? "current" : undefined} aria-current={i + 1 === step ? "step" : undefined}>
          <span class="sr-only">
            {label}
            {i + 1 < step ? " (ferdig)" : ""}
          </span>
        </li>
      ))}
    </ol>
  </div>
);

const Intro: FC<{ title: string; children?: Child }> = (p) => (
  <div class="signup-intro">
    <h1 tabindex={-1}>{p.title}</h1>
    {p.children && <p class="lead">{p.children}</p>}
  </div>
);

const Actions: FC<{ back?: string; submit: Child; children?: Child }> = (p) => (
  <div class="signup-actions">
    {p.back && (
      <a href={p.back} class="button ghost">
        Tilbake
      </a>
    )}
    {p.children}
    <button class="signup-next">
      {p.submit}
      <Icon name="arrow" size={18} />
    </button>
  </div>
);

const fixAlert = <p class="toast-title">Noe må rettes før du kan gå videre.</p>;
const hasErrors = (errors: Errors) => Object.values(errors).some(Boolean);

// ---------------------------------------------------------------------------
// Steps 1–3: before the building exists (plain GET forms, then one POST that creates it)
// ---------------------------------------------------------------------------

export const SignupClosed: FC = () => (
  <FlowPage title="Registrering">
    <section class="card signup-card">
      <Intro title="Registreringen er ikke åpen ennå">
        Nye vaskekjellere kan ikke opprettes akkurat nå. Prøv igjen senere, eller ta kontakt med den som drifter siden.
      </Intro>
    </section>
  </FlowPage>
);

export const SignupName: FC<{ name?: string; error?: string }> = ({ name = "", error }) => (
  <FlowPage title="Kom i gang" step={1} alert={error && fixAlert} dismissHref="/ny">
    <section class="card signup-card">
      <Intro title="Hva heter borettslaget eller bygget?">
        Du setter opp booking av vaskekjelleren på et par minutter. Ingen e-post, ingen app å laste ned.
      </Intro>
      <form method="get" action="/ny/adresse" class="card-form">
        <div class="field">
          <label for="navn">Navn</label>
          <input
            name="navn"
            required
            maxlength={80}
            autocomplete="organization"
            placeholder="F.eks. Borettslaget Lofotgata"
            value={name}
            autofocus
            {...described("navn", error, true)}
          />
          <p class="field-hint" id="navn-hint">
            Beboerne ser navnet øverst på bookingsiden. Du kan endre det senere.
          </p>
          <FieldError id="navn" error={error} />
        </div>
        <Actions submit="Fortsett" />
      </form>
    </section>
  </FlowPage>
);

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const SignupAddress: FC<{ name: string; slug: string; host: string; error?: string }> = ({ name, slug, host, error }) => (
  <FlowPage title="Adresse" step={2} alert={error && fixAlert} dismissHref={`/ny/adresse?${q({ navn: name, adresse: slug })}`} scripts={["signup"]}>
    <section class="card signup-card">
      <Intro title="Velg adressen til bookingsiden">
        Beboerne åpner denne adressen for å booke. Vi har laget et forslag fra navnet, men du kan endre det.
      </Intro>
      <form method="get" action="/ny/passord" class="card-form" data-slug-form>
        <input type="hidden" name="navn" value={name} />
        <div class="field">
          <label for="adresse">Adresse</label>
          <div class="address-input">
            <span class="address-host" aria-hidden="true">
              <span>{host}</span>/
            </span>
            <input
              name="adresse"
              required
              minlength={3}
              maxlength={SLUG_MAX}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              autocapitalize="off"
              autocomplete="off"
              spellcheck={false}
              value={slug}
              data-slug-check="/ny/sjekk"
              {...described("adresse", error, true)}
            />
          </div>
          <p class="field-hint slug-status" id="adresse-hint" aria-live="polite" data-slug-status={error ? undefined : "free"}>
            {error ? "Små bokstaver (a–z), tall og bindestrek." : "Ledig."}
          </p>
          <FieldError id="adresse" error={error} />
        </div>
        <Actions back={`/ny?${q({ navn: name })}`} submit="Fortsett" />
      </form>
    </section>
  </FlowPage>
);

export const SignupPassword: FC<{
  name: string;
  slug: string;
  host: string;
  siteKey?: string;
  errors?: Errors;
  status?: string;
}> = ({ name, slug, host, siteKey, errors = {}, status }) => (
  <FlowPage
    title="Adminpassord"
    step={3}
    alert={status ? <p class="toast-title">{status}</p> : hasErrors(errors) && fixAlert}
    dismissHref={`/ny/passord?${q({ navn: name, adresse: slug })}`}
    scripts={siteKey ? ["signup", "turnstile"] : ["signup"]}
  >
    <section class="card signup-card">
      <Intro title="Lag et adminpassord">
        Med det logger du inn på adminsiden og endrer tider, maskiner og tilgang. Del det bare med andre som skal hjelpe til.
      </Intro>
      <p class="summary-line">
        <span>Bookingsiden</span>
        <strong>
          {host}/{slug}
        </strong>
      </p>
      <form method="post" action="/ny/passord" class="card-form" data-turnstile-form={siteKey ? "" : undefined}>
        <input type="hidden" name="navn" value={name} />
        <input type="hidden" name="adresse" value={slug} />
        <input type="text" name="username" autocomplete="username" value={`${slug}-admin`} hidden />
        <div class="field">
          <label for="admin_password">Adminpassord</label>
          <input
            name="admin_password"
            type="password"
            minlength={8}
            required
            autocomplete="new-password"
            autofocus
            {...described("admin_password", errors.admin_password, true)}
          />
          <p class="field-hint" id="admin_password-hint">
            Minst 8 tegn. Det lagres som en enveis-hash, så ingen kan se det – heller ikke vi.
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
        {siteKey && (
          <>
            <div class="cf-turnstile" data-sitekey={siteKey} data-action={TURNSTILE_ACTION} data-language="nb" />
            <noscript>
              <p class="notice-box">Slå på JavaScript for å fullføre. Vi bruker det til å sjekke at du ikke er en robot.</p>
            </noscript>
          </>
        )}
        <Actions back={`/ny/adresse?${q({ navn: name, adresse: slug })}`} submit="Opprett vaskekjelleren" />
        {siteKey && (
          <p class="hint signup-fineprint" data-turnstile-status aria-live="polite">
            Beskyttet av Cloudflare Turnstile, som sjekker at du ikke er en robot uten at du trenger å gjøre noe.
          </p>
        )}
      </form>
    </section>
  </FlowPage>
);

// ---------------------------------------------------------------------------
// Steps 4–8: admin pages of the new building
// ---------------------------------------------------------------------------

const onboardingPath = (t: Tenant, step: string) => `/${t.slug}/admin/kom-i-gang/${step}`;

export const OnboardHours: FC<{ tenant: Tenant; errors?: Errors; values?: Record<string, string> }> = ({ tenant, errors = {}, values = {} }) => {
  const dayStart = values.day_start ?? fmtMinute(tenant.day_start_min);
  const dayEnd = values.day_end ?? fmtMinute(tenant.day_end_min);
  const slot = Number(values.slot_min ?? tenant.slot_min);
  return (
    <FlowPage
      title="Tider"
      step={4}
      tenant={tenant}
      alert={hasErrors(errors) && fixAlert}
      dismissHref={onboardingPath(tenant, "tider")}
      scripts={["admin", "signup"]}
    >
      <section class="card signup-card">
        <p class="created-note">
          <Icon name="check" size={16} /> {tenant.name} er opprettet, og du er logget inn som admin.
        </p>
        <Intro title="Når er vaskekjelleren åpen?">Dagen deles opp i tider som beboerne kan booke. Du kan endre dette senere.</Intro>
        <form method="post" action={onboardingPath(tenant, "tider")} class="card-form" data-schedule>
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
                  <input type="radio" name="slot_min" value={m} checked={m === slot} required aria-invalid={errors.slot_min ? "true" : undefined} />
                  <span>{slotLengthLabel(m)}</span>
                </label>
              ))}
            </div>
            <p class="slot-preview" id="slot-preview" aria-live="polite">
              {schedulePreview(parseHHMM(dayStart), parseHHMM(dayEnd), slot)}
            </p>
            <FieldError id="slot_min" error={errors.slot_min} />
          </fieldset>
          <Actions submit="Fortsett" />
        </form>
      </section>
    </FlowPage>
  );
};

const KIND_PLURAL: Record<MachineKind, string> = { washer: "Vaskemaskiner", dryer: "Tørketromler" };
export const MAX_PER_KIND = 10;

export const OnboardMachines: FC<{ tenant: Tenant; counts: Record<MachineKind, number>; error?: string }> = ({ tenant, counts, error }) => (
  <FlowPage
    title="Maskiner"
    step={5}
    tenant={tenant}
    alert={error && fixAlert}
    dismissHref={onboardingPath(tenant, "maskiner")}
    scripts={["signup"]}
  >
    <section class="card signup-card">
      <Intro title="Hvilke maskiner har dere?">
        Beboerne reserverer en vaskemaskin og en tørketrommel sammen med ett trykk, eller bare den ene.
      </Intro>
      <form method="post" action={onboardingPath(tenant, "maskiner")} class="card-form">
        <fieldset class="field" aria-describedby={["machines-hint", error && "machines-error"].filter(Boolean).join(" ")}>
          <legend class="sr-only">Antall maskiner</legend>
          <ul class="counter-list">
            {(Object.keys(KIND_LABEL) as MachineKind[]).map((kind) => (
              <li class="counter-row">
                <span class="counter-icon">
                  <Icon name={kind} size={22} />
                </span>
                <label for={`count-${kind}`}>{KIND_PLURAL[kind]}</label>
                <div class="stepper" data-stepper>
                  <button type="button" class="icon-btn" data-step="-1" aria-label={`Færre ${KIND_PLURAL[kind].toLowerCase()}`} hidden>
                    <span aria-hidden="true">−</span>
                  </button>
                  <input
                    id={`count-${kind}`}
                    name={kind}
                    type="number"
                    inputmode="numeric"
                    min={0}
                    max={MAX_PER_KIND}
                    required
                    value={String(counts[kind])}
                    aria-invalid={error ? "true" : undefined}
                  />
                  <button type="button" class="icon-btn" data-step="1" aria-label={`Flere ${KIND_PLURAL[kind].toLowerCase()}`} hidden>
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p class="field-hint" id="machines-hint">
            Du kan gi maskinene egne navn, endre rekkefølgen og slå dem av og på under Innstillinger.
          </p>
          <FieldError id="machines" error={error} />
        </fieldset>
        <Actions back={onboardingPath(tenant, "tider")} submit="Fortsett" />
      </form>
    </section>
  </FlowPage>
);

export const OnboardResidents: FC<{ tenant: Tenant; on: boolean; password: string; error?: string }> = ({ tenant, on, password, error }) => (
  <FlowPage
    title="Beboerpassord"
    step={6}
    tenant={tenant}
    alert={error && fixAlert}
    dismissHref={onboardingPath(tenant, "beboere")}
    scripts={["signup"]}
  >
    <section class="card signup-card">
      <Intro title="Skal beboerne trenge et passord?">
        Valgfritt. Et felles passord holder bookingsiden for dere som bor her. Beboerne skriver det inn én gang per mobil.
      </Intro>
      <form method="post" action={onboardingPath(tenant, "beboere")} class="card-form" data-resident-choice>
        <fieldset class="field">
          <legend class="sr-only">Beboerpassord</legend>
          <div class="choice-list">
            <label class="choice">
              <input type="radio" name="passord" value="nei" checked={!on} />
              <span>
                <strong>Nei, alle med lenken kan booke</strong>
                <small>Enklest. Lenken er vanskelig å gjette, men den kan deles videre.</small>
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="passord" value="ja" checked={on} />
              <span>
                <strong>Ja, bruk et felles passord</strong>
                <small>Som en dørkode. Du kan alltid se det igjen i innstillingene.</small>
              </span>
            </label>
          </div>
        </fieldset>
        <div class="reveal" data-when-password>
          <div class="reveal-inner">
        <div class="field">
          <label for="access_password">Beboerpassord</label>
          <input
            name="access_password"
            type="text"
            maxlength={100}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="F.eks. dørkoden til kjelleren"
            value={password}
            {...described("access_password", error, true)}
          />
          <p class="field-hint" id="access_password-hint">
            Passordet står i meldingen du sender til beboerne i siste steg.
          </p>
          <FieldError id="access_password" error={error} />
        </div>
          </div>
        </div>
        <Actions back={onboardingPath(tenant, "maskiner")} submit="Fortsett" />
      </form>
    </section>
  </FlowPage>
);

export const OnboardRecovery: FC<{ tenant: Tenant; code: string | null }> = ({ tenant, code }) => (
  <FlowPage title="Gjenopprettingskode" step={7} tenant={tenant} scripts={["admin"]}>
    <section class="card signup-card">
      <Intro title="Lagre gjenopprettingskoden">
        Glemmer dere adminpassordet, er denne koden eneste måte å lage et nytt på. Vi har ikke e-postadressen din.
      </Intro>
      {code ? (
        <>
          <RecoveryCodeBlock tenant={tenant} code={code} />
          <p class="field-hint">
            Legg den i passordbehandleren, skriv den ut, eller lagre filen et trygt sted. Koden vises bare denne ene gangen.
          </p>
          <form method="post" action={onboardingPath(tenant, "kode")} class="card-form">
            <label class="check">
              <input type="checkbox" name="lagret" value="1" required />
              <span>Jeg har lagret koden et trygt sted</span>
            </label>
            <Actions back={onboardingPath(tenant, "beboere")} submit="Fortsett" />
          </form>
        </>
      ) : (
        <>
          <p class="notice-box">
            {tenant.recovery_code_hash
              ? "Koden er allerede vist, og den kan ikke vises igjen. Har du ikke lagret den, lager du en ny – da slutter den gamle å virke."
              : "Det er ikke laget noen kode ennå."}
          </p>
          <form method="post" action={`/${tenant.slug}/admin/recovery`} class="card-form">
            <input type="hidden" name="tilbake" value="kom-i-gang" />
            <div class="signup-actions">
              {tenant.recovery_code_hash && (
                <a href={onboardingPath(tenant, "del")} class="button ghost">
                  Hopp over
                </a>
              )}
              <button class={tenant.recovery_code_hash ? "secondary" : undefined}>
                {tenant.recovery_code_hash ? "Lag en ny kode" : "Lag kode"}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  </FlowPage>
);

const ShareCard: FC<{ id: string; title: string; description: string; text: string }> = (p) => (
  <section class="card share-card" aria-labelledby={`${p.id}-title`}>
    <div class="card-head">
      <h2 id={`${p.id}-title`}>{p.title}</h2>
      <p>{p.description}</p>
    </div>
    <textarea id={p.id} class="share-text" readonly rows={p.text.split("\n").length + 1} aria-labelledby={`${p.id}-title`}>
      {p.text}
    </textarea>
    <div class="share-actions">
      <button type="button" class="button" data-copy={`#${p.id}`} hidden>
        <AdminIcon name="copy" size={16} />
        <span data-copy-label>Kopier melding</span>
      </button>
      <button type="button" class="button secondary" data-share={`#${p.id}`} hidden>
        <AdminIcon name="share" size={16} />
        Del
      </button>
    </div>
  </section>
);

export const OnboardShare: FC<{ tenant: Tenant; residents: string; admins: string; bookingPath: string }> = (p) => (
  <FlowPage title="Del" step={8} tenant={p.tenant} scripts={["admin"]}>
    <section class="card signup-card done-card">
      <span class="done-mark" aria-hidden="true">
        <AdminIcon name="check" size={26} />
      </span>
      <Intro title="Alt er klart! Nå gjenstår bare å si ifra">
        Kopier meldingen og send den til beboerne der dere pleier å snakke sammen – Facebook-gruppen, en SMS, e-post eller en lapp på
        oppslagstavla.
      </Intro>
    </section>
    <ShareCard
      id="melding-beboere"
      title="Til beboerne"
      description="Med lenken, passordet hvis dere har et, og hvordan de kommer i gang."
      text={p.residents}
    />
    <ShareCard
      id="melding-admin"
      title="Til andre som skal være admin"
      description="Alle admins deler samme innlogging. Passordet står ikke i meldingen – det gir du dem selv."
      text={p.admins}
    />
    <div class="signup-actions final-actions">
      <a href={`/${p.tenant.slug}/admin`} class="button ghost">
        Til adminsiden
      </a>
      <a href={p.bookingPath} class="button">
        Åpne bookingsiden
        <Icon name="arrow" size={18} />
      </a>
    </div>
  </FlowPage>
);

// ---------------------------------------------------------------------------
// Admin password reset with the recovery code
// ---------------------------------------------------------------------------

export const RecoveryResetPage: FC<{ tenant: Tenant; errors?: Errors }> = ({ tenant, errors = {} }) => (
  <FlowPage title="Nullstill adminpassord" tenant={tenant} alert={hasErrors(errors) && fixAlert} dismissHref={`/${tenant.slug}/admin/nullstill`}>
    <section class="card signup-card">
      <Intro title="Nullstill adminpassordet">
        Skriv inn gjenopprettingskoden dere lagret da vaskekjelleren ble opprettet, og velg et nytt passord. Da får dere også en ny kode.
      </Intro>
      <form method="post" action={`/${tenant.slug}/admin/nullstill`} class="card-form">
        <input type="text" name="username" autocomplete="username" value={`${tenant.slug}-admin`} hidden />
        <div class="field">
          <label for="recovery_code">Gjenopprettingskode</label>
          <input
            name="recovery_code"
            required
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            class="code-input"
            autofocus
            {...described("recovery_code", errors.recovery_code)}
          />
          <FieldError id="recovery_code" error={errors.recovery_code} />
        </div>
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
            Minst 8 tegn. Alle som er logget inn som admin blir logget ut.
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
        <Actions back={`/${tenant.slug}/admin/login`} submit="Nullstill passordet" />
      </form>
    </section>
  </FlowPage>
);
