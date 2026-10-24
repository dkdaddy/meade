const RAD = Math.PI / 180;
const clamp = (x) => Math.max(-1, Math.min(1, x));

export const norm360 = (d) => ((d % 360) + 360) % 360;
export const norm180 = (d) => {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
};

export const julianDate = (date) => date.getTime() / 86400000 + 2440587.5;

// Local apparent-ish sidereal time in degrees. Longitude is positive east.
export function lstDegrees(date, lonEastDeg) {
  const d = julianDate(date) - 2451545.0;
  const t = d / 36525;
  const gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000;
  return norm360(gmst + lonEastDeg);
}

// Azimuth is measured from true north, increasing eastwards.
export function raDecToAltAz(raHours, decDeg, date, latDeg, lonEastDeg) {
  const ha = (lstDegrees(date, lonEastDeg) - raHours * 15) * RAD;
  const dec = decDeg * RAD;
  const lat = latDeg * RAD;
  const alt = Math.asin(clamp(Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha)));
  const az = Math.atan2(
    -Math.cos(dec) * Math.sin(ha),
    Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha),
  );
  return { alt: alt / RAD, az: norm360(az / RAD) };
}

export function altAzToRaDec(altDeg, azDeg, date, latDeg, lonEastDeg) {
  const alt = altDeg * RAD;
  const az = azDeg * RAD;
  const lat = latDeg * RAD;
  const dec = Math.asin(clamp(Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az)));
  const ha = Math.atan2(-Math.sin(az) * Math.cos(alt), (Math.sin(alt) - Math.sin(lat) * Math.sin(dec)) / Math.cos(lat));
  const raDeg = norm360(lstDegrees(date, lonEastDeg) - ha / RAD);
  return { raHours: raDeg / 15, decDeg: dec / RAD };
}

// Precesses J2000 equatorial coordinates to the mean equator and equinox of the given date (IAU 1976).
export function precessFromJ2000(raHours, decDeg, date) {
  const t = (julianDate(date) - 2451545.0) / 36525;
  const zeta = ((2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) / 3600) * RAD;
  const z = ((2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) / 3600) * RAD;
  const theta = ((2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) / 3600) * RAD;
  const ra0 = raHours * 15 * RAD;
  const dec0 = decDeg * RAD;
  const a = Math.cos(dec0) * Math.sin(ra0 + zeta);
  const b = Math.cos(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) - Math.sin(theta) * Math.sin(dec0);
  const c = Math.sin(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) + Math.cos(theta) * Math.sin(dec0);
  const ra = norm360((Math.atan2(a, b) + z) / RAD);
  return { raHours: ra / 15, decDeg: Math.asin(clamp(c)) / RAD };
}

export function angularSeparationDeg(ra1Hours, dec1Deg, ra2Hours, dec2Deg) {
  const d1 = dec1Deg * RAD;
  const d2 = dec2Deg * RAD;
  const dRa = (ra2Hours - ra1Hours) * 15 * RAD;
  const dDec = d2 - d1;
  const h = Math.sin(dDec / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dRa / 2) ** 2;
  return 2 * Math.asin(clamp(Math.sqrt(h))) / RAD;
}
