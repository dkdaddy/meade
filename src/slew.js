import { formatAlt, formatAz, formatDeg } from './angles.js';
import { norm180 } from './astro.js';
import { MAX_ALT_DEG } from './align.js';
import { Scope } from './lx200.js';

// Closed-loop single-axis slews in the scope's own reported frame (Alt 0 / Az 0 = home).
// The Autostar has no "slew to Alt/Az" command, so this presses the direction key, watches :GA# / :GZ#,
// and releases it at the target, stepping down through the handset's move rates (Slew, Move, Center, Guide).
// Nothing but motion commands is sent: no settings, time, site, target or sync commands.

const ALT_FLOOR_DEG = -1; // hard stop: never let the tube point (meaningfully) below the horizon
const AZ_STOP_DEG = 301; // hard stop: +/-300 from home, with 1 deg settle margin
export const AZ_MAX_TARGET_DEG = 300;

export function bestAzFromHome(dialAz, curAzFromHome = 0, maxTargetDeg = AZ_MAX_TARGET_DEG) {
  const norm = ((dialAz % 360) + 360) % 360;
  const candidates = [norm, norm - 360].filter((deg) => Math.abs(deg) <= maxTargetDeg);
  if (candidates.length === 0) {
    return norm <= 180 ? norm : norm - 360;
  }
  candidates.sort((a, b) => Math.abs(a - curAzFromHome) - Math.abs(b - curAzFromHome));
  return candidates[0];
}
const TOLERANCE_DEG = 0.03; // about 2 arcminutes
const POLL_MS = 80;
const REFINE_RATE = 'C'; // the Guide rate (:RG#) does not visibly move the Autostar axes
const REFINE_START_LEAD_DEG = 0.04; // first guess at how far the axis coasts after the key is released
const REFINE_MAX_ATTEMPTS = 8;
const PULSE_SETTLE_MS = 500;
const STALL_MS = 4000;
// Altitude starts slowly and has large gear backlash, so any key press first winds through the slack before the
// reading moves; the direction test, coarse stall watchdog and refine start-up all allow an axis `startGraceMs`
// before concluding nothing is happening. PROBE_EXTRA_MS is the extra watch time on top of that grace.
const PROBE_EXTRA_MS = 1500;
const PROBE_MIN_MOVE_DEG = 0.005;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (deg) => formatDeg(deg, { signed: true });

// Coarse phases hold the key at one rate until within `until` degrees of the goal (or the target is overshot);
// they fail on timeout / stall. The final degree is closed by short measured pulses (see below).
const PHASES = [
  { rate: 'S', until: 6, grow: 1.0, maxMs: 120000, strict: true },
  { rate: 'M', until: 1, grow: 1.0, maxMs: 60000, strict: true },
];

// plus/minus are the Autostar direction keys assumed to increase/decrease the reading; the real mapping is
// measured with a short test move before the main slew.
const AXES = {
  alt: {
    label: 'altitude',
    plus: 'n',
    minus: 's',
    startGraceMs: 4000, // slow to start and heavy backlash: wait this long for first motion before giving up
    read: async (scope) => {
      const r = await scope.readAlt();
      return { deg: r.deg, text: formatAlt(r.deg, 0) };
    },
    violation: (deg) => {
      if (deg >= MAX_ALT_DEG) return `altitude ${formatDeg(deg)} is at the ${MAX_ALT_DEG}\u00b0 ceiling`;
      if (deg < ALT_FLOOR_DEG) return `altitude ${formatDeg(deg)} is below the ${ALT_FLOOR_DEG}\u00b0 floor`;
      return null;
    },
    goal: (target) => {
      if (!(target >= 0 && target < MAX_ALT_DEG)) throw new Error(`Altitude must be from 0 up to (not including) ${MAX_ALT_DEG} degrees`);
      return target;
    },
  },
  az: {
    label: 'azimuth',
    plus: 'e',
    minus: 'w',
    startGraceMs: 1500, // azimuth starts promptly and has little backlash
    // Azimuth is handled as unwrapped degrees from home in [-300, 300].
    read: async (scope, session, goal) => {
      const r = await scope.readAz();
      if (session) {
        if (session.az === undefined) {
          const candidates = [r.deg, r.deg - 360].filter((d) => Math.abs(d) <= AZ_STOP_DEG);
          if (candidates.length === 1) {
            session.az = candidates[0];
          } else if (candidates.length > 1) {
            const ref = goal !== undefined ? goal : 0;
            candidates.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
            session.az = candidates[0];
          } else {
            session.az = norm180(r.deg);
          }
          session.lastRawAz = r.deg;
        } else {
          const delta = norm180(r.deg - session.lastRawAz);
          session.az += delta;
          session.lastRawAz = r.deg;
        }
        return { deg: session.az, text: formatAz(r.deg, 0) };
      }
      return { deg: norm180(r.deg), text: formatAz(r.deg, 0) };
    },
    violation: (deg) => (Math.abs(deg) >= AZ_STOP_DEG ? `azimuth ${signed(deg)} from home is at the \u00b1300\u00b0 limit` : null),
    goal: (target) => {
      if (Math.abs(target) > AZ_MAX_TARGET_DEG) {
        throw new Error(`Azimuth target ${signed(target)} from home is too close to the \u00b1300\u00b0 limit (max \u00b1${AZ_MAX_TARGET_DEG}\u00b0)`);
      }
      return target;
    },
  },
};

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

// A session remembers, per axis, which direction key raises the reading and how far the axis coasts after a key is
// released, so repeated small slews (tracking) skip the direction test.
export const newSession = () => ({ keys: {}, lead: {} });

// Direction test: hold the key toward the target and watch the reading to learn which key raises it. The key is
// held continuously (not pulsed) so a slow axis with large gear backlash has time to wind through the slack and
// actually start moving, rather than re-engaging the backlash from rest on every short pulse. :GA# / :GZ#
// feedback and the violation check run every poll, so the motion stays bounded and stops the instant movement is
// confirmed or a limit is reached. Stores the result in session.keys and returns the fresh reading.
async function learnDirection(scope, axisName, goal, cur, readCur, session, isCancelled) {
  const axis = AXES[axisName];
  const err0 = goal - cur.deg;
  const testKey = err0 > 0 ? axis.plus : axis.minus;
  const otherKey = testKey === axis.plus ? axis.minus : axis.plus;
  const probeRate = Math.abs(err0) > 1 ? 'M' : REFINE_RATE;
  const probeDeadline = Date.now() + axis.startGraceMs + PROBE_EXTRA_MS;
  let signal = 0; // signed movement of greatest magnitude seen, measured from the start reading
  await scope.command(`:R${probeRate}#`);
  await scope.command(`:M${testKey}#`);
  try {
    while (Date.now() < probeDeadline && Math.abs(signal) < PROBE_MIN_MOVE_DEG) {
      await sleep(POLL_MS);
      if (isCancelled()) throw new CancelledError();
      const r = await readCur();
      const delta = r.deg - cur.deg;
      if (Math.abs(delta) > Math.abs(signal)) signal = delta;
      const v = axis.violation(r.deg);
      if (v) {
        await scope.stopAll();
        throw new Error(`Stopped: ${v}.`);
      }
    }
  } finally {
    await scope.stopAll();
  }
  await sleep(PULSE_SETTLE_MS);
  const settled = await readCur();
  const settledDelta = settled.deg - cur.deg;
  if (Math.abs(settledDelta) > Math.abs(signal)) signal = settledDelta;
  if (Math.abs(signal) < PROBE_MIN_MOVE_DEG) {
    throw new Error(`The ${axis.label} reading did not change during the direction test (it stayed at ${cur.text}). The motor may not be driving this axis, or the handset is not reporting live ${axis.label}; check that ${axis.label} changes in "monitor" when you nudge it with the handset.`);
  }
  session.keys[axisName] = { increaseKey: signal > 0 ? testKey : otherKey, decreaseKey: signal > 0 ? otherKey : testKey };
  const after = await readCur();
  const afterViolation = axis.violation(after.deg);
  if (afterViolation) throw new Error(`Stopped: ${afterViolation}.`);
  return after;
}

// Slews altitude and azimuth at the same time. The move-rate setting is global, so both axes run each coarse phase
// (Slew, then Move) together at the same rate; an axis that arrives early is stopped on its own (:Qn# etc.) and waits
// for the other before the rate changes. Direction keys are learned one axis at a time first (the test needs a lone
// moving axis). The final Center-rate approach is then done per axis by slewAxis. Only one loop talks to the serial
// link, so queries never interleave.
export async function slewBoth(scope, targets, { onStatus = () => {}, session = newSession(), tolerance = TOLERANCE_DEG, isCancelled = () => false } = {}) {
  const names = ['az', 'alt'];
  const goals = {};
  const cur = {};
  const readers = {};
  for (const n of names) goals[n] = AXES[n].goal(targets[n]);

  try {
    for (const n of names) {
      const axis = AXES[n];
      readers[n] = () => axis.read(scope, session, goals[n]);
      cur[n] = await readers[n]();
      const v = axis.violation(cur[n].deg);
      if (v) throw new Error(`Refusing to move: ${v}. Put the scope at home and power-cycle the handset so it reads Alt 0 / Az 0.`);
    }
    for (const n of names) {
      if (!session.keys[n] && Math.abs(goals[n] - cur[n].deg) > tolerance) {
        cur[n] = await learnDirection(scope, n, goals[n], cur[n], readers[n], session, isCancelled);
      }
    }

    for (const phase of PHASES) {
      const st = {};
      for (const n of names) {
        const err = goals[n] - cur[n].deg;
        if (Math.abs(err) <= phase.until) continue;
        st[n] = { startSign: Math.sign(err), best: Math.abs(err), lastDeg: cur[n].deg, lastProgressAt: Date.now(), pressed: null, done: false };
      }
      const active = Object.keys(st);
      if (active.length === 0) continue;

      await scope.command(`:R${phase.rate}#`);
      const phaseStart = Date.now();
      for (const n of active) {
        const keys = session.keys[n];
        st[n].pressed = goals[n] - cur[n].deg > 0 ? keys.increaseKey : keys.decreaseKey;
        st[n].lastProgressAt = Date.now();
        await scope.command(`:M${st[n].pressed}#`);
      }

      while (active.some((n) => !st[n].done)) {
        await sleep(POLL_MS);
        if (isCancelled()) throw new CancelledError();
        if (Date.now() - phaseStart > phase.maxMs) throw new Error(`Timed out slewing (rate ${phase.rate})`);
        for (const n of active) {
          const s = st[n];
          if (s.done) continue;
          const axis = AXES[n];
          cur[n] = await readers[n]();
          const violation = axis.violation(cur[n].deg);
          if (violation) throw new Error(`Stopped: ${violation}.`);
          const err = goals[n] - cur[n].deg;
          const abs = Math.abs(err);
          onStatus({ axis: axis.label, reading: cur[n].text, deg: cur[n].deg, goal: goals[n], toGo: err, rate: phase.rate });
          if (abs <= phase.until || Math.sign(err) !== s.startSign) {
            s.done = true;
            await scope.command(`:Q${s.pressed}#`); // stop just this axis; the other keeps moving
            continue;
          }
          if (abs < s.best) s.best = abs;
          if (abs > s.best + phase.grow) throw new Error(`Stopped: ${axis.label} is moving away from the target.`);
          if (Math.abs(cur[n].deg - s.lastDeg) > 0.005) {
            s.lastDeg = cur[n].deg;
            s.lastProgressAt = Date.now();
          } else if (Date.now() - s.lastProgressAt > Math.max(STALL_MS, axis.startGraceMs)) {
            throw new Error(`Stopped: ${axis.label} stopped moving before reaching the target.`);
          }
        }
      }

      await scope.stopAll();
      await sleep(250); // let the axes come to rest before changing rate
      for (const n of names) cur[n] = await readers[n]();
    }
  } finally {
    await scope.stopAll().catch(() => {});
  }

  const opts = { onStatus, session, tolerance, isCancelled };
  const az = await slewAxis(scope, 'az', targets.az, opts);
  const alt = await slewAxis(scope, 'alt', targets.alt, opts);
  return { az, alt };
}

export async function slewAxis(scope, axisName, target, { onStatus = () => {}, session = newSession(), tolerance = TOLERANCE_DEG, isCancelled = () => false } = {}) {
  const axis = AXES[axisName];
  if (!axis) throw new Error(`Unknown axis "${axisName}"`);
  if (!Number.isFinite(target)) throw new Error('Target must be a number of degrees');
  const goal = axis.goal(target);

  const readCur = () => axis.read(scope, session, goal);

  try {
    let cur = await readCur();
    const startViolation = axis.violation(cur.deg);
    if (startViolation) {
      throw new Error(`Refusing to move: ${startViolation}. Put the scope at home and power-cycle the handset so it reads Alt 0 / Az 0.`);
    }
    if (Math.abs(goal - cur.deg) <= tolerance) return { final: cur.deg, error: goal - cur.deg, text: cur.text };

    if (!session.keys[axisName]) cur = await learnDirection(scope, axisName, goal, cur, readCur, session, isCancelled);
    const { increaseKey, decreaseKey } = session.keys[axisName];

    for (const phase of PHASES) {
      if (Math.abs(goal - cur.deg) <= phase.until) continue;
      const startSign = Math.sign(goal - cur.deg);
      await scope.command(`:R${phase.rate}#`);

      let pressed = null;
      let best = Math.abs(goal - cur.deg);
      let lastDeg = cur.deg;
      const phaseStart = Date.now();
      let lastProgressAt = phaseStart;
      const stallMs = Math.max(STALL_MS, axis.startGraceMs); // allow backlash take-up before calling it a stall

      for (;;) {
        const err = goal - cur.deg;
        if (Math.abs(err) <= phase.until || Math.sign(err) !== startSign) break; // arrived, or overshot
        if (Date.now() - phaseStart > phase.maxMs) {
          if (phase.strict) throw new Error(`Timed out slewing ${axis.label} (rate ${phase.rate})`);
          break;
        }
        if (!pressed) {
          pressed = err > 0 ? increaseKey : decreaseKey;
          await scope.command(`:M${pressed}#`);
        }
        await sleep(POLL_MS);
        if (isCancelled()) throw new CancelledError();
        cur = await readCur();

        const violation = axis.violation(cur.deg);
        if (violation) throw new Error(`Stopped: ${violation}.`);
        const abs = Math.abs(goal - cur.deg);
        onStatus({ axis: axis.label, reading: cur.text, deg: cur.deg, goal, toGo: goal - cur.deg, rate: phase.rate });
        if (abs < best) best = abs;
        if (abs > best + phase.grow) throw new Error(`Stopped: ${axis.label} is moving away from the target.`);
        if (Math.abs(cur.deg - lastDeg) > 0.005) {
          lastDeg = cur.deg;
          lastProgressAt = Date.now();
        } else if (phase.strict && Date.now() - lastProgressAt > stallMs) {
          throw new Error(`Stopped: ${axis.label} stopped moving before reaching the target.`);
        }
      }

      await scope.stopAll();
      await sleep(250); // let the axis come to rest before reading or changing rate
      cur = await readCur();
    }

    // Final approach at the Center rate. The key is held until the axis has visibly started moving (the handset lags
    // ~0.4 s), then released when the remaining distance equals `lead`, the distance the axis keeps travelling after
    // release. After each attempt the settled reading shows how far it really coasted, and `lead` is updated.
    await scope.command(`:R${REFINE_RATE}#`);
    let lead = session.lead[axisName] ?? REFINE_START_LEAD_DEG;
    for (let attempt = 0; attempt < REFINE_MAX_ATTEMPTS; attempt++) {
      const err = goal - cur.deg;
      if (Math.abs(err) <= tolerance) break;
      const dir = Math.sign(err);
      const key = dir > 0 ? increaseKey : decreaseKey;
      const startDeg = cur.deg;
      const maxMs = axis.startGraceMs + (Math.abs(err) / 0.05) * 1000;
      const attemptStart = Date.now();
      let moving = false;
      let trigger = cur;
      await scope.command(`:M${key}#`);
      for (;;) {
        await sleep(POLL_MS);
        if (isCancelled()) throw new CancelledError();
        cur = await readCur();
        const violation = axis.violation(cur.deg);
        if (violation) throw new Error(`Stopped: ${violation}.`);
        const remaining = (goal - cur.deg) * dir;
        onStatus({ axis: axis.label, reading: cur.text, deg: cur.deg, goal, toGo: goal - cur.deg, rate: REFINE_RATE });
        if (Math.abs(cur.deg - startDeg) >= 0.002) moving = true;
        trigger = cur;
        if (moving && remaining <= lead) break;
        if (Date.now() - attemptStart > maxMs) break;
      }
      await scope.stopAll();
      await sleep(PULSE_SETTLE_MS);
      cur = await readCur();
      const coast = (cur.deg - trigger.deg) * dir; // distance travelled after release
      if (moving && coast > 0) lead = Math.min(0.25, Math.max(0.01, coast));
      session.lead[axisName] = lead;
    }
    return { final: cur.deg, error: goal - cur.deg, text: cur.text };
  } finally {
    await scope.stopAll().catch(() => {});
  }
}

export async function slewCommand(portPath, axisName, target) {
  const scope = new Scope(portPath);
  await scope.open();
  process.once('SIGINT', () => {
    scope
      .stopAll()
      .catch(() => {})
      .finally(() => process.exit(130));
  });
  try {
    console.log(`Slewing ${AXES[axisName].label} to ${signed(target)} in the scope's frame (Alt 0 / Az 0 = home). Ctrl+C stops the scope.`);
    const result = await slewAxis(scope, axisName, target, {
      onStatus: (s) => process.stdout.write(`\r  ${s.axis} ${s.reading}  to go ${signed(s.toGo)}  rate ${s.rate}   `),
    });
    console.log(`\nDone. ${AXES[axisName].label} reads ${result.text ?? ''} (${signed(result.error)} from the target).`);
  } finally {
    await scope.close();
  }
}

// Drives the scope back to home (Alt 0 / Az 0 in its reported frame): azimuth first, then altitude down to level,
// so the tube stays raised while it swings round. This trusts the handset's reference (the "current alignment"):
// reported 0/0 is home only while the handset has not been power-cycled or lost its position.
export async function goHomeCommand(portPath) {
  const scope = new Scope(portPath);
  await scope.open();
  process.once('SIGINT', () => {
    scope
      .stopAll()
      .catch(() => {})
      .finally(() => process.exit(130));
  });
  try {
    const start = await scope.readAltAz();
    console.log(`Scope reports Alt ${formatAlt(start.alt, 0)} Az ${formatAz(start.az, 0)}. Slewing to home (Alt 0 / Az 0). Ctrl+C stops the scope.`);
    const session = newSession();
    const onStatus = (s) => process.stdout.write(`\r  ${s.axis} ${s.reading}  to go ${signed(s.toGo)}  rate ${s.rate}   `);
    await slewAxis(scope, 'az', 0, { onStatus, session });
    await slewAxis(scope, 'alt', 0, { onStatus, session });
    const end = await scope.readAltAz();
    console.log(`\nAt home. Scope reads Alt ${formatAlt(end.alt)} Az ${formatAz(end.az)}.`);
  } finally {
    await scope.stopAll().catch(() => {});
    await scope.close();
  }
}

