// Pipe lifetimes as people type them: `90m`, `8h`, `1h30m`, `45s`. The CLI parses `--ttl` with
// this, and the Worker formats its limit the same way in the refusal that names it.

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Seconds in a duration like `90m` or `1h30m`, or `null` if it isn't one or is zero. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim().toLowerCase());
  if (!match || !text.trim()) return null;
  const [, h = "0", m = "0", s = "0"] = match;
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/** The shortest `parseDuration` text for a number of seconds: 43200 → `12h`, 5400 → `1h30m`. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const text = `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}`;
  return text || "0s";
}
