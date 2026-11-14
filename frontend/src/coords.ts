/** Mirrors backend/app/coords.py: accepts RA/Dec as decimal degrees or
 * sexagesimal strings ("08h55m10.831s", "17:57:48.5", "+04d41m36s",
 * "-07:14:42.5"). Returns null (not NaN) on failure so callers can give a
 * clear error instead of silently treating a sexagesimal string typed
 * into the search box as 0. */
export function parseRaDeg(raw: string): number | null {
  const trimmed = raw.trim();
  const decimal = Number(trimmed);
  if (!Number.isNaN(decimal) && trimmed !== "") return ((decimal % 360) + 360) % 360;

  const hms = trimmed.match(/^(\d+)[h:]\s*(\d+)[m:]\s*([\d.]+)s?$/i);
  if (hms) {
    const [, h, m, s] = hms;
    const deg = (Number(h) + Number(m) / 60 + Number(s) / 3600) * 15;
    return ((deg % 360) + 360) % 360;
  }
  return null;
}

export function parseDecDeg(raw: string): number | null {
  const trimmed = raw.trim();
  const decimal = Number(trimmed);
  if (!Number.isNaN(decimal) && trimmed !== "") return decimal;

  const dms = trimmed.match(/^([+-]?)(\d+)[d:]\s*(\d+)[m:]\s*([\d.]+)s?$/i);
  if (dms) {
    const [, sign, d, m, s] = dms;
    const deg = Number(d) + Number(m) / 60 + Number(s) / 3600;
    return sign === "-" ? -deg : deg;
  }
  return null;
}
