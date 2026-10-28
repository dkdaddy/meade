import { formatAlt, formatAz } from './angles.js';
import { raDecToAltAz } from './astro.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function norm360(d) {
  return ((d % 360) + 360) % 360;
}

function solveKepler(M_deg, e) {
  const M = M_deg * RAD;
  let E = M + e * Math.sin(M) * (1.0 + e * Math.cos(M));
  for (let iter = 0; iter < 10; iter++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-7) break;
  }
  return E; // radians
}

// Heliocentric orbital elements for the Sun (Earth's orbit inverted)
function getSun(d) {
  const w = 282.9404 + 4.70935e-5 * d;
  const a = 1.0;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.047 + 0.9856002585 * d);
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(E));
  const v = Math.atan2(yv, xv) * DEG;
  const r = Math.sqrt(xv * xv + yv * yv);
  const lonsun = norm360(v + w);
  const xs = r * Math.cos(lonsun * RAD);
  const ys = r * Math.sin(lonsun * RAD);
  return { xs, ys, r, lonsun };
}

// Orbital elements parameterised by day number d from 2000 Jan 0.0 UT (1999 Dec 31 0:00 UT)
// Source: Paul Schlyter, "Computing planetary positions" (accurate to ~1-2 arcminutes)
export const PLANET_ELEMENTS = {
  Mercury: (d) => ({
    N: 48.3313 + 3.24587e-5 * d,
    i: 7.0047 + 5.0e-8 * d,
    w: 29.1241 + 1.01444e-5 * d,
    a: 0.387098,
    e: 0.205635 + 5.59e-10 * d,
    M: norm360(168.6562 + 4.0923344368 * d),
  }),
  Venus: (d) => ({
    N: 76.6799 + 2.4659e-5 * d,
    i: 3.3946 + 2.75e-8 * d,
    w: 54.891 + 1.38374e-5 * d,
    a: 0.72333,
    e: 0.006773 - 1.302e-9 * d,
    M: norm360(48.0052 + 1.6021302244 * d),
  }),
  Mars: (d) => ({
    N: 49.5574 + 2.11081e-5 * d,
    i: 1.8497 - 1.78e-8 * d,
    w: 286.5016 + 2.92961e-5 * d,
    a: 1.523688,
    e: 0.093405 + 2.516e-9 * d,
    M: norm360(18.6021 + 0.5240207766 * d),
  }),
  Jupiter: (d) => ({
    N: 100.4542 + 2.76854e-5 * d,
    i: 1.303 - 1.557e-7 * d,
    w: 273.8777 + 1.64505e-5 * d,
    a: 5.20256,
    e: 0.048498 + 4.469e-9 * d,
    M: norm360(19.895 + 0.0830853001 * d),
  }),
  Saturn: (d) => ({
    N: 113.6634 + 2.3898e-5 * d,
    i: 2.4886 - 1.081e-7 * d,
    w: 339.3939 + 2.97661e-5 * d,
    a: 9.55475,
    e: 0.055508 - 3.46e-10 * d,
    M: norm360(316.967 + 0.0334442282 * d),
  }),
  Uranus: (d) => ({
    N: 74.0005 + 1.3978e-5 * d,
    i: 0.7733 + 1.9e-8 * d,
    w: 96.6612 + 3.0565e-5 * d,
    a: 19.18171 - 1.55e-8 * d,
    e: 0.047318 + 7.45e-9 * d,
    M: norm360(142.5905 + 0.011725806 * d),
  }),
  Neptune: (d) => ({
    N: 131.7806 + 3.0173e-5 * d,
    i: 1.77 - 2.55e-7 * d,
    w: 272.8461 - 6.027e-6 * d,
    a: 30.05826 + 3.313e-8 * d,
    e: 0.008606 + 2.15e-9 * d,
    M: norm360(260.2471 + 0.005995147 * d),
  }),
};

export const PLANET_NAMES = Object.keys(PLANET_ELEMENTS);
export const SOLAR_SYSTEM_NAMES = ['Moon', ...PLANET_NAMES];

function getHeliocentric(el) {
  const E = solveKepler(el.M, el.e);
  const xv = el.a * (Math.cos(E) - el.e);
  const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(E));
  const v = Math.atan2(yv, xv) * DEG;
  const r = Math.sqrt(xv * xv + yv * yv);

  const N = el.N * RAD;
  const vw = (v + el.w) * RAD;
  const i = el.i * RAD;

  const xh = r * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(i));
  const zh = r * (Math.sin(vw) * Math.sin(i));

  const lonecl = norm360(Math.atan2(yh, xh) * DEG);
  const latecl = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * DEG;

  return { xh, yh, zh, r, lonecl, latecl, v };
}

function applyPerturbations(name, pos, M_all) {
  let { lonecl, latecl, r } = pos;
  const Mj = M_all.Jupiter;
  const Ms = M_all.Saturn;
  const Mu = M_all.Uranus;

  if (name === 'Jupiter') {
    lonecl +=
      -0.332 * Math.sin((2 * Mj - 5 * Ms - 67.6) * RAD) -
      0.056 * Math.sin((2 * Mj - 2 * Ms + 21) * RAD) +
      0.042 * Math.sin((3 * Mj - 5 * Ms + 21) * RAD) -
      0.036 * Math.sin((Mj - 2 * Ms) * RAD) +
      0.022 * Math.cos((Mj - Ms) * RAD) +
      0.023 * Math.sin((2 * Mj - 3 * Ms + 52) * RAD) -
      0.016 * Math.sin((Mj - 5 * Ms - 69) * RAD);
  } else if (name === 'Saturn') {
    lonecl +=
      0.812 * Math.sin((2 * Mj - 5 * Ms - 67.6) * RAD) -
      0.229 * Math.cos((2 * Mj - 4 * Ms - 2) * RAD) +
      0.119 * Math.sin((Mj - 2 * Ms - 3) * RAD) +
      0.046 * Math.sin((2 * Mj - 6 * Ms - 69) * RAD) +
      0.014 * Math.sin((Mj - 3 * Ms + 32) * RAD);

    latecl +=
      -0.02 * Math.cos((2 * Mj - 4 * Ms - 2) * RAD) +
      0.018 * Math.sin((2 * Mj - 6 * Ms - 49) * RAD);
  } else if (name === 'Uranus') {
    lonecl +=
      0.04 * Math.sin((Ms - 2 * Mu + 6) * RAD) +
      0.035 * Math.sin((Ms - 3 * Mu + 33) * RAD) -
      0.015 * Math.sin((Mj - Mu + 20) * RAD);
  }

  const loneclRad = lonecl * RAD;
  const lateclRad = latecl * RAD;
  const xh = r * Math.cos(loneclRad) * Math.cos(lateclRad);
  const yh = r * Math.sin(loneclRad) * Math.cos(lateclRad);
  const zh = r * Math.sin(lateclRad);
  return { xh, yh, zh, r, lonecl, latecl };
}

function computeMagnitude(name, r, R, FV) {
  const log5rR = 5 * Math.log10(r * R);
  switch (name) {
    case 'Mercury':
      return -0.36 + log5rR + 0.027 * FV + 2.2e-13 * Math.pow(FV, 6);
    case 'Venus':
      return -4.34 + log5rR + 0.013 * FV + 4.2e-7 * Math.pow(FV, 3);
    case 'Mars':
      return -1.52 + log5rR + 0.016 * FV;
    case 'Jupiter':
      return -9.4 + log5rR + 0.005 * FV;
    case 'Saturn':
      return -8.88 + log5rR + 0.044 * FV;
    case 'Uranus':
      return -7.19 + log5rR;
    case 'Neptune':
      return -6.87 + log5rR;
    default:
      return 0;
  }
}

// Calculates of-date topocentric (if location given) or geocentric apparent Moon position and phase
export function moonRaDec(date = new Date(), location = null) {
  const d = (date.getTime() - 946598400000) / 86400000;

  // Sun elements
  const w_sun = 282.9404 + 4.70935e-5 * d;
  const e_sun = 0.016709 - 1.151e-9 * d;
  const M_sun = norm360(356.047 + 0.9856002585 * d);
  const E_sun = solveKepler(M_sun, e_sun);
  const xv_s = Math.cos(E_sun) - e_sun;
  const yv_s = Math.sqrt(1 - e_sun * e_sun) * Math.sin(E_sun);
  const v_sun = Math.atan2(yv_s, xv_s) * DEG;
  const lonsun = norm360(v_sun + w_sun);

  // Moon orbital elements
  const N_m = norm360(125.1228 - 0.0529538083 * d);
  const i_m = 5.1454;
  const w_m = norm360(318.0634 + 0.1643573223 * d);
  const a_m = 60.2666; // Earth equatorial radii
  const e_m = 0.0549;
  const M_m = norm360(115.3654 + 13.0649929509 * d);

  const E_m = solveKepler(M_m, e_m);
  const xv = a_m * (Math.cos(E_m) - e_m);
  const yv = a_m * (Math.sqrt(1 - e_m * e_m) * Math.sin(E_m));
  const v_m = Math.atan2(yv, xv) * DEG;
  const r_m = Math.sqrt(xv * xv + yv * yv);

  // Unperturbed geocentric ecliptic coordinates
  const N = N_m * RAD;
  const vw = (v_m + w_m) * RAD;
  const i = i_m * RAD;

  const xh = r_m * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(i));
  const yh = r_m * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(i));
  const zh = r_m * (Math.sin(vw) * Math.sin(i));

  let lonecl = norm360(Math.atan2(yh, xh) * DEG);
  let latecl = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * DEG;
  let r = r_m;

  // Perturbations (Schlyter section 9)
  const Ls = norm360(M_sun + w_sun);
  const Lm = norm360(M_m + w_m + N_m);
  const D = norm360(Lm - Ls);
  const F = norm360(Lm - N_m);

  const Mm_r = M_m * RAD;
  const Ms_r = M_sun * RAD;
  const D_r = D * RAD;
  const F_r = F * RAD;

  // Longitude perturbations
  lonecl +=
    -1.274 * Math.sin(Mm_r - 2 * D_r) +
    0.658 * Math.sin(2 * D_r) +
    -0.186 * Math.sin(Ms_r) +
    -0.059 * Math.sin(2 * Mm_r - 2 * D_r) +
    -0.057 * Math.sin(Mm_r - 2 * D_r + Ms_r) +
    0.053 * Math.sin(Mm_r + 2 * D_r) +
    0.046 * Math.sin(2 * D_r - Ms_r) +
    0.041 * Math.sin(Mm_r - Ms_r) +
    -0.035 * Math.sin(D_r) +
    -0.031 * Math.sin(Mm_r + Ms_r) +
    -0.015 * Math.sin(2 * F_r - 2 * D_r) +
    0.011 * Math.sin(Mm_r - 4 * D_r);

  // Latitude perturbations
  latecl +=
    -0.173 * Math.sin(F_r - 2 * D_r) +
    -0.055 * Math.sin(Mm_r - F_r - 2 * D_r) +
    -0.046 * Math.sin(Mm_r + F_r - 2 * D_r) +
    0.033 * Math.sin(F_r + 2 * D_r) +
    0.017 * Math.sin(2 * Mm_r + F_r);

  // Distance perturbations (in Earth radii)
  r +=
    -0.58 * Math.cos(Mm_r - 2 * D_r) +
    -0.46 * Math.cos(2 * D_r);

  // Geocentric rectangular coordinates
  const lonecl_r = lonecl * RAD;
  const latecl_r = latecl * RAD;
  const ecl = (23.4393 - 3.563e-7 * d) * RAD;

  const xg = r * Math.cos(lonecl_r) * Math.cos(latecl_r);
  const yg = r * Math.sin(lonecl_r) * Math.cos(latecl_r);
  const zg = r * Math.sin(latecl_r);

  // Rotate to equatorial
  const xe = xg;
  const ye = yg * Math.cos(ecl) - zg * Math.sin(ecl);
  const ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);

  let finalXe = xe;
  let finalYe = ye;
  let finalZe = ze;
  let finalR = r;

  // Topocentric parallax correction: observer vector in Earth radii
  if (location && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    const lat = location.latitude * RAD;
    const f = 1 / 298.257223563;
    const gclat = Math.atan((1 - f) * (1 - f) * Math.tan(lat));
    const rho = 0.9983271 + 0.0016764 * Math.cos(2 * lat) - 0.0000035 * Math.cos(4 * lat);

    const d_days = (date.getTime() - 946598400000) / 86400000;
    const gmst = norm360(280.46061837 + 360.98564736629 * d_days);
    const lst = norm360(gmst + location.longitude) * RAD;

    const x_obs = rho * Math.cos(gclat) * Math.cos(lst);
    const y_obs = rho * Math.cos(gclat) * Math.sin(lst);
    const z_obs = rho * Math.sin(gclat);

    finalXe = xe - x_obs;
    finalYe = ye - y_obs;
    finalZe = ze - z_obs;
    finalR = Math.sqrt(finalXe * finalXe + finalYe * finalYe + finalZe * finalZe);
  }

  const raRad = norm360(Math.atan2(finalYe, finalXe) * DEG) * RAD;
  const decRad = Math.atan2(finalZe, Math.sqrt(finalXe * finalXe + finalYe * finalYe));

  const raHours = (raRad * DEG) / 15;
  const decDeg = decRad * DEG;

  // Phase angle and visual magnitude
  const elong = Math.acos(Math.cos(latecl_r) * Math.cos(lonecl_r - lonsun * RAD)) * DEG;
  const fv = 180 - elong; // phase angle
  const illumFraction = (1 + Math.cos(fv * RAD)) / 2;
  const mag = -12.74 + 0.026 * fv + 4e-9 * Math.pow(fv, 4);

  return {
    raHours,
    decDeg,
    mag,
    distanceAU: finalR / 23454.8,
    distanceEarthRadii: finalR,
    illumFraction,
    phaseAngleDeg: fv,
  };
}

// Calculates of-date geocentric/topocentric apparent RA (hours [0, 24)), Dec (degrees [-90, 90]) and visual magnitude
export function planetRaDec(name, date = new Date(), location = null) {
  if (name.toLowerCase() === 'moon') {
    return moonRaDec(date, location);
  }

  const d = (date.getTime() - 946598400000) / 86400000;
  const sun = getSun(d);

  const M_all = {
    Jupiter: PLANET_ELEMENTS.Jupiter(d).M,
    Saturn: PLANET_ELEMENTS.Saturn(d).M,
    Uranus: PLANET_ELEMENTS.Uranus(d).M,
  };

  const fn = PLANET_ELEMENTS[name];
  if (!fn) throw new Error(`Unknown planet "${name}"`);
  const el = fn(d);
  const rawHelio = getHeliocentric(el);
  const helio = applyPerturbations(name, rawHelio, M_all);

  const xg = helio.xh + sun.xs;
  const yg = helio.yh + sun.ys;
  const zg = helio.zh;

  const R = Math.sqrt(xg * xg + yg * yg + zg * zg);
  const r = helio.r;

  const ecl = (23.4393 - 3.563e-7 * d) * RAD;

  const xe = xg;
  const ye = yg * Math.cos(ecl) - zg * Math.sin(ecl);
  const ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);

  const raRad = norm360(Math.atan2(ye, xe) * DEG) * RAD;
  const decRad = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye));

  const raHours = (raRad * DEG) / 15;
  const decDeg = decRad * DEG;

  const cosFV = (r * r + R * R - sun.r * sun.r) / (2 * r * R);
  const FV = Math.acos(Math.max(-1, Math.min(1, cosFV))) * DEG;
  const mag = computeMagnitude(name, r, R, FV);

  return { raHours, decDeg, mag, distanceAU: R };
}

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function findPlanet(query, now = new Date(), location = null) {
  const q = key(query);
  const exact = SOLAR_SYSTEM_NAMES.find((name) => key(name) === q);
  const planetName = exact ?? (SOLAR_SYSTEM_NAMES.filter((name) => key(name).startsWith(q)).length === 1 ? SOLAR_SYSTEM_NAMES.filter((name) => key(name).startsWith(q))[0] : null);
  if (!planetName) return null;

  const isMoon = planetName === 'Moon';
  const coords = isMoon ? moonRaDec(now, location) : planetRaDec(planetName, now);
  return {
    name: planetName,
    kind: isMoon ? 'moon' : 'planet',
    raHours: coords.raHours,
    decDeg: coords.decDeg,
    mag: coords.mag,
    illumFraction: coords.illumFraction,
    raDec: (d, loc = location) => (isMoon ? moonRaDec(d, loc) : planetRaDec(planetName, d)),
  };
}

export function listPlanets({ location, minAlt, maxAlt, showAll, now = new Date() }) {
  console.log(`${'Body'.padEnd(18)} ${'Mag'.padStart(5)}  ${'Alt'.padStart(10)}  ${'Az'.padStart(10)}  Info`);
  let shown = 0;
  for (const name of SOLAR_SYSTEM_NAMES) {
    const isMoon = name === 'Moon';
    const coords = isMoon ? moonRaDec(now, location) : planetRaDec(name, now);
    const { alt, az } = raDecToAltAz(coords.raHours, coords.decDeg, now, location.latitude, location.longitude);
    const ok = alt >= minAlt && alt < maxAlt;
    if (!ok && !showAll) continue;
    shown += 1;
    const info = isMoon ? `${(coords.illumFraction * 100).toFixed(0)}% illuminated` : '';
    console.log(`${name.padEnd(18)} ${coords.mag.toFixed(2).padStart(5)}  ${formatAlt(alt, 0).padStart(10)}  ${formatAz(az, 0).padStart(10)}${ok ? (info ? `  (${info})` : '') : `  (not usable${info ? `, ${info}` : ''})`}`);
  }
  console.log(`\n${shown} of ${SOLAR_SYSTEM_NAMES.length} solar system bodies shown (usable: altitude ${minAlt}\u00b0 to ${maxAlt}\u00b0).`);
}
