import type { Child, FC } from "hono/jsx";
import { PUBLIC_PAGES } from "./seo.tsx";
import { Icon, Layout } from "./views.tsx";

export const CONTACT_EMAIL = "hjelp@vaskekjeller.no";

const SECTIONS = [
  { id: "kom-i-gang", icon: "home", title: "Kom i gang" },
  { id: "reservere", icon: "clock", title: "Reservere og avbestille" },
  { id: "varsler", icon: "bell", title: "Varsler" },
  { id: "kalender", icon: "calendar", title: "Kalender" },
  { id: "data", icon: "shield", title: "Data og personvern" },
] as const;

const Section: FC<{ id: (typeof SECTIONS)[number]["id"]; children: Child }> = (p) => {
  const s = SECTIONS.find((x) => x.id === p.id)!;
  return (
    <section class="about-section" id={s.id} aria-labelledby={`${s.id}-title`}>
      <div class="about-section-head">
        <span class="point-icon">
          <Icon name={s.icon} size={20} />
        </span>
        <h2 id={`${s.id}-title`}>{s.title}</h2>
      </div>
      <div class="about-faq">{p.children}</div>
    </section>
  );
};

const Q: FC<{ q: string; children: Child }> = (p) => (
  <details>
    <summary>{p.q}</summary>
    <div class="about-answer">{p.children}</div>
  </details>
);

/** /om: what Vaskekjeller is and how it works, for residents and boards. Shared by every building. */
export const AboutPage: FC = () => (
  <Layout title={PUBLIC_PAGES.about.title} seo={PUBLIC_PAGES.about} head={<link rel="stylesheet" href="/landing.css" />}>
    <header class="landing-top about-narrow">
      <a class="brand" href="/" aria-label="Vaskekjeller, forsiden">
        <span class="brand-icon">
          <Icon size={25} />
        </span>
        <span>Vaskekjeller</span>
      </a>
    </header>
    <main class="about">
      <div class="about-intro">
        <p class="eyebrow">OM VASKEKJELLER</p>
        <h1>Spørsmål og svar</h1>
        <p class="landing-lede">
          Vaskekjeller er en enkel bookingside for felles vaskerom. Her står hvordan du kommer i gang, når du får varsler, og hva
          som lagres.
        </p>
        <nav class="about-toc" aria-label="Innhold">
          {SECTIONS.map((s) => (
            <a href={`#${s.id}`}>{s.title}</a>
          ))}
        </nav>
      </div>

      <Section id="kom-i-gang">
        <Q q="Hvordan finner jeg vaskerommet vårt?">
          <p>
            Bruk lenken fra styret, for eksempel <code>www.vaskekjeller.no/borettslaget</code>. Har du åpnet den før på samme
            enhet, har forsiden en «Gå til»-snarvei dit.
          </p>
        </Q>
        <Q q="Hvordan velger jeg leilighet?">
          <p>
            Første gang velger du leilighetsnummeret ditt. Det huskes på enheten, så du slipper å logge inn. Du bytter under
            «Leilighet» øverst på siden.
          </p>
          <p>
            Du kan bare avbestille tider som er reservert for din leilighet. Ingen sjekker hvem du er, så det bygger på tillit, som
            lista på vaskeromsdøra. Har styret satt en firesifret kode, skriver du den inn én gang per enhet.
          </p>
        </Q>
        <Q q="Hvordan legger jeg den på Hjem-skjermen?">
          <p>Det er en nettside, ikke en app fra App Store. Slik får du et ikon på telefonen:</p>
          <ul>
            <li>
              <strong>iPhone:</strong> åpne vaskerommet i Safari, trykk Del og velg «Legg til på Hjem-skjerm».
            </li>
            <li>
              <strong>Android:</strong> åpne vaskerommet i Chrome, trykk på menyen (⋮) og legg siden til på
              startskjermen.
            </li>
          </ul>
          <p>
            Ikonet åpner vaskerommet ditt direkte. Lenken styret deler (den som slutter på /velkommen) viser deg stegene på
            din telefon, og hjelper deg å slå på varsler etterpå.
          </p>
        </Q>
      </Section>

      <Section id="reservere">
        <Q q="Hvordan reserverer jeg en tid?">
          <p>
            Velg dag og trykk «Reserver» på en ledig tid. Vaskemaskin og tørketrommel følger med. Trenger du bare vask eller
            tørk, velger du det over dagene. Tiden står da som «Din tid», og du finner den igjen under «Dine tider».
          </p>
        </Q>
        <Q q="Hvordan avbestiller jeg?">
          <p>
            Trykk på tiden din, eller åpne den under «Dine tider», og velg «Avbestill». Tiden blir ledig med en gang, og
            naboer på ventelisten får beskjed. Du kan også legge til en kommentar til naboene der.
          </p>
        </Q>
        <Q q="Hva er ventelisten?">
          <p>
            Er en tid tatt, trykker du «Venteliste» og så «Si fra når den blir ledig». Blir tiden ledig, får du varsel. Den
            reserverer ikke for deg: den første som trykker «Reserver» får tiden. Tidene du venter på står under «På venteliste».
          </p>
        </Q>
        <Q q="Hva er «Send melding»?">
          <p>
            Under «Venteliste» kan du sende en kort melding til naboen som har tiden, for eksempel at du gjerne vil ha den.
            Naboen får den som et varsel, og det går bare når vedkommende har varsler på. Meldingen lagres ikke.
          </p>
        </Q>
      </Section>

      <Section id="varsler">
        <Q q="Når får jeg varsel?">
          <p>Bare i disse tilfellene:</p>
          <ul>
            <li>
              <strong>En tid blir ledig.</strong> Du står på ventelisten, og den som har tiden avbestiller (eller styret gjør det).
              Alle på ventelisten får varsel samtidig, og den første som reserverer får tiden. Ventelisten reserverer ikke for
              deg.
            </li>
            <li>
              <strong>En kommentar endres.</strong> Du står på ventelisten, og den som har tiden legger til eller endrer
              kommentaren sin. En ny endring erstatter det forrige varselet. Fjernes kommentaren, kommer det ikke noe varsel.
            </li>
            <li>
              <strong>Noen venter på tiden din.</strong> En nabo setter seg på ventelisten for en tid du har reservert. Trenger
              du ikke tiden, kan du avbestille den, eller svare med en kommentar. Setter flere seg på, erstatter det nye
              varselet det forrige.
            </li>
            <li>
              <strong>Tiden din snart starter.</strong> Noen minutter før en tid du har reservert, får du en påminnelse.
              Avbestiller du, kommer den ikke.
            </li>
            <li>
              <strong>Du får en melding.</strong> En nabo trykker «Send melding» på en av dine tider. Det går bare når du har
              varsler på, og det er høyst 3 meldinger per leilighet og 10 totalt per tid. Svar ved å endre kommentaren din: da får
              alle som venter beskjed, også den som sendte meldingen.
            </li>
          </ul>
          <p>Når du slår på varsler, får du et testvarsel. Ellers kommer det ingen reklame.</p>
        </Q>
        <Q q="Hvordan slår jeg på varsler?">
          <p>
            Trykk på leiligheten din øverst og velg «Slå på varsler», eller bruk «Slå på» under «Dine tider». Tillat varsler når
            nettleseren spør. Varsler gjelder den ene enheten, så gjør det på hver telefon eller datamaskin du vil ha dem på.
          </p>
        </Q>
        <Q q="Hvorfor får jeg ikke varsler på iPhone?">
          <p>
            Apple tillater bare varsler fra nettsider som er lagt til på Hjem-skjermen (iOS 16.4 eller nyere). Legg til
            vaskerommet på Hjem-skjermen, åpne det fra ikonet der, og slå på varsler der. I vanlig Safari går det
            ikke.
          </p>
        </Q>
        <Q q="Hvordan skrur jeg av varsler?">
          <ul>
            <li>
              <strong>For én tid:</strong> trykk «Forlat venteliste».
            </li>
            <li>
              <strong>Alle varsler på enheten:</strong> velg «Skru av varsler» i menyen under leiligheten din øverst, eller slå av varsler for
              Vaskekjeller i innstillingene på telefonen eller i nettleseren.
            </li>
          </ul>
          <p>Når varsler er av, kan naboer ikke sende deg meldinger.</p>
        </Q>
      </Section>

      <Section id="kalender">
        <Q q="Kan jeg se tidene mine i kalenderen?">
          <p>
            Ja. Rett etter at du har reservert, dukker «Legg i kalender» opp under tidene. Du finner den også på hver tid under
            «Dine tider». Da laster du ned én kalenderhendelse som du åpner i kalenderappen din, og den virker i Apple Kalender,
            Google Kalender og Outlook.
          </p>
        </Q>
        <Q q="Oppdateres kalenderen hvis jeg avbestiller?">
          <p>
            Nei. Hendelsen er en kopi av tiden på det tidspunktet du la den inn, og er ikke koblet til Vaskekjeller. Avbestiller du,
            må du slette den fra kalenderen selv.
          </p>
        </Q>
      </Section>

      <Section id="data">
        <Q q="Hva lagres?">
          <ul>
            <li>Leilighetsnummeret på reservasjoner, ventelister og varsler.</li>
            <li>Tidene som reserveres, også avbestilte (til statistikk), og kommentarene på dem.</li>
            <li>For varsler: en adresse fra nettleserens varseltjeneste, én per enhet.</li>
            <li>Daglige totaler: sidevisninger, antall besøkende og antall varsler.</li>
            <li>
              Koder som byttes hver dag, for å telle besøkende og nye vaskerom per nettverk (aldri selve IP-adressen).
            </li>
            <li>
              En aktivitetslogg over styrets endringer, med en grov enhetstype som «iPhone · Safari». Beboeres egne reservasjoner
              logges ikke der.
            </li>
            <li>
              Passord bare som hash. Beboerkoden lagres også kryptert, så styret kan se og dele det. Gjenopprettingskoden
              lagres bare som hash.
            </li>
          </ul>
          <p>Informasjonskapslene på enheten din husker:</p>
          <ul>
            <li>Leiligheten din og hvilket vaskerom du brukte sist.</li>
            <li>Om du er logget inn.</li>
            <li>Om du har reservert før, så første gangs tips kan hoppes over.</li>
            <li>
              Hvilke tips du har sett og om du har lukket spørsmålet om varsler (lagret i nettleseren, ikke som
              informasjonskapsel, og felles for alle vaskekjellere på denne enheten).
            </li>
            <li>
              For styret: en ny gjenopprettingskode, kryptert, i opptil en time og bare på adminsidene, så den kan vises til
              den er lagret.
            </li>
          </ul>
          <p>Det er alt de brukes til.</p>
        </Q>
        <Q q="Hva lagres ikke?">
          <p>
            Navn, e-post, telefonnummer og IP-adresser lagres ikke. Meldinger mellom naboer lagres ikke, bare hvor mange som er
            sendt. Besøkende telles med en kode som byttes hver dag, så ingen kan følges fra dag til dag. Det er ingen
            analyseverktøy eller reklame.
          </p>
        </Q>
        <Q q="Hvor lagres dataene?">
          <p>I en Cloudflare D1-database som er låst til EU. Den kan ikke flyttes ut av EU.</p>
        </Q>
        <Q q="Hvor lenge lagres de?">
          <ul>
            <li>Ventelister og meldingstellere: slettes etter et par dager.</li>
            <li>
              Kodene som teller besøkende og nye vaskerom per nettverk (aldri selve IP-adressen): slettes etter et par dager.
            </li>
            <li>Aktivitetsloggen: 12 måneder.</li>
            <li>Varseladresser: til du skrur av varsler, eller varseltjenesten sier at adressen er utløpt.</li>
            <li>
              Reservasjoner, kommentarer og daglige totaler: så lenge vaskerommet finnes. Beboere ser 14 dager bakover; avbestilte
              tider vises ikke.
            </li>
          </ul>
        </Q>
        <Q q="Hva skjer når et vaskerom slettes?">
          <p>
            Styret stenger det under Innstillinger → Tilgang. Da går bookingsiden ned med én gang, og alt om vaskerommet slettes
            permanent 7 dager senere. Fram til da kan styret åpne det igjen, eller slette det med én gang.
          </p>
          <p>
            Et vaskerom som er opprettet på nettsiden og ikke har fått en eneste booking etter 30 dager, stenges automatisk og
            slettes på samme måte.
          </p>
        </Q>
        <Q q="Hva er gjenopprettingskoden?">
          <p>
            Vaskekjeller har ingen e-post, så koden er den eneste måten å nullstille et glemt adminpassord på. Styret får den når
            vaskerommet opprettes, og kan lage en ny under Innstillinger → Tilgang. Bare en hash lagres, så ingen kan hente den
            fram igjen, heller ikke vi. Etter at den er brukt, erstattes den av en ny kode.
          </p>
        </Q>
      </Section>

      <p class="about-contact">
        Andre spørsmål? Skriv til <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </main>
    <footer class="landing-foot about-narrow">
      <span>Felles vaskerom, færre løse tråder.</span>
      <span class="foot-links">
        <a href="/">Forsiden</a>
        <a href="https://github.com/rix1/vaskekjeller">Åpen kildekode</a>
      </span>
    </footer>
  </Layout>
);
