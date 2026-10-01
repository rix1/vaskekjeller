// The 4-box PIN field. Without JavaScript it is one numeric input; client/pin.ts swaps in four boxes.
import type { FC } from "hono/jsx";
import { described, FieldError } from "./admin-views.tsx";

export const PinAssets: FC = () => (
  <>
    <link rel="stylesheet" href="/pin.css" />
    <script type="module" src="/pin.js" defer></script>
  </>
);

export const PinField: FC<{
  name: string;
  label: string;
  value?: string;
  error?: string;
  hint?: string;
  /** "one-time-code" lets iOS and Android offer a code from a message; "off" for a code the admin chooses. */
  autocomplete?: "one-time-code" | "off";
  autofocus?: boolean;
  /** Adds a button that fills the boxes with a random code (needs JavaScript). */
  generate?: boolean;
}> = (p) => (
  <div class="field pin-field" data-pin-field>
    <label for={p.name}>{p.label}</label>
    <div class="pin" data-pin data-generate={p.generate ? "" : undefined}>
      <input
        name={p.name}
        type="text"
        inputmode="numeric"
        pattern="[0-9]{4}"
        minlength={4}
        maxlength={4}
        required
        autocomplete={p.autocomplete ?? "off"}
        autofocus={p.autofocus}
        value={p.value ?? ""}
        {...described(p.name, p.error, !!p.hint)}
      />
    </div>
    {p.hint && (
      <p class="field-hint" id={`${p.name}-hint`}>
        {p.hint}
      </p>
    )}
    <FieldError id={p.name} error={p.error} />
  </div>
);
