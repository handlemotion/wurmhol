// The theme, set before first paint (loaded synchronously in <head>; the CSP's script-src 'self'
// rules out an inline script). Tailwind's documented toggle: `data-theme` on <html> is the
// viewer's saved choice (localStorage.theme), else the system's, and follows the system live
// while nothing is saved. Pressing `t` outside a text field switches it and saves the choice.
(() => {
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  let saved = null;

  try {
    saved = localStorage.getItem("theme");
  } catch {
    // Storage blocked: follow the system, and a toggle lasts for this page only.
  }

  const apply = () => {
    root.dataset.theme = saved ?? (system.matches ? "dark" : "light");
  };

  apply();
  system.addEventListener("change", apply);
  addEventListener("keydown", (event) => {
    if (event.key !== "t" || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    const target = event.target;

    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    ) {
      return;
    }

    saved = root.dataset.theme === "dark" ? "light" : "dark";

    try {
      localStorage.setItem("theme", saved);
    } catch {
      // Not persisted; still applied.
    }

    apply();
  });
})();
