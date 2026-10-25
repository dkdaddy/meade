const pad = (n) => String(n).padStart(2, '0');

// Parses "6:45:09", "06h45m09s", "-16 42 58", "-16.7161", "+00*00:01" ... into a decimal number.
export function parseSexagesimal(text, label = 'value') {
  const s = String(text).trim();
  const negative = s.startsWith('-');
  const parts = s
    .replace(/^[+-]/, '')
    .split(/[^\d.]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some(Number.isNaN)) {
    throw new Error(`Cannot parse ${label}: "${text}"`);
  }
  const [a, b = 0, c = 0] = parts;
  const value = a + b / 60 + c / 3600;
  return negative ? -value : value;
}

export function parseHours(text) {
  const hours = parseSexagesimal(text, 'RA');
  if (hours < 0 || hours >= 24) throw new Error(`RA must be in [0, 24) hours: "${text}"`);
  return hours;
}

export function parseDegrees(text) {
  return parseSexagesimal(text, 'angle');
}

// Splits an angle (degrees or hours) into whole units, minutes and seconds. Only the seconds carry decimals, and the
// rounding carries upward so that 59.96 seconds never prints as 60.0.
function sexagesimal(value, digits) {
  const scale = 10 ** digits;
  const units = Math.round(Math.abs(value) * 3600 * scale);
  const secs = (units % (60 * scale)) / scale;
  return {
    whole: Math.floor(units / (3600 * scale)),
    mins: pad(Math.floor(units / (60 * scale)) % 60),
    secs: secs.toFixed(digits).padStart(digits ? digits + 3 : 2, '0'),
  };
}

// "-08°10'04.3\"" (sign '+' shown only when `signed`).
export function formatDeg(degrees, { signed = false, digits = 1 } = {}) {
  const { whole, mins, secs } = sexagesimal(degrees, digits);
  const isZero = whole === 0 && mins === '00' && Number(secs) === 0;
  const sign = degrees < 0 && !isZero ? '-' : signed ? '+' : '';
  return `${sign}${whole}\u00b0${mins}'${secs}"`;
}

// Altitudes always carry a sign; azimuths are shown in 0..360.
export const formatAlt = (degrees, digits = 1) => formatDeg(degrees, { signed: true, digits });
export const formatAz = (degrees, digits = 1) => formatDeg(((degrees % 360) + 360) % 360, { digits });

// "05h15m51.1s"
export function formatHours(hours, digits = 1) {
  const { whole, mins, secs } = sexagesimal(((hours % 24) + 24) % 24, digits);
  return `${pad(whole % 24)}h${mins}m${secs}s`;
}

// Rewrites the scope's raw replies in the same style: RA "HH:MM:SS" -> "HHhMMmSSs", angles "+DD*MM:SS" -> "+DD°MM'SS\"".
export function prettyReply(text, kind) {
  if (kind === 'ra') {
    let m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (m) return `${m[1]}h${m[2]}m${m[3]}s`;
    m = /^(\d{2}):(\d{2})\.(\d)$/.exec(text);
    return m ? `${m[1]}h${m[2]}.${m[3]}m` : text;
  }
  const m = /^([+-]?\d{1,3})\*(\d{2})(?::(\d{2}))?$/.exec(text);
  return m ? `${m[1]}\u00b0${m[2]}'${m[3] ? `${m[3]}"` : ''}` : text;
}
