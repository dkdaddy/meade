import fs from 'node:fs';
import readline from 'node:readline';
import { norm180, norm360, precessFromJ2000, raDecToAltAz } from './astro.js';
import { formatAlt, formatAz, formatDeg, parseDegrees, parseHours } from './angles.js';
import { magneticDeclination, resolveLocation } from './location.js';
import { Scope } from './lx200.js';
import { findStar } from './stars.js';

export const ALIGNMENT_FILE = new URL('../alignment.json', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (deg) => formatDeg(deg, { signed: true });

// Limits are only reported: this tool never sends anything to the scope except read commands.
export const MAX_AZ_FROM_HOME_DEG = 180;
export const MIN_ALT_DEG = 5;
export const MAX_ALT_DEG = 75;
// The scope must report approximately Alt 0, Az 0 when the alignment starts.
const HOME_TOLERANCE_DEG = 2;

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// Read-only alignment. The scope's reported Alt/Az is the frame: Alt 0 / Az 0 is the home pose
// (level, pointing magnetic north). The PC works out where the star really is, tells you how far to move,
// and records the difference between what the scope reports and the truth when you press Enter.
export async function align(values, starName) {
  const haveCoords = values.ra !== undefined || values.dec !== undefined;
  if (starName && haveCoords) throw new Error('Give either a star name or --ra/--dec, not both.');
  if (!starName && (values.ra === undefined || values.dec === undefined)) {
    throw new Error('align needs a star name (e.g. align Vega; run the stars command for the list) or --ra and --dec');
  }

  const location = await resolveLocation(values);
  const now = new Date();

  // Named stars are J2000 catalogue positions, so bring them to the current epoch.
  let target;
  let star = null;
  if (starName) {
    star = findStar(starName);
    target = precessFromJ2000(star.raHours, star.decDeg, now);
  } else {
    target = { raHours: parseHours(values.ra), decDeg: parseDegrees(values.dec) };
    if (Math.abs(target.decDeg) > 90) throw new Error('Dec must be within +/-90 degrees');
  }

  const declination = values.declination !== undefined ? parseDegrees(values.declination) : magneticDeclination(location.latitude, location.longitude, now);
  const homeTrueAz = norm360(declination); // true azimuth of magnetic north

  // Where the scope should read when it is pointing at the target (scope az 0 = magnetic north).
  const targetReading = (when) => {
    const t = raDecToAltAz(target.raHours, target.decDeg, when, location.latitude, location.longitude);
    return { trueAlt: t.alt, trueAz: t.az, alt: t.alt, az: norm360(t.az - homeTrueAz) };
  };

  const first = targetReading(now);
  console.log(`Location : ${signed(location.latitude)}, ${signed(location.longitude)}  (${location.source}${location.accuracyMeters ? `, +/-${Math.round(location.accuracyMeters)} m` : ''})`);
  console.log(`Time     : ${now.toISOString()} (PC clock, UTC)`);
  console.log(`Mag decl : ${signed(declination)}  (home = scope Alt 0 / Az 0 = true azimuth ${formatAz(homeTrueAz)})`);
  console.log(`Target   : ${star ? `${star.name} (mag ${star.mag}) ` : ''}true Alt ${formatAlt(first.trueAlt)}  Az ${formatAz(first.trueAz)}`);
  console.log(`Move     : scope should read Alt ${formatAlt(first.alt)}  Az ${formatAz(first.az)}  (from home: up ${signed(first.alt)}, azimuth ${signed(norm180(first.az))})`);

  if (first.alt < MIN_ALT_DEG) throw new Error(`Target is only ${formatDeg(first.alt)} above the horizon (minimum ${MIN_ALT_DEG}\u00b0) - choose a higher one.`);
  if (first.alt >= MAX_ALT_DEG) throw new Error(`Target is at altitude ${formatDeg(first.alt)}, above the ${MAX_ALT_DEG}\u00b0 limit - choose a lower one.`);
  if (Math.abs(norm180(first.az)) > MAX_AZ_FROM_HOME_DEG - 10) {
    console.log(`  Warning: target is within 10\u00b0 of the \u00b1${MAX_AZ_FROM_HOME_DEG}\u00b0 azimuth limit from home.`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scope = new Scope(values.port);
  try {
    await scope.open();
    console.log(`Connected to ${values.port}: ${await scope.queryOrNull(':GVP#')} ${await scope.queryOrNull(':GVN#')}  (read-only)`);

    const start = await scope.readAltAz();
    console.log(`Scope reports: Alt ${formatAlt(start.alt, 0)}  Az ${formatAz(start.az, 0)}`);
    if (Math.abs(start.alt) > HOME_TOLERANCE_DEG || Math.min(start.az, 360 - start.az) > HOME_TOLERANCE_DEG) {
      throw new Error(`At home the scope should report Alt 0 / Az 0 (within ${HOME_TOLERANCE_DEG}\u00b0). Put it at home and power-cycle the handset, then try again.`);
    }

    // Accumulated azimuth travel from home, so the +/-180 limit still works after wrapping past 0/360.
    let lastAz = start.az;
    let travel = norm180(start.az);

    await ask(rl, '\nHome confirmed. Move the scope by hand or with the handset toward the target; the "to go" values show the way.\nPress Enter when the target is centred... \n');

    let centring = true;
    let warned = false;
    const live = (async () => {
      while (centring) {
        try {
          const r = await scope.readAltAz();
          travel += norm180(r.az - lastAz);
          lastAz = r.az;
          const t = targetReading(new Date());
          const warning = r.alt >= MAX_ALT_DEG ? `ALTITUDE ${MAX_ALT_DEG}\u00b0 LIMIT` : Math.abs(travel) >= MAX_AZ_FROM_HOME_DEG ? `AZIMUTH \u00b1${MAX_AZ_FROM_HOME_DEG}\u00b0 LIMIT` : '';
          process.stdout.write(`\r  scope Alt ${formatAlt(r.alt, 0)} Az ${formatAz(r.az, 0)} | to go: alt ${signed(t.alt - r.alt)} az ${signed(norm180(t.az - r.az))} | az from home ${signed(travel)} ${warning ? `!! ${warning} !!` : '                    '}`);
          if (warning && !warned) {
            warned = true;
            process.stdout.write(`\n  LIMIT REACHED: ${warning}. Stop and move back the other way.\n`);
          } else if (!warning) {
            warned = false;
          }
        } catch {
          // ignore a missed poll
        }
        await sleep(500);
      }
    })();
    await ask(rl, '');
    centring = false;
    await live;

    const centredAt = new Date();
    const raw = await scope.readAltAz();
    const truth = targetReading(centredAt);
    const offset = { alt: truth.trueAlt - raw.alt, az: norm180(truth.trueAz - raw.az) }; // true = reported + offset

    const record = {
      version: 2,
      savedAt: centredAt.toISOString(),
      location: { latitude: location.latitude, longitude: location.longitude, source: location.source },
      magneticDeclinationDeg: declination,
      home: { scopeAlt: 0, scopeAz: 0, trueAlt: 0, trueAz: homeTrueAz, assumed: 'level, pointing magnetic north' },
      limits: { azimuthFromHomeDeg: MAX_AZ_FROM_HOME_DEG, minAltitudeDeg: MIN_ALT_DEG, maxAltitudeDeg: MAX_ALT_DEG },
      target: { name: star?.name ?? null, raHours: target.raHours, decDeg: target.decDeg, epoch: 'of date' },
      centred: { scopeAlt: raw.alt, scopeAz: raw.az, trueAlt: truth.trueAlt, trueAz: truth.trueAz },
      offsetDeg: offset,
      correctionFromHomeAssumptionDeg: { alt: offset.alt, az: norm180(offset.az - homeTrueAz) },
      azimuthFromHomeDeg: travel,
    };
    fs.writeFileSync(ALIGNMENT_FILE, JSON.stringify(record, null, 2) + '\n');

    console.log(`\nAligned at ${centredAt.toISOString()}.`);
    console.log(`Scope reported Alt ${formatAlt(raw.alt, 0)} Az ${formatAz(raw.az, 0)}; truth was Alt ${formatAlt(truth.trueAlt)} Az ${formatAz(truth.trueAz)}.`);
    console.log(`Offset (true = reported + offset): alt ${signed(offset.alt)}, az ${signed(offset.az)}; versus the home assumption: alt ${signed(record.correctionFromHomeAssumptionDeg.alt)}, az ${signed(record.correctionFromHomeAssumptionDeg.az)}.`);
    console.log(`Saved ${ALIGNMENT_FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
  } finally {
    rl.close();
    await scope.close();
  }
}
