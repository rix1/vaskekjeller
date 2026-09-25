import type { FC } from "hono/jsx";
import type { Tenant } from "./db.ts";
import { PLAYGROUND_SLUG, SHOWCASE_SLUG } from "./demo.ts";
import { Icon, Layout } from "./views.tsx";

const POINTS = [
  {
    icon: "check",
    title: "Ett trykk",
    text: "Velg en ledig tid og trykk Reserver. Vaskemaskin og tørketrommel på én gang.",
  },
  {
    icon: "bell",
    title: "Venteliste med varsel",
    text: "Er tiden tatt? Sett deg på ventelisten, så får du beskjed når den blir ledig.",
  },
  {
    icon: "phone",
    title: "Ingen app å installere",
    text: "Det er en nettside. Del lenken, så er naboene i gang.",
  },
  {
    icon: "shield",
    title: "Ingen personopplysninger",
    text: "Bare leilighetsnummer. Ingen navn, e-post eller telefonnummer.",
  },
] as const;

/** The front page: what this is, a live (read-only) preview, and where to go next. */
export const LandingPage: FC<{
  /** The last building opened on this device, if it still exists and is open. */
  last?: Tenant;
  /** The showcase opens on this day, which is always nearly full. */
  previewDate: string;
}> = (p) => (
  <Layout title="Vaskekjeller – booking av felles vaskerom" head={<LandingHead />}>
    <header class="landing-top">
      <a class="brand" href="/" aria-label="Vaskekjeller, forsiden">
        <span class="brand-icon">
          <Icon size={25} />
        </span>
        <span>Vaskekjeller</span>
      </a>
      {p.last && (
        <a class="go-last" href={`/${p.last.slug}`}>
          <span>Gå til</span>
          <span class="go-last-name">{p.last.name}</span>
          <span aria-hidden="true">→</span>
        </a>
      )}
    </header>
    <main class="landing">
      <section class="landing-hero">
        <div class="landing-copy">
          <p class="eyebrow">FOR BORETTSLAG OG SAMEIER</p>
          <h1>Vaskerommet, booket på ett trykk.</h1>
          <p class="landing-lede">
            Vaskekjeller er en enkel bookingside for felles vaskerom. Naboene reserverer vaskemaskin og tørketrommel fra mobilen, og
            alle ser hvem som har hvilken tid.
          </p>
          <div class="landing-actions">
            <a class="button landing-primary" href="/ny">
              Opprett vaskekjeller
              <Icon name="arrow" size={16} />
            </a>
          </div>
          <p class="landing-hint">
            <Icon name="home" size={16} />
            <span>Har du en lenke fra styret? Bruk den, så kommer du rett til vaskerommet ditt.</span>
          </p>
        </div>
        <div class="landing-preview">
          <figure
            class="phone"
            role="img"
            aria-label="Forhåndsvisning av bookingsiden på mobil: en dag i vaskerommet, med reserverte, delvis ledige og ledige tider, kommentarer og dine egne tider."
          >
            <div class="phone-screen">
              <iframe
                src={`/${SHOWCASE_SLUG}?embed=1&date=${p.previewDate}`}
                title="Forhåndsvisning av bookingsiden"
                loading="lazy"
                tabindex={-1}
                aria-hidden="true"
                inert
              />
            </div>
          </figure>
          <a class="button landing-demo" href={`/${PLAYGROUND_SLUG}`}>
            Prøv demoen <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>
      <ul class="landing-points">
        {POINTS.map((point) => (
          <li>
            <span class="point-icon">
              <Icon name={point.icon} size={20} />
            </span>
            <h2>{point.title}</h2>
            <p>{point.text}</p>
          </li>
        ))}
      </ul>
    </main>
    <footer class="landing-foot">
      <span>Felles vaskerom, færre løse tråder.</span>
      <span class="foot-links">
        <a href="/om">Om Vaskekjeller</a>
        <a href="https://github.com/rix1/vaskekjeller">Åpen kildekode</a>
      </span>
    </footer>
  </Layout>
);

const LandingHead: FC = () => (
  <>
    <meta
      name="description"
      content="Enkel booking av felles vaskerom for borettslag og sameier. Ett trykk, venteliste med varsel, ingen app og ingen personopplysninger."
    />
    <link rel="stylesheet" href="/landing.css" />
  </>
);
