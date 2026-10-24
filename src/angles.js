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

export function formatHMS(hours) {
  const total = Math.round((((hours % 24) + 24) % 24) * 3600) % 86400;
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

// "+DD:MM:SS" (degSep is the separator between degrees and minutes, '*' for the scope).
export function formatDMS(degrees, degSep = ':') {
  const total = Math.round(Math.abs(degrees) * 3600);
  const sign = degrees < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(total / 3600))}${degSep}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
