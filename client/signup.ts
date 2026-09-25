// Signup flow enhancements. Every step also works as a plain form without JavaScript,
// except the Turnstile bot check, which needs it wherever it is switched on.
export {};

// ---------------------------------------------------------------------------
// Web address: live availability while typing
// ---------------------------------------------------------------------------

const slugInput = document.querySelector<HTMLInputElement>("input[data-slug-check]");
const slugStatus = document.querySelector<HTMLElement>("[data-slug-status], .slug-status");
if (slugInput && slugStatus) {
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (state: "free" | "taken" | "checking", message: string) => {
    slugStatus.dataset.slugStatus = state;
    slugStatus.textContent = message;
    slugInput.setCustomValidity(state === "taken" ? message : "");
    if (state === "taken") slugInput.setAttribute("aria-invalid", "true");
    else slugInput.removeAttribute("aria-invalid");
  };
  const check = async () => {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      const res = await fetch(`${slugInput.dataset.slugCheck}?adresse=${encodeURIComponent(slugInput.value)}`, { signal: controller.signal });
      const { free, message } = (await res.json()) as { free: boolean; message: string };
      show(free ? "free" : "taken", message);
    } catch {
      // Aborted by a newer keystroke, or offline: the step's own submit checks the address again.
    }
  };
  slugInput.addEventListener("input", () => {
    // Addresses are lowercase with dashes; type "Lofotgata 12" and get "lofotgata-12".
    const start = slugInput.selectionStart;
    const cleaned = slugInput.value.toLowerCase().replace(/\s/g, "-");
    if (cleaned !== slugInput.value) {
      slugInput.value = cleaned;
      slugInput.setSelectionRange(start, start);
    }
    // Clear the old verdict right away, so a stale "Ledig." never sits next to a new address.
    show("checking", "Sjekker…");
    clearTimeout(timer);
    timer = setTimeout(check, 250);
  });
  // The server-rendered error stays until the address is changed.
  if (slugInput.getAttribute("aria-invalid") === "true") slugInput.setCustomValidity(document.getElementById("adresse-error")?.textContent ?? "");
}

// ---------------------------------------------------------------------------
// Submitting: one request at a time, and wait for the invisible bot check if it isn't done yet
// ---------------------------------------------------------------------------

const turnstileForm = document.querySelector<HTMLFormElement>("form[data-turnstile-form]");
const turnstileStatus = document.querySelector<HTMLElement>("[data-turnstile-status]");
const TOKEN_WAIT_MS = 20_000;

// The widget (Turnstile's own script, loaded async) fills this hidden field. Polling it avoids
// depending on which of the two scripts runs first, as a named callback would.
function submitWhenToken(form: HTMLFormElement, button: HTMLButtonElement | null) {
  const started = Date.now();
  const tick = () => {
    if (form.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']")?.value) {
      button?.removeAttribute("aria-disabled");
      form.requestSubmit();
    } else if (Date.now() - started > TOKEN_WAIT_MS) {
      button?.removeAttribute("aria-disabled");
      if (turnstileStatus) turnstileStatus.textContent = "Vi fikk ikke sjekket at du ikke er en robot. Last inn siden på nytt og prøv igjen.";
    } else setTimeout(tick, 150);
  };
  tick();
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.closest(".signup-main")) return;
  const button = form.querySelector<HTMLButtonElement>("button.signup-next");
  if (button?.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
    return;
  }
  const token = form.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']");
  if (form === turnstileForm && !token?.value) {
    // The token normally arrives before the passwords are typed; if not, submit when it does.
    event.preventDefault();
    if (turnstileStatus) turnstileStatus.textContent = "Sjekker at du ikke er en robot…";
    button?.setAttribute("aria-disabled", "true");
    submitWhenToken(form, button);
    return;
  }
  button?.setAttribute("aria-disabled", "true");
});
// Back/forward cache: a restored page must not keep a busy button.
addEventListener("pageshow", () => {
  for (const button of document.querySelectorAll("button.signup-next[aria-disabled]")) button.removeAttribute("aria-disabled");
});

// ---------------------------------------------------------------------------
// Machines: − and + beside the number fields
// ---------------------------------------------------------------------------

for (const stepper of document.querySelectorAll<HTMLElement>("[data-stepper]")) {
  const input = stepper.querySelector("input")!;
  const buttons = [...stepper.querySelectorAll<HTMLButtonElement>("button[data-step]")];
  const sync = () => {
    const value = Number(input.value);
    for (const b of buttons) b.disabled = Number(b.dataset.step) < 0 ? value <= Number(input.min) : value >= Number(input.max);
  };
  for (const b of buttons) {
    b.hidden = false;
    b.addEventListener("click", () => {
      const next = Math.min(Number(input.max), Math.max(Number(input.min), (Number(input.value) || 0) + Number(b.dataset.step)));
      input.value = String(next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      sync();
    });
  }
  input.addEventListener("input", sync);
  stepper.classList.add("enhanced");
  sync();
}

// ---------------------------------------------------------------------------
// Resident password: show the field only when "Ja" is chosen
// ---------------------------------------------------------------------------

const choice = document.querySelector<HTMLFormElement>("form[data-resident-choice]");
const reveal = choice?.querySelector<HTMLElement>("[data-when-password]");
if (choice && reveal) {
  const field = reveal.querySelector("input")!;
  const update = (focus: boolean) => {
    const on = (choice.elements.namedItem("passord") as RadioNodeList).value === "ja";
    reveal.classList.toggle("collapsed", !on);
    reveal.inert = !on;
    field.required = on;
    if (on && focus) field.focus({ preventScroll: true });
  };
  choice.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "passord") update(true);
  });
  update(false);
}
