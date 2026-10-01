// First-use tips on the board: a few small coach marks, one at a time and at most one per page view, each pinned to
// the control it explains and triggered by what the resident just did. They never block (no backdrop, the target
// stays tappable), never show over a toast, popover, soft keyboard or hidden tab, and never move focus.
// The server renders `data-tour` anchors and `main[data-tips]` (src/views.tsx); client/app.ts announces each new or
// updated board with a "vk:board" event. Without JavaScript there are no marks and nothing else changes.
export {};

type TipId = "book" | "manage" | "machines";
type State = {
  v: 1;
  /** Tips the resident has dismissed or acted on. */
  seen: TipId[];
  /** Page views each tip has been shown in; a tip that was shown twice and ignored is retired too. */
  shown: Partial<Record<TipId, number>>;
  /** "Ikke vis flere tips": every tip off. */
  off: boolean;
  /** The notification ask under "Dine tider" was closed with its ×. */
  askOff: boolean;
  /** When a tip was last shown, to tell "a later session" from the one that started the tour. */
  last?: { day: string; sid?: string };
};

const STORAGE_KEY = "vk-tips";
const SESSION_KEY = "vk-tips-session";
const LEGACY_NUDGE_KEY = "vk-nudge-dismissed";
const SETTLE_MS = 600;
const POLL_MS = 500;
const MAX_POLLS = 120;
const MAX_VIEWS = 2;
/** Keeps clear of the bottom edge, where toasts appear. */
const BOTTOM_RESERVE = 72;
const GAP = 10;
const EDGE = 12;

const ORDER: TipId[] = ["book", "manage", "machines"];
const TIPS: Record<TipId, { targets: string[]; title: string; body: (target: HTMLElement) => string }> = {
  book: {
    targets: ['[data-tour="book"]'],
    title: "Ett trykk, så er tiden din.",
    body: (target) => {
      const machines = Number(target.dataset.tourMachines);
      const together = machines === 2 ? "Begge maskinene følger med. " : machines > 2 ? "Alle maskinene følger med. " : "";
      return `${together}Du kan avbestille etterpå.`;
    },
  },
  manage: {
    // The resident's own row in the schedule; on a phone or without one on this day, "Dine tider" itself.
    targets: ['[data-tour="manage"]', '[data-tour="manage-bar"]', '[data-tour="manage-card"]'],
    title: "Her er tiden din.",
    body: () => "Trykk på tiden din. Endrer planene seg? Avbestill, så blir den ledig for naboene. Du kan også legge den i kalenderen.",
  },
  machines: {
    targets: ['[data-tour="machines"]'],
    title: "Trenger du bare vask eller tørk?",
    body: () => "Velg bare vaskemaskinen eller bare tørketrommelen her.",
  },
};

// --- State: one localStorage key for the whole site; memory (and sessionStorage) when storage is unavailable ---

let memory: State | undefined;

function readStored(): string | null {
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const value = window[area].getItem(STORAGE_KEY);
      if (value) return value;
    } catch {
      // Blocked storage (private mode, cookies off): try the next place.
    }
  }
  return null;
}

function parse(text: string | null): State | undefined {
  if (!text) return;
  try {
    const value = JSON.parse(text) as Partial<State>;
    if (value.v !== 1 || !Array.isArray(value.seen)) return;
    return { v: 1, seen: value.seen, shown: value.shown ?? {}, off: !!value.off, askOff: !!value.askOff, last: value.last };
  } catch {
    return;
  }
}

function save(next: State) {
  memory = next;
  const text = JSON.stringify(next);
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      window[area].setItem(STORAGE_KEY, text);
      return;
    } catch {
      // Fall through to the next place; the in-memory copy keeps this page view consistent.
    }
  }
}

function legacyNudgeDismissed() {
  try {
    return localStorage.getItem(LEGACY_NUDGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The first board view on a device starts the tour, unless the device has booked before: those residents know the app. */
function load(booked: boolean): State {
  const stored = parse(readStored());
  if (stored) return (memory = stored);
  const created: State = { v: 1, seen: [], shown: {}, off: booked, askOff: legacyNudgeDismissed() };
  save(created);
  return created;
}

function sessionId(): string | undefined {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) sessionStorage.setItem(SESSION_KEY, (id = Math.random().toString(36).slice(2)));
    return id;
  } catch {
    return undefined;
  }
}

const today = () => new Date().toLocaleDateString("sv-SE");

// --- Which tip, where ---

type Current = { id: TipId; target: HTMLElement; counted: boolean; scrolled?: boolean };
let state: State | undefined;
let current: Current | undefined;
let mark: HTMLElement | undefined;
/** Reopened from the menu: walk through every tip that has an anchor, whatever the triggers say. */
let queue: TipId[] | undefined;
let viewDone = false;
let holdUntil = 0;
let polls = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const main = () => document.querySelector<HTMLElement>(".resident-main[data-tips]");
const booked = () => main()?.dataset.tips === "booked";
const retired = (id: TipId) => !!state && (state.seen.includes(id) || (state.shown[id] ?? 0) >= MAX_VIEWS);

function laterSession() {
  const last = state?.last;
  if (!last) return false;
  const sid = sessionId();
  return last.day !== today() || (!!sid && !!last.sid && last.sid !== sid);
}

function wanted(id: TipId) {
  if (!state || state.off) return false;
  if (id === "book") return !booked() && !retired("book");
  if (id === "manage") return booked() && !retired("manage");
  // Machines are for a later session, so a first session never shows more than two tips.
  return booked() && retired("manage") && laterSession() && !retired("machines");
}

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/** The first anchor for the tip that is on screen; failing that the first one that is drawn at all (a walk-through scrolls to it). */
function findTarget(id: TipId) {
  const viewportHeight = window.visualViewport?.height ?? innerHeight;
  let fallback: HTMLElement | undefined;
  for (const selector of TIPS[id].targets) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.bottom <= viewportHeight - EDGE) return el;
      fallback ??= el;
    }
  }
  return fallback;
}

/** A toast, a popover or sheet, a field being edited (soft keyboard), an update in flight, a hidden tab. */
function blocked() {
  const viewport = window.visualViewport;
  const field = document.activeElement;
  return (
    document.hidden ||
    Date.now() < holdUntil ||
    !!document.querySelector("[data-sonner-toast], .toaster .toast, .slot-details[open], .apartment-menu[open], .resident-main.updating") ||
    (field instanceof HTMLElement && (field.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(field.tagName))) ||
    (!!viewport && viewport.height < innerHeight * 0.75)
  );
}

function choose(): Current | undefined {
  for (const id of queue ?? ORDER) {
    if (!queue && !wanted(id)) continue;
    const target = findTarget(id);
    if (target) return { id, target, counted: !!queue };
  }
}

// --- The mark ---

function build(tip: (typeof TIPS)[TipId], id: TipId, target: HTMLElement) {
  const el = document.createElement("div");
  el.className = "coach";
  el.setAttribute("role", "status");
  const title = document.createElement("strong");
  title.className = "coach-title";
  title.textContent = tip.title;
  const body = document.createElement("p");
  body.className = "coach-body";
  body.textContent = tip.body(target);
  const foot = document.createElement("div");
  foot.className = "coach-foot";
  const step = document.createElement("span");
  step.className = "coach-step";
  step.textContent = `${ORDER.indexOf(id) + 1} av ${ORDER.length}`;
  const off = document.createElement("button");
  off.type = "button";
  off.className = "coach-off";
  off.textContent = "Ikke vis flere tips";
  off.addEventListener("click", () => turnOff());
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "coach-ok";
  ok.textContent = "Skjønner";
  ok.addEventListener("click", () => dismiss());
  foot.append(step, off, ok);
  el.append(title, body, foot);
  return el;
}

/** Puts the mark below the target, or above it when there is no room, in document coordinates. False if neither fits. */
function place() {
  if (!current || !mark) return false;
  const rect = current.target.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height ?? innerHeight;
  // The control itself has to be on screen; otherwise the mark waits until it is.
  if (rect.top < 0 || rect.bottom > viewportHeight - EDGE) return false;
  const width = Math.min(300, document.documentElement.clientWidth - 2 * EDGE);
  mark.style.width = `${width}px`;
  const height = mark.offsetHeight;
  const below = rect.bottom + GAP + height <= viewportHeight - BOTTOM_RESERVE;
  const above = rect.top - GAP - height >= EDGE;
  if (!below && !above) return false;
  // A wide target (a row, a tab bar) is pointed at near its start, a button at its middle.
  const anchor = rect.width > 240 ? rect.left + 48 : rect.left + rect.width / 2;
  const left = Math.max(EDGE, Math.min(anchor - width / 2, document.documentElement.clientWidth - EDGE - width));
  mark.style.left = `${left + scrollX}px`;
  mark.style.top = `${(below ? rect.bottom + GAP : rect.top - GAP - height) + scrollY}px`;
  mark.style.setProperty("--arrow-x", `${Math.max(18, Math.min(anchor - left, width - 18))}px`);
  mark.dataset.placement = below ? "below" : "above";
  return true;
}

function hide() {
  mark?.remove();
  mark = undefined;
  current?.target.classList.remove("coach-target");
}

function show(next: Current) {
  hide();
  current = next;
  mark = build(TIPS[next.id], next.id, next.target);
  mark.style.visibility = "hidden";
  document.body.append(mark);
  if (!place()) {
    // No room around it right now (scrolled): wait until it is on screen. A walk-through the resident asked for
    // brings it into view itself, once.
    hide();
    if (queue && !next.scrolled) {
      next.scrolled = true;
      const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
      next.target.scrollIntoView({ block: "center", behavior: calm ? "instant" : "smooth" });
    }
    return false;
  }
  mark.style.visibility = "";
  next.target.classList.add("coach-target");
  if (!next.counted && state) {
    next.counted = true;
    state.shown[next.id] = (state.shown[next.id] ?? 0) + 1;
    state.last = { day: today(), sid: sessionId() };
    save(state);
  }
  viewDone = true;
  return true;
}

function evaluate() {
  const root = main();
  if (!root) return;
  state ??= load(booked());
  if (current && !current.target.isConnected) {
    hide();
    current = undefined;
  }
  if (current && mark) {
    // Showing: step aside while something else needs the screen, keep pointing otherwise.
    if (blocked()) hide();
    else if (!place()) hide();
    return;
  }
  if (current && !blocked()) {
    show(current);
    return;
  }
  if (current || (viewDone && !queue) || blocked()) return;
  const next = choose();
  if (next) show(next);
  else queue = undefined;
}

/** Keeps checking while a tip is waiting for a toast to leave or its target to scroll into view. */
function tick() {
  clearTimeout(timer);
  if (document.hidden || !state || (state.off && !queue)) return;
  if (!queue && (viewDone ? !current : !ORDER.some(wanted))) return;
  if (++polls > MAX_POLLS && !mark) return;
  evaluate();
  timer = setTimeout(tick, POLL_MS);
}

/** A new board (first load, or after an in-place update): at most one tip, once things have settled. */
function newView(toasts = 0) {
  hide();
  current = undefined;
  viewDone = false;
  polls = 0;
  clearTimeout(timer);
  // Sonner loads on the first toast, so give it time to appear before concluding there is none.
  holdUntil = toasts ? Date.now() + 1500 : 0;
  if (!main()) return;
  state ??= load(booked());
  applyState();
  timer = setTimeout(tick, Math.max(SETTLE_MS, holdUntil - Date.now()));
}

/** The ask under "Dine tider" stays away once closed; the "Tips" menu row only works with this script, so it appears with it. */
function applyState() {
  document.querySelectorAll<HTMLElement>("#push-ask").forEach((el) => el.toggleAttribute("data-dismissed", !!state?.askOff));
  document.querySelectorAll<HTMLElement>("#tips-menu").forEach((el) => (el.hidden = false));
}

// --- Leaving a tip ---

function markSeen(id: TipId) {
  if (!state) return;
  if (!state.seen.includes(id)) state.seen.push(id);
  save(state);
}

/** "Skjønner", Escape, or tapping the target itself. */
function dismiss() {
  if (!current) return;
  const { id } = current;
  hide();
  current = undefined;
  markSeen(id);
  if (queue) {
    queue = queue.slice(queue.indexOf(id) + 1);
    if (!queue.length) queue = undefined;
    viewDone = false;
    polls = 0;
    // The next stop of a walk-through follows at once; if it is not on screen it comes when it is.
    tick();
  }
}

function turnOff() {
  hide();
  current = undefined;
  queue = undefined;
  if (!state) return;
  state.off = true;
  save(state);
}

function reopen() {
  state ??= load(booked());
  state.seen = [];
  state.shown = {};
  state.off = false;
  save(state);
  hide();
  current = undefined;
  queue = [...ORDER];
  viewDone = false;
  polls = 0;
  document.querySelector<HTMLDetailsElement>(".apartment-menu[open]")?.removeAttribute("open");
  tick();
}

// --- Wiring ---

document.addEventListener("vk:board", (event) => newView((event as CustomEvent<{ toasts: number }>).detail?.toasts ?? 0));

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const action = event.target.closest<HTMLElement>("[data-tour-action]")?.dataset.tourAction;
  if (action === "reopen") return reopen();
  if (action === "dismiss-ask") {
    state ??= load(booked());
    state.askOff = true;
    save(state);
    return applyState();
  }
  // Doing what the tip points at counts as having seen it. The page update that follows replaces the target.
  if (current && mark && current.target.contains(event.target)) {
    const { id } = current;
    hide();
    current = undefined;
    markSeen(id);
    queue = undefined;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mark) dismiss();
});

const reevaluate = () => {
  if (document.hidden) return;
  if (mark) place();
  else tick();
};
addEventListener("resize", reevaluate);
window.visualViewport?.addEventListener("resize", reevaluate);
document.addEventListener("visibilitychange", reevaluate);
document.addEventListener("focusout", () => setTimeout(reevaluate, 300));
let scrolling: ReturnType<typeof setTimeout> | undefined;
addEventListener(
  "scroll",
  () => {
    clearTimeout(scrolling);
    scrolling = setTimeout(() => {
      polls = 0;
      reevaluate();
    }, 250);
  },
  { passive: true },
);
// The mark follows its target when the page reflows (images, the day strip, a toast mounting).
if ("ResizeObserver" in window) new ResizeObserver(() => mark && place()).observe(document.body);

// Residents who closed the old notification card, and devices that have booked before, are settled at once.
if (main()) {
  state = load(booked());
  applyState();
}
