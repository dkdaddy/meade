import fs from 'node:fs';
import { angularSeparationDeg, norm180, norm360, precessFromJ2000, raDecToAltAz } from './astro.js';
import { formatAlt, formatAz, formatDeg, formatHours, parseDegrees, parseHours } from './angles.js';
import { ALIGNMENT_FILE, MAX_ALT_DEG, MIN_ALT_DEG } from './align.js';
import { resolveLocation } from './location.js';
import { Scope } from './lx200.js';
import { findStar } from './stars.js';
import { AZ_MAX_TARGET_DEG, bestAzFromHome, CancelledError, newSession, slewAxis } from './slew.js';
import { openKeys } from './keys.js';
import { altAzToVec, angleBetweenDeg, correctionRotation, mulMM, mulMV, rotationZ, transpose, twoPointRotation, vecToAltAz } from './pointing.js';

// Two-star/planet alignment and PC-driven tracking.
// The scope only ever receives motion commands (move / stop / move-rate) and read commands: no settings, time,
// site, target or sync commands. The alignment lives entirely on the PC as a rotation between the scope's reported
// Alt/Az and the true Alt/Az; tracking is the PC repeatedly nudging the scope toward where the target is now.

const HOME_TOLERANCE_DEG = 2;
const MIN_STAR_SEPARATION_DEG = 20;
const MAX_RESIDUAL_WARN_DEG = 1;
const TRACK_TRIGGER_DEG = 0.04; // start a correction when the target is this far (about 2.4') from the centre
const TRACK_TOLERANCE_DEG = 0.02;
// A correction aims the axis one trigger-width ahead of the target (in the drift direction) so the error sweeps
// symmetrically from -trigger to +trigger, roughly halving how often a pulse is needed. The lead time is derived
// from the target's measured drift rate and clamped to this window.
const TRACK_AHEAD_DEG = TRACK_TRIGGER_DEG;
const TRACK_MIN_LEAD_MS = 1500;
const TRACK_MAX_LEAD_MS = 20000;
const TRACK_DRIFT_SAMPLE_MS = 4000; // baseline over which the drift rate is measured
const TRACK_CYCLE_MS = 1000;
const MIN_ALIGN_ALT_DEG = 15; // alignment targets should be well up: refraction and seeing blur low targets
const RAD = Math.PI / 180;
const clampRange = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (deg) => formatDeg(deg, { signed: true });

async function sleepUntil(ms, stop) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) await sleep(Math.min(100, end - Date.now()));
}

export function targetRaDec(target, when = new Date(), location = null) {
  if (target.kind === 'planet' || target.kind === 'moon' || typeof target.raDec === 'function') {
    return target.raDec(when, location);
  }
  return precessFromJ2000(target.raHours, target.decDeg, when);
}

export function starTrueAltAz(star, when, location) {
  const p = targetRaDec(star, when, location);
  return raDecToAltAz(p.raHours, p.decDeg, when, location?.latitude, location?.longitude);
}

// Where the scope must read (its own frame) to point at the true Alt/Az `t`, given scope->true rotation R.
export function scopeTarget(R, t, curAzFromHome = 0) {
  const s = vecToAltAz(mulMV(transpose(R), altAzToVec(t.alt, t.az)));
  return { alt: s.alt, az: s.az, azFromHome: bestAzFromHome(s.az, curAzFromHome) };
}

export function reachProblem(star, t, s) {
  if (t.alt < MIN_ALT_DEG) return `${star.name} is only ${formatDeg(t.alt)} above the horizon (minimum ${MIN_ALT_DEG}\u00b0)`;
  if (s.alt < 0 || s.alt >= MAX_ALT_DEG) return `${star.name} needs the scope at altitude ${formatDeg(s.alt)} (allowed 0 to ${MAX_ALT_DEG}\u00b0)`;
  if (Math.abs(s.azFromHome) > AZ_MAX_TARGET_DEG) return `${star.name} needs azimuth ${signed(s.azFromHome)} from home (limit \u00b1${AZ_MAX_TARGET_DEG}\u00b0)`;
  return null;
}

const sVec = (p) => altAzToVec(p.scope.alt, p.scope.az);
const tVec = (p) => altAzToVec(p.true.alt, p.true.az);

// A freshly centred target as a model point. `source` records how the point was set ('align' or 'sync').
async function capture(ctx, star, source) {
  const at = new Date();
  const r = await ctx.scope.readAltAz();
  const t = starTrueAltAz(star, at, ctx.location);
  return { role: 'star', name: star.name, kind: star.kind ?? 'star', source, at: at.toISOString(), scope: { alt: r.alt, az: r.az }, true: { alt: t.alt, az: t.az } };
}

// The home pose as a model point: the scope reads Alt 0 / Az 0 and is assumed level and pointing true north,
// so its true direction is Alt 0, Az 0.
export function homePoint() {
  return { role: 'home', name: 'Home', kind: 'home', source: 'home', at: new Date().toISOString(), scope: { alt: 0, az: 0 }, true: { alt: 0, az: 0 } };
}

async function gotoStar(ctx, star, R) {
  const curAz = ctx.session?.az ?? 0;
  const t = starTrueAltAz(star, new Date(), ctx.location);
  const s = scopeTarget(R, t, curAz);
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
      const s = scopeTarget(R, starTrueAltAz(star, new Date(), ctx.location), ctx.session?.az ?? 0);
      ctx.status(`scope Alt ${formatAlt(r.alt, 0)} Az ${formatAz(r.az, 0)} | target predicted at Alt ${formatAlt(s.alt)} Az ${formatAz(s.az)} | Enter = centred`);
    } catch {
      // ignore a missed poll
    }
    await sleepUntil(500, () => done);
  }
  if ((await key) === 'interrupt') throw new CancelledError();
  ctx.status('');
}

// Shows the live reading until Enter is pressed with the scope reading Alt 0 / Az 0 (within HOME_TOLERANCE_DEG).
async function waitHome(ctx) {
  for (;;) {
    let done = false;
    const key = ctx.keys.wait(['return']).then((k) => {
      done = true;
      return k;
    });
    while (!done) {
      try {
        const r = await ctx.scope.readAltAz();
        ctx.status(`scope Alt ${formatAlt(r.alt, 0)} Az ${formatAz(r.az, 0)} | Enter = at home (Alt 0 / Az 0)`);
      } catch {
        // ignore a missed poll
      }
      await sleepUntil(500, () => done);
    }
    if ((await key) === 'interrupt') throw new CancelledError();
    ctx.status('');
    const r = await ctx.scope.readAltAz();
    if (Math.abs(r.alt) <= HOME_TOLERANCE_DEG && Math.min(r.az, 360 - r.az) <= HOME_TOLERANCE_DEG) return r;
    ctx.log(`Scope reads Alt ${formatAlt(r.alt, 0)} Az ${formatAz(r.az, 0)}, not Alt 0 / Az 0 (within ${HOME_TOLERANCE_DEG}\u00b0). Move it to home and press Enter again.`);
  }
}

// Human-readable orientation facts derived from the scope->true rotation R, for the saved file: how far the
// scope's vertical axis is from true vertical (levelness) and where the home pose (scope Alt 0 / Az 0) actually
// points relative to true level and true north.
export function describeAlignment(R) {
  const up = mulMV(R, [0, 0, 1]);
  const levelnessDeg = angleBetweenDeg([0, 0, 1], up);
  const levelLeanAzimuthDeg = norm360(Math.atan2(up[1], up[0]) / RAD);
  const homeTrue = vecToAltAz(mulMV(R, altAzToVec(0, 0)));
  const homeLevelErrorDeg = homeTrue.alt; // + = scope's home points above true level
  const homeHeadingErrorDeg = norm180(homeTrue.az); // + = east of true north
  const side = (v, pos, neg) => `${formatDeg(Math.abs(v))} ${v >= 0 ? pos : neg}`;
  const lean = levelnessDeg >= 0.05 ? ` (leaning toward Az ${formatAz(levelLeanAzimuthDeg)})` : '';
  const summary =
    `Scope base tilts ${formatDeg(levelnessDeg)} from level${lean}; at home (scope Alt 0 / Az 0) it points ` +
    `true Alt ${formatAlt(homeTrue.alt)} Az ${formatAz(homeTrue.az)} \u2014 ${side(homeLevelErrorDeg, 'above level', 'below level')} and ` +
    `${side(homeHeadingErrorDeg, 'east of true north', 'west of true north')}.`;
  return { levelnessDeg, levelLeanAzimuthDeg, homeTrueAltDeg: homeTrue.alt, homeTrueAzDeg: homeTrue.az, homeLevelErrorDeg, homeHeadingErrorDeg, summary };
}

function saveAlignment({ location, R, points, target }) {
  const record = {
    version: 2,
    savedAt: new Date().toISOString(),
    location: { latitude: location.latitude, longitude: location.longitude, source: location.source },
    frame: 'x true north, y east, z up; true = rotation * scope (scope Alt 0 / Az 0 = home)',
    rotation: R,
    diagnostics: describeAlignment(R),
    points,
    target: { name: target },
  };
  fs.writeFileSync(ALIGNMENT_FILE, JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function loadAlignment() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(ALIGNMENT_FILE, 'utf8'));
  } catch {
    throw new Error('No saved alignment. Run align <target> or align2 <star1> <star2> first.');
  }
  if (rec.version !== 2 || !Array.isArray(rec.rotation) || !Array.isArray(rec.points)) {
    throw new Error('The saved alignment is in an unsupported format. Re-run align <target> or align2 <star1> <star2>.');
  }
  return rec;
}

// Scope->true rotation that seeds on `anchor` (satisfied as the starting pose) and makes `other` exact.
export const fitTwoPoints = (anchor, other) => twoPointRotation(sVec(anchor), tVec(anchor), sVec(other), tVec(other));

// Index of the stored point nearest to `pair` in the sky (true-position angular separation).
export function closestPointIndex(points, pair) {
  let best = 0;
  let bestSep = Infinity;
  points.forEach((p, i) => {
    const sep = angleBetweenDeg(tVec(p), tVec(pair));
    if (sep < bestSep) {
      bestSep = sep;
      best = i;
    }
  });
  return best;
}

// Per-axis RMS of the fit, in degrees: altitude error, and azimuth error reduced to a great-circle angle.
function fitResiduals(points, R) {
  const alt = [];
  const az = [];
  for (const p of points) {
    const pred = vecToAltAz(mulMV(R, sVec(p)));
    alt.push(pred.alt - p.true.alt);
    az.push(norm180(pred.az - p.true.az) * Math.cos(p.true.alt * RAD));
  }
  const rms = (xs) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
  return { alt: rms(alt), az: rms(az) };
}

// The pointing model: exactly two reference points and the scope->true rotation they define. A sync replaces the
// point closest to the fresh measurement in the sky; the retained point is the anchor and the new one ends exact,
// so the model never grows past two points.
export function createModel({ R, points, location, target }) {
  const model = {
    R,
    points,
    target,
    persist() {
      saveAlignment({ location, R: model.R, points: model.points, target: model.target });
    },
    sync(pair) {
      const moved = angleBetweenDeg(mulMV(model.R, sVec(pair)), tVec(pair));
      const idx = closestPointIndex(model.points, pair);
      const retained = model.points[1 - idx];
      model.points = [retained, pair];
      // The freshly centred measurement is trusted, so it is the anchor (kept exact); the retained point fixes
      // the remaining twist. The model never grows past two points.
      model.R = fitTwoPoints(pair, retained);
      model.persist();
      return moved;
    },
  };
  return model;
}

export async function runTwoStar(ctx, star1, star2) {
  const now = new Date();
  const c1 = targetRaDec(star1, now, ctx.location);
  const c2 = targetRaDec(star2, now, ctx.location);
  const sep = angularSeparationDeg(c1.raHours, c1.decDeg, c2.raHours, c2.decDeg);
  if (sep < MIN_STAR_SEPARATION_DEG) {
    throw new Error(`${star1.name} and ${star2.name} are only ${formatDeg(sep)} apart; choose targets at least ${MIN_STAR_SEPARATION_DEG}\u00b0 apart for a good alignment.`);
  }

  // Home assumption: scope az 0 is true north, so the scope frame starts out equal to the true frame.
  let R = rotationZ(0);

  await gotoStar(ctx, star1, R);
  ctx.log('Adjust with the handset until centred, then press Enter.');
  await waitCentred(ctx, star1, R);
  const p1 = await capture(ctx, star1, 'align');
  // Correct the home seed so star 1 is satisfied, giving a good rotation to slew to star 2 with.
  R = mulMM(correctionRotation(mulMV(R, sVec(p1)), tVec(p1)), R);
  ctx.log(`${star1.name} recorded.`);

  await gotoStar(ctx, star2, R);
  ctx.log('Adjust with the handset until centred, then press Enter.');
  await waitCentred(ctx, star2, R);
  const p2 = await capture(ctx, star2, 'align');
  ctx.log(`${star2.name} recorded.`);

  // Two-point model anchored on star 1's reading (home is not stored).
  const points = [p1, p2];
  R = fitTwoPoints(p1, p2);
  const measuredSep = angleBetweenDeg(sVec(p1), sVec(p2));
  const trueSep = angleBetweenDeg(tVec(p1), tVec(p2));
  const res = fitResiduals(points, R);
  ctx.log(`Target separation: scope ${formatDeg(measuredSep)}, true ${formatDeg(trueSep)}; fit residual RMS altitude ${formatDeg(res.alt)}, azimuth ${formatDeg(res.az)}.`);
  if (Math.abs(measuredSep - trueSep) > MAX_RESIDUAL_WARN_DEG) {
    ctx.log('WARNING: the separation the scope measured does not match the sky. A wrong target may have been centred, or the scope azimuth may count the other way. Check before trusting the alignment.');
  }

  const model = createModel({ R, points, location: ctx.location, target: star2.name });
  model.persist();
  ctx.log(describeAlignment(R).summary);
  ctx.log(`Alignment saved to ${ALIGNMENT_FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
  return model;
}

// Keeps the target centred until q / Ctrl+C. Enter pauses for a manual adjustment and then syncs the model.
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
        ctx.log('\nTracking paused. Centre target with the handset, then press Enter to sync (Esc = resume without syncing, q = quit).');
        const name = await ctx.keys.wait(['return', 'escape', 'q']);
        state.paused = false;
        if (name === 'interrupt' || name === 'q') {
          ctx.ctl.cancelled = true;
        } else if (name === 'return') {
          const pair = await capture(ctx, star, 'sync');
          const moved = model.sync(pair);
          const names = model.points.map((p) => p.name).join(' + ');
          ctx.log(`Synced; the model moved by ${formatDeg(moved)} and now fits ${names}. Resuming tracking.`);
        }
        continue;
      }

      try {
        const curAz = ctx.session?.az ?? 0;
        const t = starTrueAltAz(star, new Date(), ctx.location);
        const s = scopeTarget(model.R, t, curAz);
        const problem = reachProblem(star, t, s);
        if (problem) {
          ctx.log(`\n${problem}. Tracking stopped.`);
          break;
        }
        const cur = await ctx.scope.readAltAz();
        const eAlt = s.alt - cur.alt;
        const eAz = norm180(s.az - cur.az);
        const radec = targetRaDec(star, new Date(), ctx.location);
        ctx.status(
          `${star.name} target: Alt ${formatAlt(t.alt)} Az ${formatAz(t.az)} | RA ${formatHours(radec.raHours)} Dec ${formatAlt(radec.decDeg)} (of date)\n` +
            `scope Alt ${formatAlt(cur.alt, 0)} Az ${formatAz(cur.az, 0)} | off by alt ${signed(eAlt)} az ${signed(eAz)} | Enter = adjust+sync, q = quit`,
        );
        if (Math.abs(eAlt) > TRACK_TRIGGER_DEG || Math.abs(eAz) > TRACK_TRIGGER_DEG) {
          // Aim each axis one trigger-width ahead of the target, timed from that axis's own drift rate, so the error
          // sweeps symmetrically either side of centre instead of sawtoothing from 0 to the trigger.
          const dtSec = TRACK_DRIFT_SAMPLE_MS / 1000;
          const sFut = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + TRACK_DRIFT_SAMPLE_MS), ctx.location), curAz);
          const leadMs = (deltaDeg) => clampRange((TRACK_AHEAD_DEG * dtSec) / Math.max(Math.abs(deltaDeg), 1e-6) * 1000, TRACK_MIN_LEAD_MS, TRACK_MAX_LEAD_MS);
          if (Math.abs(eAz) > TRACK_TRIGGER_DEG) {
            const aim = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + leadMs(sFut.azFromHome - s.azFromHome)), ctx.location), curAz);
            await slewAxis(ctx.scope, 'az', aim.azFromHome, opts);
          }
          if (Math.abs(eAlt) > TRACK_TRIGGER_DEG) {
            const aim = scopeTarget(model.R, starTrueAltAz(star, new Date(Date.now() + leadMs(sFut.alt - s.alt)), ctx.location), curAz);
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
  if (!name1 || !name2) throw new Error('align2 needs two target names, e.g. align2 moon vega or align2 jupiter vega (quote names containing spaces)');
  const location = await resolveLocation(values);
  const now = new Date();
  const star1 = findStar(name1, now, location);
  const star2 = findStar(name2, now, location);
  if (star1.name === star2.name) throw new Error('Choose two different targets.');

  console.log(`Location : ${signed(location.latitude)}, ${signed(location.longitude)}  (${location.source})`);
  console.log('Home     : scope Alt 0 / Az 0 = level, pointing true north');

  const R0 = rotationZ(0);
  for (const star of [star1, star2]) {
    const t = starTrueAltAz(star, now, location);
    const problem = reachProblem(star, t, scopeTarget(R0, t, 0));
    if (problem) throw new Error(problem);
    if (t.alt < MIN_ALIGN_ALT_DEG) {
      throw new Error(`${star.name} is only ${formatDeg(t.alt)} above the horizon; choose alignment targets above ${MIN_ALIGN_ALT_DEG}\u00b0 so refraction and seeing do not spoil the fit.`);
    }
  }

  await withSession(values, location, async (ctx) => {
    const start = await ctx.scope.readAltAz();
    console.log(`Scope reports: Alt ${formatAlt(start.alt, 0)}  Az ${formatAz(start.az, 0)}`);
    if (Math.abs(start.alt) > HOME_TOLERANCE_DEG || Math.min(start.az, 360 - start.az) > HOME_TOLERANCE_DEG) {
      throw new Error(`At home the scope should report Alt 0 / Az 0 (within ${HOME_TOLERANCE_DEG}\u00b0). Put it at home and power-cycle the handset, then try again.`);
    }
    const model = await runTwoStar(ctx, star1, star2);
    await runTrack(ctx, star2, model);
  });
}

export async function trackCommand(values, name) {
  const rec = loadAlignment();
  const starName = name ?? rec.target?.name;
  if (!starName) throw new Error('track needs a target name, e.g. track moon, track vega or track jupiter');
  const location = values.lat !== undefined || values.lon !== undefined ? await resolveLocation(values) : rec.location;
  const star = findStar(starName, new Date(), location);
  console.log(`Using the alignment saved ${rec.savedAt}. It is only valid if the handset has not been power-cycled and the scope has not slipped since.`);

  await withSession(values, location, async (ctx) => {
    const model = createModel({
      R: rec.rotation,
      points: rec.points ?? [],
      location,
      target: star.name,
    });
    await gotoStar(ctx, star, model.R);
    await runTrack(ctx, star, model);
  });
}

// A fixed-coordinate target from --ra/--dec: of-date RA/Dec that raDecToAltAz re-projects as the sky turns, so
// tracking still works within the session (the name is not re-loadable by `track`, which looks targets up by name).
function manualTarget(values) {
  if (values.ra === undefined || values.dec === undefined) {
    throw new Error('align with coordinates needs both --ra and --dec, e.g. align --ra 18:36:56 --dec=+38:47:01');
  }
  const raHours = parseHours(values.ra);
  const decDeg = parseDegrees(values.dec);
  if (Math.abs(decDeg) > 90) throw new Error('Dec must be within +/-90 degrees');
  return { name: 'manual target', kind: 'star', raHours, decDeg, raDec: () => ({ raHours, decDeg }) };
}

// Single-target alignment: home (scope Alt 0 / Az 0) and the centred target are the two points. You move the scope
// to home and press Enter, it slews to the target using the home assumption, you centre it with the handset and
// press Enter, then it tracks the target.
export async function runOneStar(ctx, star) {
  const R0 = rotationZ(0);
  ctx.log('Physically move the scope to level and pointing north, then power the handset off and on so it resets to Alt 0 / Az 0. Press Enter when it reads 0 / 0.');
  await waitHome(ctx);
  await gotoStar(ctx, star, R0);
  ctx.log(`Centre ${star.name} with the handset, then press Enter.`);
  await waitCentred(ctx, star, R0);
  const p1 = await capture(ctx, star, 'align');

  const home = homePoint();
  const points = [home, p1];
  // The star is the measurement, so it is the anchor (kept exact); home fixes the remaining twist.
  const R = fitTwoPoints(p1, home);
  const model = createModel({ R, points, location: ctx.location, target: star.name });
  model.persist();
  ctx.log(describeAlignment(R).summary);
  ctx.log(`Alignment saved to ${ALIGNMENT_FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
  return model;
}

export async function oneStarCommand(values, name) {
  const haveCoords = values.ra !== undefined || values.dec !== undefined;
  if (!name && !haveCoords) throw new Error('align needs a target name (e.g. align vega or align jupiter) or --ra and --dec');
  if (name && haveCoords) throw new Error('Give either a target name or --ra/--dec, not both.');
  const location = await resolveLocation(values);
  const now = new Date();
  const star = haveCoords ? manualTarget(values) : findStar(name, now, location);

  console.log(`Location : ${signed(location.latitude)}, ${signed(location.longitude)}  (${location.source})`);
  console.log('Home     : scope Alt 0 / Az 0 = level, pointing true north');

  const R0 = rotationZ(0);
  const t = starTrueAltAz(star, now, location);
  const problem = reachProblem(star, t, scopeTarget(R0, t, 0));
  if (problem) throw new Error(problem);
  if (t.alt < MIN_ALIGN_ALT_DEG) {
    throw new Error(`${star.name} is only ${formatDeg(t.alt)} above the horizon; choose an alignment target above ${MIN_ALIGN_ALT_DEG}\u00b0 so refraction and seeing do not spoil the fit.`);
  }

  await withSession(values, location, async (ctx) => {
    const model = await runOneStar(ctx, star);
    await runTrack(ctx, star, model);
  });
}
