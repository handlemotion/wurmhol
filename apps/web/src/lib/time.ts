/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(at: number | string | null, now: number) {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "Expires in 3 h", "Expires in 89 d", "Never expires", "Expired". */
export function expiry(at: number | string | null, now: number) {
  if (at === null) return "Never expires";
  const hours = Math.round((new Date(at).getTime() - now) / 3_600_000);
  if (hours <= 0) return "Expired";
  return hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} d`;
}
