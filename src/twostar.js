import fs from 'node:fs';
import { angularSeparationDeg, norm180, precessFromJ2000, raDecToAltAz } from './astro.js';
import { formatAlt, formatAz, formatDeg, formatHours, parseDegrees } from './angles.js';
import { ALIGNMENT_FILE, MAX_ALT_DEG, MIN_ALT_DEG } from './align.js';
import { magneticDeclination, resolveLocation } from './location.js';
import { Scope } from './lx200.js';
import { findStar } from './stars.js';
import { AZ_MAX_TARGET_DEG, CancelledError, newSession, slewAxis } from './slew.js';
import { openKeys } from './keys.js';
import { altAzToVec, angleBetweenDeg, bestRotation, correctionRotation, mulMM, mulMV, rotationZ, transpose, twoStarRotation, vecToAltAz } from './pointing.js';

// Two-star alignment and PC-driven tracking.
// The scope only ever receives motion commands (move / stop / move-rate) and read commands: no settings, time,
// site, target or sync commands. The alignment lives entirely on the PC as a rotation between the scope's reported
// Alt/Az and the true Alt/Az; tracking is the PC repeatedly nudging the scope toward where the star is now.

const HOME_TOLERANCE_DEG = 2;
const MIN_STAR_SEPARATION_DEG = 20;
const MAX_RESIDUAL_WARN_DEG = 1;
const TRACK_TRIGGER_DEG = 0.04; // start a correction when the star is this far (about 2.4') from the centre
const TRACK_TOLERANCE_DEG = 0.02;
// A correction aims the axis one trigger-width ahead of the star (in the drift direction) so the error sweeps
// symmetrically from -trigger to +trigger, roughly halving how often a pulse is needed. The lead time is derived
// from the star's measured drift rate and clamped to this window.
const TRACK_AHEAD_DEG = TRACK_TRIGGER_DEG;
const TRACK_MIN_LEAD_MS = 1500;
const TRACK_MAX_LEAD_MS = 20000;
const TRACK_DRIFT_SAMPLE_MS = 4000; // baseline over which the drift rate is measured
const TRACK_CYCLE_MS = 1000;
const MAX_REFERENCES = 20;
const MIN_ALIGN_ALT_DEG = 15; // alignment stars should be well up: refraction and seeing blur low stars
const RAD = Math.PI / 180;
const clampRange = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (deg) => formatDeg(deg, { signed: true });

async function sleepUntil(ms, stop) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) await sleep(Math.min(100, end - Date.now()));
}

export function starTrueAltAz(star, when, location) {
  const p = precessFromJ2000(star.raHours, star.decDeg, when); // catalogue is J2000
  return raDecToAltAz(p.raHours, p.decDeg, when, location.latitude, location.longitude);
}

// Where the scope must read (its own frame) to point at the true Alt/Az `t`, given scope->true rotation R.
export function scopeTarget(R, t) {
  const s = vecToAltAz(mulMV(transpose(R), altAzToVec(t.alt, t.az)));
  return { alt: s.alt, az: s.az, azFromHome: norm180(s.az) };
}

export function reachProblem(star, t, s) {
  if (t.alt < MIN_ALT_DEG) return `${star.name} is only ${formatDeg(t.alt)} above the horizon (minimum ${MIN_ALT_DEG}\u00b0)`;
  if (s.alt < 0 || s.alt >= MAX_ALT_DEG) return `${star.name} needs the scope at altitude ${formatDeg(s.alt)} (allowed 0 to ${MAX_ALT_DEG}\u00b0)`;
  if (Math.abs(s.azFromHome) > AZ_MAX_TARGET_DEG) return `${star.name} needs azimuth ${signed(s.azFromHome)} from home (limit \u00b1${AZ_MAX_TARGET_DEG}\u00b0)`;
  return null;
}

const sVec = (p) => altAzToVec(p.scope.alt, p.scope.az);
const tVec = (p) => altAzToVec(p.true.alt, p.true.az);

async function capture(ctx, star, kind) {
  const at = new Date();
  const r = await ctx.scope.readAltAz();
  const t = starTrueAltAz(star, at, ctx.location);
  return { star: star.name, kind, at: at.toISOString(), scope: { alt: r.alt, az: r.az }, true: { alt: t.alt, az: t.az } };
}

async function gotoStar(ctx, star, R) {
  const t = starTrueAltAz(star, new Date(), ctx.location);
  const s = scopeTarget(R, t);
  const problem = reachProblem(star, t, s);
  if (problem) throw new Error(problem);
  ctx.log(`${star.name}: true Alt ${formatAlt(t.alt)} Az ${formatAz(t.az)}; scope should read Alt ${formatAlt(s.alt)} Az ${formatAz(s.az)}. Slewing...`);
  const opts = {
    session: ctx.session,
    isCancelled: () => ctx.ctl.cancelled,
    onStatus: (st) => ctx.status(`slewing ${st.axis} ${st.reading}  to go ${signed(st.toGo)}  rate ${st.rate}`),
  };
  await slewAxis(ctx.scope, 'az', s.azFromHome, opts);
  await slewAxis(ctx.scope, 'alt', s.alt, opts);
  ctx.status('');
}

// Shows the live reading until Enter is pressed.
async function waitCentred(ctx, star, R) {
  let done = false;
  const key = ctx.keys.wait(['return']).then((k) => {
    done = true;
    return k;
  });
  while (!done) {
    try {
      const r = await ctx.scope.readAltAz();
      const s = scopeTarget(R, starTrueAltAz(star, new Date(), ctx.location));
      ctx.status(`scope Alt ${formatAlt(r.alt, 0)} Az ${formatAz(r.az, 0)} | star predicted at Alt ${formatAlt(s.alt)} Az ${formatAz(s.az)} | Enter = centred`);
    } catch {
      // ignore a missed poll
    }
    await sleepUntil(500, () => done);
  }
  if ((await key) === 'interrupt') throw new CancelledError();
  ctx.status('');
}

function saveAlignment({ location, declination, R, references, target }) {
  const record = {
    version: 3,
    savedAt: new Date().toISOString(),
    location: { latitude: location.latitude, longitude: location.longitude, source: location.source },
    magneticDeclinationDeg: declination ?? null,
    frame: 'x north, y east, z up; true = rotation * scope (scope az 0 / alt 0 = home)',
    rotation: R,
    references,
    target: { name: target },
  };
  fs.writeFileSync(ALIGNMENT_FILE, JSON.stringify(record, null, 2) + '\n');
  return record;
}

function loadAlignment() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(ALIGNMENT_FILE, 'utf8'));
  } catch {
    throw new Error('No saved alignment. Run align2 <star1> <star2> first.');
  }
  if (rec.version !== 3 || !Array.isArray(rec.rotation)) throw new Error('The saved alignment is from the old single-star align. Run align2 <star1> <star2>.');
  return rec;
}

function addReference(references, pair) {
  references.push(pair);
  if (references.length > MAX_REFERENCES) references.splice(2, 1);
}

const pairVecs = (p) => ({ s: sVec(p), t: tVec(p) });

// Least-squares scope->true rotation over every reference star, refined from the current estimate.
function fitRotation(references, seed) {
  return bestRotation(references.map(pairVecs), seed);
}

// Per-axis RMS of the fit, in degrees: altitude error, and azimuth error reduced to a great-circle angle.
function fitResiduals(references, R) {
  const alt = [];
  const az = [];
  for (const p of references) {
    const pred = vecToAltAz(mulMV(R, sVec(p)));
    alt.push(pred.alt - p.true.alt);
    az.push(norm180(pred.az - p.true.az) * Math.cos(p.true.alt * RAD));
  }
  const rms = (xs) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
  return { alt: rms(alt), az: rms(az) };
}

function createModel({ R, references, location, declination, target }) {
  const model = {
    R,
    references,
    target,
    persist() {
      saveAlignment({ location, declination, R: model.R, references: model.references, target: model.target });
    },
    // Folds a freshly centred star into the fit and re-solves from all references, so each sync uses the whole
    // history rather than snapping the model onto the latest star alone. Returns how far the old model was
    // pointing from the star (degrees), for reporting.
    sync(pair) {
      const moved = angleBetweenDeg(mulMV(model.R, sVec(pair)), tVec(pair));
      addReference(model.references, pair);
      model.R = fitRotation(model.references, model.R);
      model.persist();
      return moved;
    },
  };
  return model;
}

export async function runTwoStar(ctx, star1, star2, declination) {
  const sep = angularSeparationDeg(star1.raHours, star1.decDeg, star2.raHours, star2.decDeg);
  if (sep < MIN_STAR_SEPARATION_DEG) {
    throw new Error(`${star1.name} and ${star2.name} are only ${formatDeg(sep)} apart; choose stars at least ${MIN_STAR_SEPARATION_DEG}\u00b0 apart for a good alignment.`);
  }

  // Home assumption: scope az 0 is magnetic north, so true az = scope az + declination.
  let R = rotationZ(declination);

  await gotoStar(ctx, star1, R);
  ctx.log('Adjust with the handset until the star is centred, then press Enter.');
  await waitCentred(ctx, star1, R);
  const p1 = await capture(ctx, star1, 'align');
  R = mulMM(correctionRotation(mulMV(R, sVec(p1)), tVec(p1)), R);
  ctx.log(`${star1.name} recorded.`);

  await gotoStar(ctx, star2, R);
  ctx.log('Adjust with the handset until the star is centred, then press Enter.');
  await waitCentred(ctx, star2, R);
  const p2 = await capture(ctx, star2, 'align');
  ctx.log(`${star2.name} recorded.`);

  const references = [p1, p2];
  R = fitRotation(references, twoStarRotation(sVec(p1), sVec(p2), tVec(p1), tVec(p2)));
  const measuredSep = angleBetweenDeg(sVec(p1), sVec(p2));
  const trueSep = angleBetweenDeg(tVec(p1), tVec(p2));
  const res = fitResiduals(references, R);
  ctx.log(`Star separation: scope ${formatDeg(measuredSep)}, true ${formatDeg(trueSep)}; fit residual RMS altitude ${formatDeg(res.alt)}, azimuth ${formatDeg(res.az)}.`);
  if (Math.abs(measuredSep - trueSep) > MAX_RESIDUAL_WARN_DEG) {
    ctx.log('WARNING: the separation the scope measured does not match the sky. A wrong star may have been centred, or the scope azimuth may count the other way. Check before trusting the alignment.');
  }

  const model = createModel({ R, references, location: ctx.location, declination, target: star2.name });
  model.persist();
  ctx.log(`Alignment saved to ${ALIGNMENT_FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
  return model;
}

// Keeps the star centred until q / Ctrl+C. Enter pauses for a manual adjustment and then syncs the model.
export async function runTrack(ctx, star, model) {
  const state = { adjust: false, paused: false };
  const off = ctx.keys.onKey((name) => {
    if (state.paused) return;
    if (name === 'return') state.adjust = true;
    if (name === 'q') ctx.ctl.cancelled = true;
  });
  const stopNow = () => ctx.ctl.cancelled || state.adjust;
  const opts = { session: ctx.session, tolerance: TRACK_TOLERANCE_DEG, isCancelled: stopNow };
  ctx.log(`Tracking ${star.name}. Enter = pause to adjust the centring by hand and sync, q = quit.`);

  try {
    while (!ctx.ctl.cancelled) {
      if (state.adjust) {
        state.paused = true;
        state.adjust = false;
        await ctx.scope.stopAll();
        ctx.log('\nTracking paused. Centre the star with the handset, then press Enter to sync (Esc = resume without syncing, q = quit).');
        const name = await ctx.keys.wait(['return', 'escape', 'q']);
        state.paused = false;
        if (name === 'interrupt' || name === 'q') {
          ctx.ctl.cancelled = true;
        } else if (name === 'return') {
          const pair = await capture(ctx, star, 'sync');
          const moved = model.sync(pair);
          const n = model.references.length;
          ctx.log(`Synced from ${n} reference star${n === 1 ? '' : 's'}; the model moved by ${formatDeg(moved)}. Resuming tracking.`);
        }
        continue;
      }

      try {
        const t = starTrueAltAz(star, new Date(), ctx.location);
        const s = scopeTarget(model.R, t);
        const problem = reachProblem(star, t, s);
        if (problem) {
          ctx.log(`\n${problem}. Tracking stopped.`);
          break;
        }
        const cur = await ctx.scope.readAltAz();
        const eAlt = s.alt - cur.alt;
        const eAz = norm180(s.az - cur.az);
        const radec = precessFromJ2000(star.raHours, star.decDeg, new Date());
        ctx.status(
          `${star.name} target: Alt ${formatAlt(t.alt)} Az ${formatAz(t.az)} | RA ${formatHours(radec.raHours)} Dec ${formatAlt(radec.decDeg)} (of date)\n` +
            `scope Alt ${formatAlt(cur.alt, 0)} Az ${formatAz(cur.az, 0)} | off by alt ${signed(eAlt)} az ${signed(eAz)} | Enter = adjust+sync, q = quit`,
        );
        if (Math.abs(eAlt) > TRACK_TRIGGER_DEG || Math.abs(eAz) > TRACK_TRIGGER_DEG) {
          // Aim each axis one trigger-width ahead of the star, timed from that axis's own drift rate, so the error
          // sweeps symmetrically either side of centre instead of sawtoothing from 0 to the trigger.
          const dtSec = TRACK_DRIFT_SAMPLE_MS / 1000;
          const sFut = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + TRACK_DRIFT_SAMPLE_MS), ctx.location));
          const leadMs = (deltaDeg) => clampRange((TRACK_AHEAD_DEG * dtSec) / Math.max(Math.abs(deltaDeg), 1e-6) * 1000, TRACK_MIN_LEAD_MS, TRACK_MAX_LEAD_MS);
          if (Math.abs(eAz) > TRACK_TRIGGER_DEG) {
            const aim = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + leadMs(norm180(sFut.azFromHome - s.azFromHome))), ctx.location));
            await slewAxis(ctx.scope, 'az', aim.azFromHome, opts);
          }
          if (Math.abs(eAlt) > TRACK_TRIGGER_DEG) {
            const aim = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + leadMs(sFut.alt - s.alt)), ctx.location));
            await slewAxis(ctx.scope, 'alt', aim.alt, opts);
          }
        }
      } catch (err) {
        if (!(err instanceof CancelledError)) throw err;
      }
      await sleepUntil(TRACK_CYCLE_MS, stopNow);
    }
  } finally {
    off();
    await ctx.scope.stopAll().catch(() => {});
    ctx.log('');
  }
}

async function withSession(values, location, fn) {
  const scope = new Scope(values.port);
  const ctl = { cancelled: false };
  let keys = null;
  try {
    await scope.open();
    keys = openKeys(() => {
      if (ctl.cancelled) {
        scope
          .stopAll()
          .catch(() => {})
          .finally(() => process.exit(130));
      }
      ctl.cancelled = true;
    });
    await fn({
      scope,
      keys,
      ctl,
      location,
      session: newSession(),
      log: (text) => console.log(`\r\x1b[J${text}`),
      // Status may be several lines (separated by \n); the cursor is left on the first line so the next call overwrites them.
      status: (text) => {
        const lines = text.split('\n').map((l) => l.padEnd(120).slice(0, 120));
        process.stdout.write(`\r${lines.join('\n')}${lines.length > 1 ? `\x1b[${lines.length - 1}A` : ''}`);
      },
    });
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err;
    console.log('\nCancelled; the scope has been stopped.');
  } finally {
    await scope.stopAll().catch(() => {});
    keys?.close();
    await scope.close();
  }
}

export async function twoStarCommand(values, name1, name2) {
  if (!name1 || !name2) throw new Error('align2 needs two star names, e.g. align2 vega arcturus (quote names containing spaces)');
  const star1 = findStar(name1);
  const star2 = findStar(name2);
  if (star1.name === star2.name) throw new Error('Choose two different stars.');

  const location = await resolveLocation(values);
  const now = new Date();
  const declination = values.declination !== undefined ? parseDegrees(values.declination) : magneticDeclination(location.latitude, location.longitude, now);
  console.log(`Location : ${signed(location.latitude)}, ${signed(location.longitude)}  (${location.source})`);
  console.log(`Mag decl : ${signed(declination)}  (home = scope Alt 0 / Az 0: level, pointing magnetic north)`);

  const R0 = rotationZ(declination);
  for (const star of [star1, star2]) {
    const t = starTrueAltAz(star, now, location);
    const problem = reachProblem(star, t, scopeTarget(R0, t));
    if (problem) throw new Error(problem);
    if (t.alt < MIN_ALIGN_ALT_DEG) {
      throw new Error(`${star.name} is only ${formatDeg(t.alt)} above the horizon; choose alignment stars above ${MIN_ALIGN_ALT_DEG}\u00b0 so refraction and seeing do not spoil the fit.`);
    }
  }

  await withSession(values, location, async (ctx) => {
    const start = await ctx.scope.readAltAz();
    console.log(`Scope reports: Alt ${formatAlt(start.alt, 0)}  Az ${formatAz(start.az, 0)}`);
    if (Math.abs(start.alt) > HOME_TOLERANCE_DEG || Math.min(start.az, 360 - start.az) > HOME_TOLERANCE_DEG) {
      throw new Error(`At home the scope should report Alt 0 / Az 0 (within ${HOME_TOLERANCE_DEG}\u00b0). Put it at home and power-cycle the handset, then try again.`);
    }
    const model = await runTwoStar(ctx, star1, star2, declination);
    await runTrack(ctx, star2, model);
  });
}

export async function trackCommand(values, name) {
  const rec = loadAlignment();
  const starName = name ?? rec.target?.name;
  if (!starName) throw new Error('track needs a star name, e.g. track vega');
  const star = findStar(starName);
  const location = values.lat !== undefined || values.lon !== undefined ? await resolveLocation(values) : rec.location;
  console.log(`Using the alignment saved ${rec.savedAt}. It is only valid if the handset has not been power-cycled and the scope has not slipped since.`);

  await withSession(values, location, async (ctx) => {
    const model = createModel({
      R: rec.rotation,
      references: rec.references ?? [],
      location,
      declination: rec.magneticDeclinationDeg,
      target: star.name,
    });
    await gotoStar(ctx, star, model.R);
    await runTrack(ctx, star, model);
  });
}
