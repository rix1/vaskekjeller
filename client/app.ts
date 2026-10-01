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

// Toasts arrive server-rendered (CSS timers keep them working without JavaScript). Here they become Sonner
// toasts (client/toaster.ts, loaded on the first one), which handles stacking, timing, hover and swipe.
// A repeated message updates the toast already on screen instead of adding another.
const NETWORK_ERROR = "network-error";
const BOOKING_TOAST_MS = 5000;
let announceTimer: ReturnType<typeof setTimeout> | undefined;
function announce(text: string) {
  clearTimeout(announceTimer);
  live.textContent = "";
  announceTimer = setTimeout(() => (live.textContent = text), 500);
}

// Mirrors client/toaster.ts, which is bundled on its own (scripts/build-toaster.ts) and so not imported here.
type Notice = {
  id: string;
  tone: "success" | "error";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
  duration?: number;
};
type Toaster = { notify(notice: Notice): void; dismissNotice(id: string): void };
const toasterUrl: string = "/toaster.js";
let toaster: Promise<Toaster> | undefined;
// Angre's booking ids by toast id: it only applies while all of them are still listed under "Dine tider".
const undoable = new Map<string, string[]>();

function notify(notice: Notice) {
  void (toaster ??= import(toasterUrl) as Promise<Toaster>).then((t) => t.notify(notice));
}

function clientToast(tone: "success" | "error", title: string, id = title) {
  notify({ id, tone, title });
}

function showToast(toast: HTMLElement) {
  const text = (selector: string) => toast.querySelector(selector)?.textContent?.trim() || undefined;
  const title = text(".toast-title") ?? "";
  const detail = text(".toast-detail");
  const id = `${title} ${detail ?? ""}`.trim();
  const form = toast.querySelector<HTMLFormElement>(".toast-action");
  toast.remove();
  const action = form
    ? {
        label: form.querySelector("button")?.textContent?.trim() ?? "",
        // The form stays in the page, hidden, so the usual submit handling (in-page update) takes it from here.
        run: () => form.requestSubmit(),
      }
    : undefined;
  if (form) {
    form.hidden = true;
    document.body.append(form);
    const ids = form.querySelector<HTMLInputElement>('[name="booking_ids"]')?.value;
    if (ids) undoable.set(id, ids.split(","));
  }
  notify({
    id,
    tone: toast.classList.contains("error") ? "error" : "success",
    title,
    detail,
    action,
    duration: toast.classList.contains("long") ? BOOKING_TOAST_MS : undefined,
  });
}

function dismissToast(id: string) {
  undoable.delete(id);
  void toaster?.then((t) => t.dismissNotice(id));
}

// Hide the server-rendered copies at once, so they do not show while Sonner loads.
document.querySelectorAll<HTMLElement>(".toaster .toast").forEach(showToast);
// Other page scripts (client/admin.ts) hand over toasts from pages they fetch.
document.addEventListener("vk:toast", (event) => showToast((event as CustomEvent<HTMLElement>).detail));

function cleanUrl(raw: string) {
  const url = new URL(raw, location.href);
  url.searchParams.delete("m");
  url.searchParams.delete("reservation");
  url.searchParams.delete("note");
  url.searchParams.delete("messaged");
  return url;
}

// On phones the Monday-first week scrolls sideways (public/style.css). Put the selected day's
// neighbour at the start, so Sunday leaves the strip fully scrolled right. Mirrors SHOW_SELECTED_DAY
// in src/views.tsx, which does the same before the first paint.
function showSelectedDay(strip: HTMLElement, onlyIfHidden: boolean) {
  const selected = strip.querySelector<HTMLElement>(".selected");
  if (!selected) return;
  const stripBounds = strip.getBoundingClientRect();
  const dayBounds = selected.getBoundingClientRect();
  if (onlyIfHidden && dayBounds.left >= stripBounds.left - 1 && dayBounds.right <= stripBounds.right + 1) return;
  const start = (selected.previousElementSibling ?? selected).getBoundingClientRect().left;
  const smooth = onlyIfHidden && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  strip.scrollTo({ left: strip.scrollLeft + start - stripBounds.left, behavior: smooth ? "smooth" : "instant" });
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
    const oldStrip = main.querySelector<HTMLElement>(".date-strip");
    const oldWeek = oldStrip?.querySelector("[data-date]")?.getAttribute("data-date");
    const dateScroll = oldStrip?.scrollLeft ?? 0;
    main.replaceWith(nextMain);
    const dateStrip = nextMain.querySelector<HTMLElement>(".date-strip");
    if (dateStrip) {
      // Same week: stay put and only move when the selected day is not fully in view.
      if (dateStrip.querySelector("[data-date]")?.getAttribute("data-date") === oldWeek) {
        dateStrip.scrollLeft = dateScroll;
        showSelectedDay(dateStrip, true);
      } else showSelectedDay(dateStrip, false);
    }
    dismissToast(NETWORK_ERROR);
    // Angre only applies while all of its bookings are still listed under "Dine tider".
    for (const [id, bookings] of undoable) {
      if (bookings.some((booking) => !nextMain.querySelector(`#reservation-${booking}`))) dismissToast(id);
    }
    const toasts = [...doc.querySelectorAll<HTMLElement>(".toaster .toast")];
    toasts.forEach(showToast);
    if (!toasts.length)
      announce(`${nextMain.querySelector(".day-heading h3")?.textContent}. ${nextMain.querySelector(".machine-options .selected")?.textContent}.`);
    // Keep keyboard focus on the selected control after it has been replaced.
    if (options.focusHref) {
      const matching = [...nextMain.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.href === options.focusHref);
      const focusTarget = matching ?? nextMain.querySelector<HTMLElement>(".apt-picker input, .apt-picker select");
      focusTarget?.focus({ preventScroll: true });
    } else if (options.form?.closest(".apartment-menu") && nextHeader.querySelector(".apartment-menu[open]")) {
      // Calendar settings keep the popover open; stay on the control that was used.
      const same = [...nextHeader.querySelectorAll("form")].find((f) => f.action === options.form!.action);
      same?.querySelector("button")?.focus({ preventScroll: true });
    } else if (options.form) {
      // Toasts never take focus; return it to the day that was just updated.
      const focus = nextMain.querySelector<HTMLElement>(".day-heading h3");
      focus?.setAttribute("tabindex", "-1");
      focus?.focus({ preventScroll: true });
    }
    void setupPush().catch(() => {});
  } catch (error) {
    if (controller.signal.aborted) return;
    const menu = document.querySelector<HTMLDetailsElement>(".apartment-menu[open]");
    if (menu) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
    main.querySelectorAll(".date-item, .machine-options a").forEach((el) => {
      el.classList.toggle("selected", el.hasAttribute("aria-current"));
    });
    clientToast(
      "error",
      options.form
        ? "Vi kunne ikke bekrefte endringen. Oppdater siden for å se om den ble lagret."
        : "Kunne ikke hente tidene. Sjekk forbindelsen og prøv igjen.",
      NETWORK_ERROR,
    );
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
  for (const details of document.querySelectorAll<HTMLDetailsElement>(".slot-details[open], .apartment-menu[open]")) {
    if (!details.contains(event.target)) details.open = false;
  }
  // "Nei" in a confirmation popover reloads the page without JS; here it just closes.
  const close = event.target.closest<HTMLElement>(".slot-details [data-close]");
  if (close) {
    event.preventDefault();
    const details = close.closest("details")!;
    details.open = false;
    details.querySelector("summary")?.focus();
    return;
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
  const details =
    event.target.closest<HTMLDetailsElement>(".slot-details, .apartment-menu") ??
    document.querySelector<HTMLDetailsElement>(".apartment-menu[open]");
  if (details) {
    details.open = false;
    details.querySelector("summary")?.focus();
  }
});

// Web push: the waitlist banner, the board's reminder card and the onboarding guide (/velkommen) share one switch.
const ua = navigator.userAgent;
// iPadOS reports itself as a Mac; the touch points give it away.
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
// Links opened inside Facebook, Messenger, Instagram and the like can't be added to the Home Screen from there.
const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Messenger|Snapchat|Line\/|LinkedInApp|MicroMessenger|GSA\//.test(ua);
const standalone =
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iOS only exposes push to web apps opened from the Home Screen.
const needsInstall = isIOS && !standalone;
const canPush = !needsInstall && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const NUDGE_KEY = "vk-nudge-dismissed";

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

let registration: Promise<ServiceWorkerRegistration> | undefined;
const pushRegistration = () => (registration ??= navigator.serviceWorker.register("/sw.js"));

/** This device's subscription, or null when notifications are off or impossible here. */
async function currentSubscription() {
  if (!canPush) return null;
  const sub = await (await pushRegistration()).pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? sub : null;
}

// Runs from a click: iOS only shows the permission prompt during a user gesture, so nothing is awaited first.
async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") {
    clientToast("error", "Varsler er blokkert i nettleseren. Endre det i nettleserinnstillingene.");
    return;
  }
  const reg = await pushRegistration();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(vapidKey!) });
  await api("subscribe", sub.toJSON());
  await api("test", { endpoint: sub.endpoint });
  clientToast("success", "Varsler er på for denne enheten.");
}

async function disablePush() {
  const sub = canPush ? await (await pushRegistration()).pushManager.getSubscription() : null;
  if (!sub) return;
  await api("unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

function nudgeDismissed() {
  try {
    return localStorage.getItem(NUDGE_KEY) === "1";
  } catch {
    return false;
  }
}

function showOnly(root: ParentNode, attribute: string, value: string | undefined) {
  root.querySelectorAll<HTMLElement>(`[data-${attribute}]`).forEach((el) => {
    el.hidden = el.getAttribute(`data-${attribute}`) !== value;
  });
}

/** Brings every push control on the page in line with this device; runs on load and after each board update. */
async function setupPush(initial = false) {
  const banner = document.querySelector<HTMLElement>("#push-banner");
  const nudge = document.querySelector<HTMLElement>("#home-nudge");
  const onboarding = document.querySelector<HTMLElement>("#onboarding[data-ready]");
  if (!slug || !vapidKey || !(banner || nudge || onboarding)) return;
  if ("serviceWorker" in navigator) void pushRegistration();
  const sub = await currentSubscription();
  if (sub) await api("subscribe", sub.toJSON()).catch(() => {}); // keep apartment mapping fresh

  if (onboarding) {
    // Opened from the Home Screen with notifications already on: nothing left to set up.
    if (initial && standalone && sub) {
      location.replace(`/${slug}`);
      return;
    }
    const device = standalone ? "installed" : inAppBrowser ? "inapp" : isIOS ? "ios" : isAndroid ? "android" : "desktop";
    const state = sub
      ? "on"
      : needsInstall
        ? "needs-install"
        : !canPush
          ? "unsupported"
          : Notification.permission === "denied"
          ? "blocked"
          : "ready";
    showOnly(onboarding, "device", device);
    showOnly(onboarding, "push-state", state);
    const install = onboarding.querySelector<HTMLElement>('[data-step="install"]');
    const push = onboarding.querySelector<HTMLElement>('[data-step="push"]');
    // A step that can't apply on this device is left out, not shown disabled; the numbering follows.
    if (install) {
      install.hidden = device === "installed" || device === "desktop";
      install.className = "current";
    }
    if (push) push.hidden = state === "unsupported";
    if (push) push.className = state === "on" ? "done" : state === "needs-install" ? "upcoming" : "current";
    // Until notifications are on (or can't be), the way out is a quiet skip link.
    const done = state === "on" || state === "unsupported" || state === "blocked";
    showOnly(onboarding, "when", done ? "done" : "pending");
  }

  if (nudge) {
    let kind: "install" | "push" | undefined;
    // The waitlist banner already asks, so the card stays away while it is shown.
    if (!nudgeDismissed() && !banner) {
      if (needsInstall) kind = "install";
      else if (canPush && !sub && Notification.permission === "default") kind = "push";
    }
    nudge.hidden = !kind;
    showOnly(nudge, "nudge", kind);
  }

  const toggle = banner?.querySelector<HTMLButtonElement>("#push-toggle");
  const text = banner?.querySelector<HTMLElement>("#push-text");
  if (!banner || !toggle || !text) return;
  if (!canPush) {
    if (needsInstall) {
      text.textContent = "For varsler på iPhone må Vaskekjeller ligge på Hjem-skjermen. ";
      const link = document.createElement("a");
      link.href = `/${slug}/velkommen`;
      link.textContent = "Vis meg hvordan";
      text.append(link);
      toggle.hidden = true;
      banner.hidden = false;
    }
    return;
  }
  banner.hidden = false;
  banner.classList.toggle("on", !!sub);
  text.textContent = sub ? "Varsler er på." : "Få varsel når en tid du venter på blir ledig eller får en ny kommentar.";
  toggle.textContent = sub ? "Skru av" : "Slå på varsler";
  toggle.dataset.pushAction = sub ? "off" : "on";
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-push-action]") : null;
  if (!target) return;
  if (target.dataset.pushAction === "dismiss") {
    try {
      localStorage.setItem(NUDGE_KEY, "1");
    } catch {
      // Private mode or blocked storage: the card just comes back next time.
    }
    target.closest<HTMLElement>("#home-nudge")?.setAttribute("hidden", "");
    return;
  }
  if (!(target instanceof HTMLButtonElement) || target.disabled) return;
  target.disabled = true;
  try {
    if (target.dataset.pushAction === "off") await disablePush();
    else await enablePush();
    await setupPush();
  } catch (err) {
    console.error(err);
    clientToast("error", "Noe gikk galt med varsler. Prøv igjen senere.");
  } finally {
    target.disabled = false;
  }
});

// Android: Chrome's own install prompt behind a button in the guide, instead of its banner.
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPrompt | undefined;
addEventListener("beforeinstallprompt", (event) => {
  const onboarding = document.querySelector("#onboarding");
  if (!onboarding) return;
  event.preventDefault();
  installPrompt = event as InstallPrompt;
  onboarding.querySelector<HTMLElement>("[data-install]")?.removeAttribute("hidden");
  onboarding.querySelector<HTMLElement>("[data-install-manual]")?.setAttribute("hidden", "");
});
addEventListener("appinstalled", () => {
  const onboarding = document.querySelector("#onboarding");
  if (!onboarding) return;
  onboarding.querySelector('[data-step="install"]')?.setAttribute("class", "done");
  onboarding.querySelector("[data-install]")?.setAttribute("hidden", "");
});
document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const install = target?.closest<HTMLButtonElement>("[data-install]");
  if (install && installPrompt) {
    const pending = installPrompt;
    installPrompt = undefined;
    await pending.prompt();
    if ((await pending.userChoice).outcome !== "accepted") {
      install.hidden = true;
      document.querySelector<HTMLElement>("[data-install-manual]")?.removeAttribute("hidden");
    }
  }
  const copy = target?.closest<HTMLButtonElement>("[data-copy-link]");
  if (copy) {
    const url = `${location.origin}${location.pathname}`;
    navigator.clipboard.writeText(url).then(
      () => (copy.textContent = "Kopiert"),
      () => (copy.textContent = "Kunne ikke kopiere"),
    );
  }
});

void setupPush(true).catch(() => {});
if (isBoard()) history.replaceState(null, "", cleanUrl(location.href));

// Calendar link: a copy button when JS runs; without it the read-only field is still selectable.
document.documentElement.classList.add("js");
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".calendar-link [data-copy]") : null;
  const input = button && document.querySelector<HTMLInputElement>(button.dataset.copy!);
  if (!button || !input) return;
  const done = (text: string) => {
    button.textContent = text;
    setTimeout(() => button.isConnected && (button.textContent = "Kopier"), 2000);
  };
  navigator.clipboard.writeText(input.value).then(
    () => done("Kopiert"),
    () => {
      input.select();
      done("Merket");
    },
  );
});
document.addEventListener("focusin", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches(".calendar-link input")) event.target.select();
});
