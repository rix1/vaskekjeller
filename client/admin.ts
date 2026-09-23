// Admin page enhancements. Every form and link here also works without JavaScript:
// dialogs fall back to `:target`, and inline machine forms fall back to ordinary posts.
export {};

const drawerQuery = matchMedia("(max-width: 740px)");
const live = document.createElement("div");
live.className = "sr-only";
live.setAttribute("aria-live", "polite");
document.body.append(live);

// Drop the one-time status code so reloading doesn't repeat the message.
const current = new URL(location.href);
if (current.searchParams.has("m")) {
  current.searchParams.delete("m");
  history.replaceState(null, "", current);
}

// ---------------------------------------------------------------------------
// Dialogs: centered modal on desktop, bottom drawer on phones
// ---------------------------------------------------------------------------

function openDialog(dialog: HTMLDialogElement) {
  if (dialog.open) dialog.close();
  dialog.style.transform = "";
  dialog.showModal();
  const field =
    dialog.querySelector<HTMLElement>("[aria-invalid='true']") ??
    dialog.querySelector<HTMLElement>("input:not([type='hidden']):not([hidden])");
  // A drawer that pops the keyboard immediately hides half of itself; only autofocus on desktop.
  if (field && (!drawerQuery.matches || field.getAttribute("aria-invalid"))) field.focus();
  else if (!drawerQuery.matches) dialog.querySelector<HTMLElement>(".sheet-actions > *")?.focus();
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const opener = event.target.closest<HTMLElement>("[data-dialog]");
  const dialog = opener && document.getElementById(opener.dataset.dialog!);
  if (dialog instanceof HTMLDialogElement) {
    event.preventDefault();
    openDialog(dialog);
    return;
  }
  const close = event.target.closest("[data-dialog-close]");
  if (close) {
    event.preventDefault();
    close.closest("dialog")?.close();
    return;
  }
  // Clicking the backdrop closes the dialog; the panel fills the dialog box itself.
  if (event.target instanceof HTMLDialogElement && event.target.classList.contains("sheet")) {
    const box = event.target.getBoundingClientRect();
    const { clientX: x, clientY: y } = event as MouseEvent;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) event.target.close();
  }
});

// Server-rendered dialogs (validation errors) and `#dialog` links reopen as real modals.
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet[data-autoshow]")) openDialog(dialog);
const targeted = location.hash && document.getElementById(location.hash.slice(1));
if (targeted instanceof HTMLDialogElement) {
  history.replaceState(null, "", location.pathname + location.search);
  openDialog(targeted);
}

// A card that failed validation: bring its first marked field into view.
const invalid = document.querySelector<HTMLElement>(".admin-stack [aria-invalid='true']");
if (invalid) {
  invalid.scrollIntoView({ block: "center" });
  invalid.focus({ preventScroll: true });
}

// Links styled as switches open a dialog; give them the Space key a switch implies.
document.addEventListener("keydown", (event) => {
  if (event.key !== " " || !(event.target instanceof HTMLAnchorElement) || event.target.getAttribute("role") !== "switch") return;
  event.preventDefault();
  event.target.click();
});

// Drag a drawer down to dismiss it, like a native sheet.
document.addEventListener("pointerdown", (event) => {
  if (!drawerQuery.matches || !(event.target instanceof Element) || event.target.closest("a, button, input, select, textarea")) return;
  const handle = event.target.closest(".sheet-handle, .sheet-head");
  const dialog = handle?.closest<HTMLDialogElement>("dialog.sheet[open]");
  if (!handle || !dialog) return;
  const startY = event.clientY;
  const startTime = performance.now();
  let dy = 0;
  dialog.classList.add("dragging");
  (handle as HTMLElement).setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    const raw = e.clientY - startY;
    // Resist dragging upwards past the resting position.
    dy = raw < 0 ? -Math.sqrt(-raw) * 2 : raw;
    dialog.style.transform = `translateY(${dy}px)`;
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    handle.removeEventListener("pointermove", move as EventListener);
    handle.removeEventListener("pointerup", end as EventListener);
    handle.removeEventListener("pointercancel", end as EventListener);
    dialog.classList.remove("dragging");
    const velocity = dy / (performance.now() - startTime);
    if (dy > dialog.offsetHeight * 0.3 || (dy > 20 && velocity > 0.5)) dialog.close();
    // Let the transition run from where the finger left it.
    requestAnimationFrame(() => (dialog.style.transform = ""));
  };
  handle.addEventListener("pointermove", move as EventListener);
  handle.addEventListener("pointerup", end as EventListener);
  handle.addEventListener("pointercancel", end as EventListener);
});

// ---------------------------------------------------------------------------
// Machines: reorder, switch on/off and rename in place
// ---------------------------------------------------------------------------

let pending: AbortController | undefined;

async function updateMachines(form: HTMLFormElement, submitter: HTMLElement | null) {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const section = document.getElementById("maskiner")!;
  section.setAttribute("aria-busy", "true");
  const focusKey = submitter?.dataset.focusKey;
  try {
    const res = await fetch(form.action, {
      method: "POST",
      body: new URLSearchParams([...new FormData(form)].map(([k, v]) => [k, String(v)])),
      signal: controller.signal,
      headers: { "X-Requested-With": "Vaskekjeller" },
    });
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const next = doc.getElementById("maskiner");
    if (!next) {
      location.assign(res.url);
      return;
    }
    // Keep whatever the admin is doing now: focus, and unsaved text in another row.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeKey = section.contains(active) ? active?.dataset.focusKey : undefined;
    section.replaceWith(next);
    tocObserver?.observe(next);
    const restore = (key: string | undefined) => (key ? next.querySelector<HTMLElement>(`[data-focus-key="${key}"]`) : null);
    let target = restore(activeKey) ?? restore(focusKey);
    if (target instanceof HTMLButtonElement && target.disabled) {
      // A machine moved to the top or bottom: its other arrow is the natural next stop.
      target = restore(target.dataset.focusKey!.replace(/^(up|down)/, (d) => (d === "up" ? "down" : "up")));
    }
    if (
      active instanceof HTMLInputElement &&
      target instanceof HTMLInputElement &&
      active.value !== active.defaultValue &&
      active.form !== form
    ) {
      target.value = active.value;
    }
    target?.focus({ preventScroll: true });
    const machineId = form.id.replace("machine-", "");
    if (form.hasAttribute("data-autosave") && res.ok) {
      const note = next.querySelector<HTMLElement>(`#maskin-${machineId} [data-saved-note]`);
      if (note) note.textContent = "Lagret";
    }
    // The page-level message would be out of view; announce it and drop any stale one.
    document.querySelector(".admin-main > .flash")?.remove();
    live.textContent = doc.querySelector(".admin-main > .flash")?.textContent ?? "";
  } catch {
    if (controller.signal.aborted) return;
    live.textContent = "Kunne ikke lagre. Prøver på nytt uten hurtigoppdatering.";
    HTMLFormElement.prototype.submit.call(form);
  } finally {
    if (pending === controller) document.getElementById("maskiner")?.removeAttribute("aria-busy");
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return;
  if (!form.hasAttribute("data-inline") && !form.hasAttribute("data-autosave")) return;
  event.preventDefault();
  const submitter = event.submitter instanceof HTMLElement ? event.submitter : null;
  // Flip the switch right away; the server response confirms it.
  if (submitter?.getAttribute("role") === "switch")
    submitter.setAttribute("aria-checked", submitter.getAttribute("aria-checked") === "true" ? "false" : "true");
  void updateMachines(form, submitter);
});

// Name and type save as soon as they change; Enter in the name field saves too.
document.addEventListener("change", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  if (field.form?.hasAttribute("data-autosave")) field.form.requestSubmit();
});

// ---------------------------------------------------------------------------
// Live previews for the schedule and the apartment list
// ---------------------------------------------------------------------------

// Mirrors schedulePreview in src/admin-views.tsx.
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const hour = (min: number) => (min % 60 === 0 ? pad(min / 60) : clock(min));
const parseClock = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function schedulePreview(start: number | null, end: number | null, slot: number): string {
  if (start === null || end === null || start >= end) return "Velg når første tid starter og siste tid slutter.";
  const slots: [number, number][] = [];
  for (let s = start; s + slot <= end; s += slot) slots.push([s, s + slot]);
  if (!slots.length) return "Ingen tider får plass. Velg en kortere lengde eller lengre åpningstid.";
  const shown = slots.length > 6 ? [...slots.slice(0, 5), null, slots.at(-1)!] : slots;
  const list = shown.map((s) => (s ? `${hour(s[0])}–${hour(s[1])}` : "…")).join(", ");
  const rest = end - slots.at(-1)![1];
  return `${slots.length} ${slots.length === 1 ? "tid" : "tider"} per dag: ${list}.${rest ? ` De siste ${rest} min før ${clock(end)} blir ikke brukt.` : ""}`;
}

document.addEventListener("input", (event) => {
  if (!(event.target instanceof Element)) return;
  const schedule = event.target.closest<HTMLFormElement>("form[data-schedule]");
  if (schedule) {
    const value = (name: string) => (schedule.elements.namedItem(name) as HTMLInputElement | RadioNodeList | null)?.value ?? "";
    const preview = document.getElementById("slot-preview");
    if (preview)
      preview.textContent = schedulePreview(parseClock(value("day_start")), parseClock(value("day_end")), Number(value("slot_min")));
  }
  if (event.target instanceof HTMLTextAreaElement && event.target.closest("form[data-apartments]")) {
    // Mirrors apartmentSummary in src/admin-views.tsx.
    const all = event.target.value
      .split(/[\n,]/)
      .map((s) => s.trim().toUpperCase().replace(/\s+/g, ""))
      .filter(Boolean);
    const unique = [...new Set(all)];
    const duplicates = unique.filter((a) => all.indexOf(a) !== all.lastIndexOf(a));
    const count = document.querySelector("[data-apartment-count]");
    const dupes = document.querySelector<HTMLElement>("[data-apartment-duplicates]");
    if (count)
      count.textContent = unique.length
        ? `${unique.length} ${unique.length === 1 ? "leilighet" : "leiligheter"}`
        : "Ingen liste – alle numre er tillatt";
    if (dupes) {
      dupes.hidden = !duplicates.length;
      dupes.textContent = duplicates.length ? `Duplikater: ${duplicates.join(", ")}. De slås sammen når du lagrer.` : "";
    }
  }
});

// ---------------------------------------------------------------------------
// Resident password: copy to clipboard
// ---------------------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  let reset: number | undefined;
  button.addEventListener("click", async () => {
    const label = button.querySelector("[data-copy-label]")!;
    try {
      await navigator.clipboard.writeText(document.querySelector(".secret-plain")?.textContent ?? "");
      label.textContent = "Kopiert";
    } catch {
      label.textContent = "Kunne ikke kopiere";
    }
    live.textContent = label.textContent;
    clearTimeout(reset);
    reset = setTimeout(() => (label.textContent = "Kopier"), 2000);
  });
}

// ---------------------------------------------------------------------------
// Table of contents: mark the section in view
// ---------------------------------------------------------------------------

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>(".toc a")];
const tocObserver =
  tocLinks.length && "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            for (const link of tocLinks) {
              if (link.hash === `#${entry.target.id}`) link.setAttribute("aria-current", "true");
              else link.removeAttribute("aria-current");
            }
          }
        },
        { rootMargin: "-20% 0px -70% 0px" },
      )
    : undefined;
for (const link of tocLinks) {
  const section = document.getElementById(link.hash.slice(1));
  if (section) tocObserver?.observe(section);
}
// The last section can be too short to reach the observed band; mark it at the bottom of the page.
addEventListener(
  "scroll",
  () => {
    if (!tocLinks.length || innerHeight + scrollY < document.documentElement.scrollHeight - 2) return;
    for (const link of tocLinks) link.toggleAttribute("aria-current", link === tocLinks.at(-1));
  },
  { passive: true },
);
