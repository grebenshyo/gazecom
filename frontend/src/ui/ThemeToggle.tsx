/**
 * Theme switcher — single circular button, sun/moon glyph.
 *
 * Sits in the same panel-body cluster as the help/settings triggers, with
 * matching circle treatment (24×24, filled `--button-bg`) — see legacy
 * `.help-button` (backup/v1 css/styles.css:601-616) for the inspiration.
 */

import { useStore } from "../store";
import "./ThemeToggle.css";

export function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="gz-theme-toggle"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => set("theme", isDark ? "light" : "dark")}
    >
      {isDark ? "☾" : "☀"}
    </button>
  );
}
