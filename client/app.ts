const slug = document.body.dataset.slug;
const vapidKey = document.body.dataset.vapid;

// Booking: ask for an optional comment before submitting. Without JS the form just books directly.
const dialog = document.querySelector<HTMLDialogElement>("#book-dialog");
for (const form of document.querySelectorAll<HTMLFormElement>("form[data-book]")) {
  form.addEventListener("submit", (e) => {
    if (!dialog || form.dataset.confirmed) return;
    e.preventDefault();
    dialog.querySelector("#book-title")!.textContent = `Book ${form.dataset.book}`;
    const input = dialog.querySelector<HTMLInputElement>("input[name=note]")!;
    input.value = "";
    dialog.returnValue = "";
    dialog.showModal();
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "ok") return;
        const note = document.createElement("input");
        note.type = "hidden";
        note.name = "note";
        note.value = input.value;
        form.append(note);
        form.dataset.confirmed = "1";
        form.requestSubmit();
      },
      { once: true },
    );
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-confirm]")) {
  form.addEventListener("submit", (e) => {
    if (!confirm(form.dataset.confirm)) e.preventDefault();
  });
}

// Web push
const banner = document.querySelector<HTMLElement>("#push-banner");
const toggle = document.querySelector<HTMLButtonElement>("#push-toggle");
const text = document.querySelector<HTMLElement>("#push-text");

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
    text.textContent = on ? "Varsler er på for denne enheten." : "Få varsel når en tid du venter på blir ledig.";
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
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(vapidKey) });
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

setupPush();

// Remove the ?m= flash param so a reload doesn't repeat the message.
if (location.search.includes("m=")) {
  const url = new URL(location.href);
  url.searchParams.delete("m");
  history.replaceState(null, "", url);
}
