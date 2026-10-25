import { formatAlt, formatAz, formatDeg } from './angles.js';
import { norm180 } from './astro.js';
import { MAX_ALT_DEG } from './align.js';
import { Scope } from './lx200.js';

// Closed-loop single-axis slews in the scope's own reported frame (Alt 0 / Az 0 = home).
// The Autostar has no "slew to Alt/Az" command, so this presses the direction key, watches :GA# / :GZ#,
// and releases it at the target, stepping down through the handset's move rates (Slew, Move, Center, Guide).
// Nothing but motion commands is sent: no settings, time, site, target or sync commands.

const ALT_FLOOR_DEG = -1; // hard stop: never let the tube point (meaningfully) below the horizon
const AZ_STOP_DEG = 179; // hard stop: +/-180 from home, with a small margin
export const AZ_MAX_TARGET_DEG = 175;
const TOLERANCE_DEG = 0.03; // about 2 arcminutes
const POLL_MS = 80;
const REFINE_RATE = 'C'; // the Guide rate (:RG#) does not visibly move the Autostar axes
const REFINE_START_LEAD_DEG = 0.04; // first guess at how far the axis coasts after the key is released
const REFINE_MAX_ATTEMPTS = 8;
const PULSE_SETTLE_MS = 500;
const STALL_MS = 4000;
const PROBE_MAX_MS = 5000;
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
    // Azimuth is handled as degrees from home in (-180, 180], so a slew never crosses the 180 degree seam.
    read: async (scope) => {
      const r = await scope.readAz();
      return { deg: norm180(r.deg), text: formatAz(r.deg, 0) };
    },
    violation: (deg) => (Math.abs(deg) >= AZ_STOP_DEG ? `azimuth ${signed(deg)} from home is at the \u00b1180\u00b0 limit` : null),
    goal: (target) => {
      const s = norm180(target);
      if (Math.abs(s) > AZ_MAX_TARGET_DEG) throw new Error(`Azimuth target ${signed(s)} from home is too close to the \u00b1180\u00b0 limit (max \u00b1${AZ_MAX_TARGET_DEG}\u00b0)`);
      return s;
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

export async function slewAxis(scope, axisName, target, { onStatus = () => {}, session = newSession(), tolerance = TOLERANCE_DEG, isCancelled = () => false } = {}) {
  const axis = AXES[axisName];
  if (!axis) throw new Error(`Unknown axis "${axisName}"`);
  if (!Number.isFinite(target)) throw new Error('Target must be a number of degrees');
  const goal = axis.goal(target);

  try {
    let cur = await axis.read(scope);
    const startViolation = axis.violation(cur.deg);
    if (startViolation) {
      throw new Error(`Refusing to move: ${startViolation}. Put the scope at home and power-cycle the handset so it reads Alt 0 / Az 0.`);
    }
    if (Math.abs(goal - cur.deg) <= tolerance) return { final: cur.deg, error: goal - cur.deg, text: cur.text };

    if (!session.keys[axisName]) {
      // Direction test: press the key toward the target at the rate suited to the error size (never faster than Move),
      // until the reading has moved, to learn which key raises it. The handset can take a moment to start moving.
      const err0 = goal - cur.deg;
      const testKey = err0 > 0 ? axis.plus : axis.minus;
      const otherKey = testKey === axis.plus ? axis.minus : axis.plus;
      const probeRate = Math.abs(err0) > 1 ? 'M' : REFINE_RATE;
      await scope.command(`:R${probeRate}#`);
      await scope.command(`:M${testKey}#`);
      const probeStart = Date.now();
      let afterTest = cur;
      while (Date.now() - probeStart < PROBE_MAX_MS && Math.abs(afterTest.deg - cur.deg) < PROBE_MIN_MOVE_DEG) {
        await sleep(POLL_MS);
        if (isCancelled()) throw new CancelledError();
        afterTest = await axis.read(scope);
        const v = axis.violation(afterTest.deg);
        if (v) throw new Error(`Stopped: ${v}.`);
      }
      await scope.stopAll();
      await sleep(250);
      afterTest = await axis.read(scope);
      const moved = afterTest.deg - cur.deg;
      if (Math.abs(moved) < PROBE_MIN_MOVE_DEG) {
        throw new Error(`No ${axis.label} movement detected during the direction test (clutch released, motors off or handset busy?).`);
      }
      session.keys[axisName] = { increaseKey: moved > 0 ? testKey : otherKey, decreaseKey: moved > 0 ? otherKey : testKey };
      cur = afterTest;
      const afterTestViolation = axis.violation(cur.deg);
      if (afterTestViolation) throw new Error(`Stopped: ${afterTestViolation}.`);
    }
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
        cur = await axis.read(scope);

        const violation = axis.violation(cur.deg);
        if (violation) throw new Error(`Stopped: ${violation}.`);
        const abs = Math.abs(goal - cur.deg);
        onStatus({ axis: axis.label, reading: cur.text, deg: cur.deg, goal, toGo: goal - cur.deg, rate: phase.rate });
        if (abs < best) best = abs;
        if (abs > best + phase.grow) throw new Error(`Stopped: ${axis.label} is moving away from the target.`);
        if (Math.abs(cur.deg - lastDeg) > 0.005) {
          lastDeg = cur.deg;
          lastProgressAt = Date.now();
        } else if (phase.strict && Date.now() - lastProgressAt > STALL_MS) {
          throw new Error(`Stopped: ${axis.label} stopped moving before reaching the target.`);
        }
      }

      await scope.stopAll();
      await sleep(250); // let the axis come to rest before reading or changing rate
      cur = await axis.read(scope);
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
      const maxMs = 2000 + (Math.abs(err) / 0.05) * 1000;
      const attemptStart = Date.now();
      let moving = false;
      let trigger = cur;
      await scope.command(`:M${key}#`);
      for (;;) {
        await sleep(POLL_MS);
        if (isCancelled()) throw new CancelledError();
        cur = await axis.read(scope);
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
      cur = await axis.read(scope);
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
