// 4-box PIN fields: numeric keyboard, auto-advance, backspace to the previous box, paste and one-time-code
// autofill of a whole code, and a "Generate" button. The original input stays in the form (hidden) and holds
// the value that is submitted, so everything works the same as the one-field fallback.

const LENGTH = 4;

for (const wrap of document.querySelectorAll<HTMLElement>("[data-pin]")) {
  const field = wrap.querySelector<HTMLInputElement>("input")!;
  const label = wrap.parentElement?.querySelector("label")?.textContent?.trim() ?? "Kode";
  const boxes: HTMLInputElement[] = [];
  const row = document.createElement("div");
  row.className = "pin-boxes";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);

  const sync = () => {
    field.value = boxes.map((b) => b.value).join("");
    // Clears the form's own error styling once the code is edited.
    for (const box of boxes) box.removeAttribute("aria-invalid");
  };

  // Puts digits into the boxes from `from` on, then focuses the next empty box (or the last one).
  const fill = (digits: string, from: number) => {
    const chars = digits.replace(/\D/g, "").slice(0, LENGTH - from);
    chars.split("").forEach((ch, i) => (boxes[from + i]!.value = ch));
    sync();
    boxes[Math.min(from + chars.length, LENGTH - 1)]!.focus();
  };

  for (let i = 0; i < LENGTH; i++) {
    const box = document.createElement("input");
    box.type = "text";
    box.inputMode = "numeric";
    box.pattern = "[0-9]*";
    box.maxLength = i === 0 ? LENGTH : 1; // the first box takes a whole code from autofill
    box.autocomplete = i === 0 ? field.autocomplete || "off" : "off";
    box.autocapitalize = "off";
    box.spellcheck = false;
    box.className = "pin-box";
    box.setAttribute("aria-label", `${label}, siffer ${i + 1} av ${LENGTH}`);
    if (field.getAttribute("aria-invalid")) box.setAttribute("aria-invalid", "true");
    if (field.getAttribute("aria-describedby")) box.setAttribute("aria-describedby", field.getAttribute("aria-describedby")!);
    box.value = field.value[i] ?? "";

    box.addEventListener("input", () => {
      const digits = box.value.replace(/\D/g, "");
      if (digits.length > 1) fill(digits, i);
      else {
        box.value = digits;
        sync();
        if (digits && i < LENGTH - 1) boxes[i + 1]!.focus();
      }
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !box.value && i > 0) {
        event.preventDefault();
        boxes[i - 1]!.value = "";
        boxes[i - 1]!.focus();
        sync();
      } else if (event.key === "ArrowLeft" && i > 0) {
        event.preventDefault();
        boxes[i - 1]!.focus();
      } else if (event.key === "ArrowRight" && i < LENGTH - 1) {
        event.preventDefault();
        boxes[i + 1]!.focus();
      }
    });
    box.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text") ?? "";
      if (!/\d/.test(text)) return;
      event.preventDefault();
      fill(text, 0);
    });
    box.addEventListener("focus", () => box.select());
    boxes.push(box);
    row.append(box);
  }

  const focusFirst = field.autofocus;
  // The boxes carry the validation (submit handler below); a hidden field that fails validation would block the submit silently.
  field.hidden = true;
  for (const attribute of ["required", "pattern", "minlength", "autofocus"]) field.removeAttribute(attribute);
  wrap.prepend(row);
  sync();
  // The browser can't focus a hidden field to show its message; point at the first empty box instead.
  field.form?.addEventListener("submit", (event) => {
    if (field.value.length === LENGTH) return;
    event.preventDefault();
    boxes.find((b) => !b.value)?.focus();
  });
  if (focusFirst) boxes[0]!.focus();

  if (wrap.hasAttribute("data-generate")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button pin-generate";
    button.textContent = "Lag en kode";
    button.addEventListener("click", () => {
      const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 10 ** LENGTH;
      fill(String(n).padStart(LENGTH, "0"), 0);
      boxes[LENGTH - 1]!.blur();
    });
    wrap.append(button);
  }
}
