import { norm180 } from './astro.js';
import { formatAlt, formatAz, formatDeg } from './angles.js';
import { Scope } from './lx200.js';

// Where the pointing model and alignment points are saved. The alignment itself lives in twostar.js.
export const ALIGNMENT_FILE = new URL('../alignment.json', import.meta.url);

const signed = (deg) => formatDeg(deg, { signed: true });

// Limits are only reported: this tool never sends anything to the scope except read commands.
export const MAX_AZ_FROM_HOME_DEG = 300;
export const MIN_ALT_DEG = 5;
// The 75 deg ceiling is also deliberate for tracking: near the zenith the azimuth rate of an alt-az mount diverges,
// so keeping targets below it holds the azimuth slews to sane speeds.
export const MAX_ALT_DEG = 75;
// The scope must report approximately Alt 0, Az 0 when an alignment starts.
const HOME_TOLERANCE_DEG = 2;

// Read-only check that the scope is at home (reports Alt 0 / Az 0, i.e. level and pointing true north).
// Prints the reading and how far off it is; exits non-zero when it is not at home, so it can gate other commands.
export async function homeCommand(values) {
  const scope = new Scope(values.port);
  try {
    await scope.open();
    console.log(`Connected to ${values.port}: ${(await scope.queryOrNull(':GVP#')) ?? '?'} ${(await scope.queryOrNull(':GVN#')) ?? '?'}  (read-only)`);
    const { alt, az } = await scope.readAltAz();
    const azFromHome = norm180(az);
    console.log(`Scope reports: Alt ${formatAlt(alt)}  Az ${formatAz(az)}  (azimuth ${signed(azFromHome)} from home)`);
    if (Math.abs(alt) <= HOME_TOLERANCE_DEG && Math.abs(azFromHome) <= HOME_TOLERANCE_DEG) {
      console.log(`At home: within ${HOME_TOLERANCE_DEG}\u00b0 of Alt 0 / Az 0.`);
    } else {
      console.log(`NOT at home: off by alt ${signed(alt)}, az ${signed(azFromHome)} (tolerance \u00b1${HOME_TOLERANCE_DEG}\u00b0).`);
      console.log('Put the scope level and pointing true north, then power-cycle the handset so it reads Alt 0 / Az 0.');
      process.exitCode = 1;
    }
  } finally {
    await scope.close();
  }
}
