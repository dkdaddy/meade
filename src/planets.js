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

// Calculates of-date geocentric apparent RA (hours [0, 24)), Dec (degrees [-90, 90]) and visual magnitude
export function planetRaDec(name, date = new Date()) {
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

export function findPlanet(query, now = new Date()) {
  const q = key(query);
  const exact = PLANET_NAMES.find((name) => key(name) === q);
  const planetName = exact ?? (PLANET_NAMES.filter((name) => key(name).startsWith(q)).length === 1 ? PLANET_NAMES.filter((name) => key(name).startsWith(q))[0] : null);
  if (!planetName) return null;

  const coords = planetRaDec(planetName, now);
  return {
    name: planetName,
    kind: 'planet',
    raHours: coords.raHours,
    decDeg: coords.decDeg,
    mag: coords.mag,
    raDec: (d) => planetRaDec(planetName, d),
  };
}

export function listPlanets({ location, minAlt, maxAlt, showAll, now = new Date() }) {
  console.log(`${'Planet'.padEnd(18)} ${'Mag'.padStart(5)}  ${'Alt'.padStart(10)}  ${'Az'.padStart(10)}`);
  let shown = 0;
  for (const name of PLANET_NAMES) {
    const coords = planetRaDec(name, now);
    const { alt, az } = raDecToAltAz(coords.raHours, coords.decDeg, now, location.latitude, location.longitude);
    const ok = alt >= minAlt && alt < maxAlt;
    if (!ok && !showAll) continue;
    shown += 1;
    console.log(`${name.padEnd(18)} ${coords.mag.toFixed(2).padStart(5)}  ${formatAlt(alt, 0).padStart(10)}  ${formatAz(az, 0).padStart(10)}${ok ? '' : '  (not usable)'}`);
  }
  console.log(`\n${shown} of ${PLANET_NAMES.length} planets shown (usable: altitude ${minAlt}\u00b0 to ${maxAlt}\u00b0).`);
}
