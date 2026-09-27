import type { FC } from "hono/jsx";

// Search engines index only the public pages below. Every other page (buildings, admin, onboarding, the demo
// buildings) says noindex twice: an X-Robots-Tag header (src/index.tsx) and a robots meta tag (Layout).
// robots.txt blocks nothing, so crawlers can fetch those pages and see the noindex.

export const SITE_URL = "https://www.vaskekjeller.no";
export const SITE_NAME = "Vaskekjeller";

/** Share image for Open Graph and Twitter cards: the landing page with its phone preview. */
export const SHARE_IMAGE = { path: "/share.png", width: 1200, height: 630, alt: "Vaskekjeller: bookingsiden for felles vaskerom på mobil" };

/** A public, indexable page: its canonical path and the text search results and link previews show. */
export type PublicPage = { path: string; title: string; description: string };

export const PUBLIC_PAGES = {
  landing: {
    path: "/",
    title: "Vaskekjeller – booking av felles vaskerom",
    description:
      "Enkel booking av felles vaskerom for borettslag og sameier. Ett trykk, venteliste med varsel, ingen app og ingen personopplysninger.",
  },
  about: {
    path: "/om",
    title: "Om Vaskekjeller – spørsmål og svar",
    description:
      "Slik kommer du i gang med Vaskekjeller, når du får varsler, kalender-abonnement og hva som lagres om deg og borettslaget.",
  },
  signup: {
    path: "/ny",
    title: "Opprett vaskekjeller – kom i gang · Vaskekjeller",
    description:
      "Sett opp booking av vaskerommet i borettslaget eller sameiet på et par minutter. Ingen e-post, ingen app å laste ned.",
  },
} satisfies Record<string, PublicPage>;

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(Object.values(PUBLIC_PAGES).map((p) => p.path));

export const absoluteUrl = (path: string) => `${SITE_URL}${path === "/" ? "/" : path}`;

/** Description, canonical URL and link-preview tags for a public page. The title tag is Layout's. */
export const SeoMeta: FC<{ page: PublicPage }> = ({ page }) => {
  const url = absoluteUrl(page.path);
  const image = absoluteUrl(SHARE_IMAGE.path);
  return (
    <>
      <meta name="description" content={page.description} />
      <link rel="canonical" href={url} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:locale" content="nb_NO" />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={page.title} />
      <meta property="og:description" content={page.description} />
      <meta property="og:image" content={image} />
      <meta property="og:image:width" content={String(SHARE_IMAGE.width)} />
      <meta property="og:image:height" content={String(SHARE_IMAGE.height)} />
      <meta property="og:image:alt" content={SHARE_IMAGE.alt} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={page.title} />
      <meta name="twitter:description" content={page.description} />
      <meta name="twitter:image" content={image} />
      <meta name="twitter:image:alt" content={SHARE_IMAGE.alt} />
    </>
  );
};

/** schema.org WebApplication for the landing page. */
export const LandingStructuredData: FC = () => {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    description: PUBLIC_PAGES.landing.description,
    inLanguage: "no",
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Alle nettlesere",
    browserRequirements: "Krever en moderne nettleser",
    image: absoluteUrl(SHARE_IMAGE.path),
  };
  // "<" is escaped so no value can close the script tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
};

export const robotsTxt = () => `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl("/sitemap.xml")}\n`;

export const sitemapXml = () =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.values(PUBLIC_PAGES)
    .map((p) => `  <url><loc>${absoluteUrl(p.path)}</loc></url>\n`)
    .join("")}</urlset>\n`;
