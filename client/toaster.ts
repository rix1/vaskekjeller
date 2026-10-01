// Sonner (stacking, timers, hover and swipe) as a tiny island: Sonner is a React library, so scripts/build-toaster.ts
// bundles it with Preact's React-compat layer into public/toaster.js. client/app.ts loads that file on the first toast.
import { createElement, Fragment, render } from "preact";
import { Toaster, toast } from "sonner";

export type Notice = {
  /** A repeated id updates the toast already on screen instead of adding another. */
  id: string;
  tone: "success" | "error";
  title: string;
  detail?: string;
  /** Quiet secondary action, e.g. Angre. */
  action?: { label: string; run: () => void };
  /** Milliseconds on screen; errors stay until closed. */
  duration?: number;
  /** Called once the toast is gone: auto-hidden, closed, dismissed or replaced. */
  onClose?: () => void;
};

export const AUTO_HIDE_MS = 4000;

let mounted = false;
function mount() {
  if (mounted) return;
  mounted = true;
  const root = document.createElement("div");
  document.body.append(root);
  render(
    createElement(Toaster, {
      position: "bottom-right",
      theme: "light",
      closeButton: true,
      visibleToasts: 3,
      duration: AUTO_HIDE_MS,
      containerAriaLabel: "Varsler",
    }),
    root,
  );
}

export function notify(notice: Notice) {
  mount();
  const duration = notice.tone === "error" ? Infinity : (notice.duration ?? AUTO_HIDE_MS);
  // Auto-hiding toasts show a thin line that runs out in step with their timer (CSS, public/style.css).
  const description =
    notice.detail || Number.isFinite(duration)
      ? createElement(
          Fragment,
          null,
          notice.detail,
          Number.isFinite(duration) ? createElement("span", { className: "vk-timer", style: { animationDuration: `${duration}ms` } }) : null,
        )
      : undefined;
  toast[notice.tone](notice.title, {
    id: notice.id,
    description,
    duration,
    onDismiss: notice.onClose,
    onAutoClose: notice.onClose,
    classNames: { toast: `vk-toast${notice.action ? " vk-has-action" : ""}`, actionButton: "vk-toast-action" },
    action: notice.action && { label: notice.action.label, onClick: notice.action.run },
  });
}

export const dismissNotice = (id: string) => void toast.dismiss(id);
