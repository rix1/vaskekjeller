const slug = document.body.dataset.slug;
const vapidKey = document.body.dataset.vapid;

// Progressive enhancement: the same server-rendered forms also work without JS.
// Keep the document alive while replacing only the resident interface.
let pendingNavigation: AbortController | undefined;
let submitting = false;
let renderedView = location.pathname + cleanUrl(location.href).search;
const isBoard = () => !!document.querySelector(".resident-main");
const live = document.createElement("div");
live.className = "sr-only";
live.setAttribute("aria-live", "polite");
live.setAttribute("aria-atomic", "true");
document.body.append(live);

function cleanUrl(raw: string) {
  const url = new URL(raw, location.href);
  url.searchParams.delete("m");
  url.searchParams.delete("reservation");
  return url;
}

async function updateBoard(
  url: string,
  options: {
    form?: HTMLFormElement;
    history?: "push" | "replace" | "none";
    focusHref?: string;
  } = {},
) {
  pendingNavigation?.abort();
  const controller = new AbortController();
  pendingNavigation = controller;
  const main = document.querySelector<HTMLElement>(".resident-main")!;
  main.setAttribute("aria-busy", "true");
  main.classList.add("updating");
  main.querySelector(".slots")?.setAttribute("inert", "");
  const button = options.form?.querySelector<HTMLButtonElement>('button:not([type="button"])');
  const buttonContent = button?.innerHTML;
  if (button) {
    button.setAttribute("aria-disabled", "true");
    if (options.form?.hasAttribute("data-reserve")) button.textContent = "Reserverer…";
  }
  try {
    const res = await fetch(url, {
      method: options.form ? "POST" : "GET",
      body: options.form ? new URLSearchParams([...new FormData(options.form)].map(([key, value]) => [key, String(value)])) : undefined,
      signal: controller.signal,
      headers: { "X-Requested-With": "Vaskekjeller" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    if (controller.signal.aborted) return;
    const nextMain = doc.querySelector<HTMLElement>(".resident-main");
    const nextHeader = doc.querySelector(".resident-top");
    if (!nextMain || !nextHeader) {
      location.assign(res.url);
      return;
    }
    const finalUrl = cleanUrl(res.url);
    renderedView = finalUrl.pathname + finalUrl.search;
    const historyMode = options.history ?? (options.form ? "replace" : "push");
    if (historyMode === "push") history.pushState(null, "", finalUrl);
    if (historyMode === "replace") history.replaceState(null, "", finalUrl);
    document.title = doc.title;
    document.querySelector(".resident-top")!.replaceWith(nextHeader);
    const dateScroll = main.querySelector(".date-strip")?.scrollLeft ?? 0;
    main.replaceWith(nextMain);
    const dateStrip = nextMain.querySelector<HTMLElement>(".date-strip");
    const selectedDay = dateStrip?.querySelector<HTMLElement>(".selected");
    if (dateStrip && selectedDay) {
      dateStrip.scrollLeft = dateScroll;
      const stripBounds = dateStrip.getBoundingClientRect();
      const dayBounds = selectedDay.getBoundingClientRect();
      if (dayBounds.right > stripBounds.right) dateStrip.scrollLeft += dayBounds.right - stripBounds.right;
      if (dayBounds.left < stripBounds.left) dateStrip.scrollLeft -= stripBounds.left - dayBounds.left;
    }
    const message = nextMain.querySelector<HTMLElement>(".flash");
    live.textContent =
      message?.textContent ??
      `${nextMain.querySelector(".day-heading h3")?.textContent}. ${nextMain.querySelector(".machine-options .selected")?.textContent}.`;
    // Keep keyboard focus on the selected control after it has been replaced.
    if (options.focusHref) {
      const matching = [...nextMain.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.href === options.focusHref);
      const focusTarget = matching ?? nextMain.querySelector<HTMLElement>(".apt-picker input, .apt-picker select");
      focusTarget?.focus({ preventScroll: true });
    } else if (options.form) {
      const focus = message ?? nextMain.querySelector<HTMLElement>(".day-heading h3");
      focus?.setAttribute("tabindex", "-1");
      focus?.focus({ preventScroll: true });
      message?.scrollIntoView({ block: "nearest" });
    }
    void setupPush().catch(() => {});
  } catch (error) {
    if (controller.signal.aborted) return;
    main.querySelector(".network-error")?.remove();
    main.querySelectorAll(".date-item, .machine-options a").forEach((el) => {
      el.classList.toggle("selected", el.hasAttribute("aria-current"));
    });
    const errorBox = document.createElement("p");
    errorBox.className = "flash err network-error";
    errorBox.setAttribute("role", "alert");
    errorBox.textContent = options.form
      ? "Vi kunne ikke bekrefte endringen. Oppdater siden for å se om den ble lagret."
      : "Kunne ikke hente tidene. Sjekk forbindelsen og prøv igjen.";
    main.prepend(errorBox);
    errorBox.scrollIntoView({ block: "nearest" });
  } finally {
    if (pendingNavigation === controller) {
      document.querySelector(".resident-main")?.removeAttribute("aria-busy");
      document.querySelector(".resident-main")?.classList.remove("updating");
      document.querySelector(".slots")?.removeAttribute("inert");
      submitting = false;
      if (button?.isConnected) {
        button.removeAttribute("aria-disabled");
        if (buttonContent) button.innerHTML = buttonContent;
      }
    }
  }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  for (const details of document.querySelectorAll<HTMLDetailsElement>(".slot-details[open]")) {
    if (!details.contains(event.target)) details.open = false;
  }
  const link = event.target.closest<HTMLAnchorElement>("a[href]");
  if (
    !link ||
    !isBoard() ||
    link.target ||
    link.hasAttribute("download") ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.pathname !== `/${slug}` || url.hash) return;
  event.preventDefault();
  if (submitting) return;
  // Give immediate feedback; never show a reservation before the server confirms it.
  const group = link.closest(".date-strip, .machine-options");
  if (group) {
    group.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
    link.classList.add("selected");
  }
  void updateBoard(url.href, { focusHref: url.href });
});

document.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  const form = event.target;
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
    event.preventDefault();
    return;
  }
  if (!isBoard() || form.method.toLowerCase() !== "post") return;
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  void updateBoard(form.action, { form });
});

window.addEventListener("popstate", () => {
  if (isBoard() && !submitting && location.pathname + cleanUrl(location.href).search !== renderedView)
    void updateBoard(location.href, { history: "none" });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !(event.target instanceof Element)) return;
  const details = event.target.closest<HTMLDetailsElement>(".slot-details");
  if (details) {
    details.open = false;
    details.querySelector("summary")?.focus();
  }
});

// Web push is offered when a resident has joined a waitlist.
function keyToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function api(path: string, body: unknown) {
  const res = await fetch(`/${slug}/push/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

async function setupPush() {
  const banner = document.querySelector<HTMLElement>("#push-banner");
  const toggle = document.querySelector<HTMLButtonElement>("#push-toggle");
  const text = document.querySelector<HTMLElement>("#push-text");
  if (!banner || !toggle || !text || !slug || !vapidKey) return;
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("/sw.js");

  if (!("PushManager" in window)) {
    // iOS only exposes push to web apps added to the home screen.
    if (/iPhone|iPad/.test(navigator.userAgent)) {
      text.textContent = "For varsler på iPhone: trykk Del → «Legg til på Hjem-skjerm», og åpne appen derfra.";
      toggle.hidden = true;
      banner.hidden = false;
    }
    return;
  }

  const render = (on: boolean) => {
    banner.hidden = false;
    banner.classList.toggle("on", on);
    text.textContent = on ? "Varsler er på for denne enheten." : "Få varsel når en tid du venter på blir ledig eller får en ny kommentar.";
    toggle.textContent = on ? "Skru av" : "Slå på varsler";
  };

  let sub = await reg.pushManager.getSubscription();
  if (sub) await api("subscribe", sub.toJSON()).catch(() => {}); // keep apartment mapping fresh
  render(!!sub && Notification.permission === "granted");

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      if (sub) {
        await api("unsubscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
        sub = null;
        render(false);
      } else {
        if ((await Notification.requestPermission()) !== "granted") {
          text.textContent = "Varsler er blokkert i nettleseren. Endre det i nettleserinnstillingene.";
          return;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(vapidKey),
        });
        await api("subscribe", sub.toJSON());
        await api("test", { endpoint: sub.endpoint });
        render(true);
      }
    } catch (err) {
      console.error(err);
      text.textContent = "Noe gikk galt med varsler. Prøv igjen senere.";
    } finally {
      toggle.disabled = false;
    }
  });
}

void setupPush().catch(() => {});
if (isBoard()) history.replaceState(null, "", cleanUrl(location.href));
