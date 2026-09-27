// Push test page: says whether this device gets notifications for the apartment the tests run as,
// and turns them on for it. Only a browser can tell which subscription is its own.
export {};

const box = document.querySelector<HTMLElement>("#device-status");
const text = document.querySelector<HTMLElement>("#device-text");
const button = document.querySelector<HTMLButtonElement>("#device-subscribe");

function keyToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function api(path: string, body: unknown) {
  const res = await fetch(`${box!.dataset.api}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

function show(tone: "ok" | "warn", message: string, offer = false) {
  box!.dataset.tone = tone;
  text!.textContent = message;
  button!.hidden = !offer;
}

async function check() {
  const apartment = box!.dataset.apartment!;
  if (!("serviceWorker" in navigator)) return show("warn", "Denne nettleseren støtter ikke varsler.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  if (!("PushManager" in window))
    return show(
      "warn",
      /iPhone|iPad/.test(navigator.userAgent)
        ? "På iPhone kommer varsler bare når siden er lagt til på Hjem-skjermen: trykk Del → «Legg til på Hjem-skjerm», og åpne den derfra."
        : "Denne nettleseren støtter ikke varsler.",
    );
  if (Notification.permission === "denied")
    return show("warn", "Varsler er blokkert for denne siden. Tillat dem i nettleserinnstillingene, og last siden på nytt.");
  const sub = await reg.pushManager.getSubscription();
  if (!sub || Notification.permission !== "granted")
    return show("warn", "Denne enheten har ikke varsler på, så den får ingen varsler fra testene.", true);
  const { apartment: registered } = (await api("device", { endpoint: sub.endpoint })) as { apartment: string | null };
  if (registered === apartment) return show("ok", `Denne enheten får varsler for Leil. ${apartment}.`);
  show(
    "warn",
    registered
      ? `Denne enheten får varsler for Leil. ${registered}, ikke Leil. ${apartment}.`
      : "Denne enheten har varsler på, men ikke for denne vaskekjelleren. En nettleser kan bare få varsler fra én vaskekjeller om gangen.",
    true,
  );
}

button?.addEventListener("click", async () => {
  button.disabled = true;
  try {
    if ((await Notification.requestPermission()) !== "granted") return await check();
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(box!.dataset.vapid!) }));
    await api("subscribe", sub.toJSON());
    await check();
  } catch (err) {
    console.error(err);
    show("warn", "Noe gikk galt da varsler skulle slås på. Prøv igjen.", true);
  } finally {
    button.disabled = false;
  }
});

if (box && text && button)
  check().catch((err) => {
    console.error(err);
    show("warn", "Klarte ikke å sjekke varsler på denne enheten.");
  });
