import { parseArgs } from 'node:util';
import { align, homeCommand, MAX_ALT_DEG, MIN_ALT_DEG } from './align.js';
import { resolveLocation } from './location.js';
import { monitor } from './monitor.js';
import { listStars } from './stars.js';
import { listPlanets } from './planets.js';
import { parseDegrees } from './angles.js';
import { slewCommand, goHomeCommand } from './slew.js';
import { trackCommand, twoStarCommand } from './twostar.js';

const USAGE = `Usage:
  node src/index.js monitor [--port COM3] [--interval 500]
  node src/index.js home [--port COM3]
  node src/index.js go-home [--port COM3]           (slews the scope to Alt 0 / Az 0)
  node src/index.js park [--port COM3]              (alias for go-home)
  node src/index.js slew-alt <deg>      (0 up to ${MAX_ALT_DEG}; negative: --to=-5)
  node src/index.js slew-az <deg>       (within 300 of home, e.g. 0-300 or --to=-90)
  node src/index.js planets [--all] [--lat D --lon D]
  node src/index.js stars [--all] [--lat D --lon D]
  node src/index.js align <target> [--port COM3] [--lat D --lon D] [--declination D]
  node src/index.js align --ra HH:MM:SS --dec=[+-]DD:MM:SS [same options]
  node src/index.js align2 <target1> <target2> [--port COM3] [--lat D --lon D] [--declination D]
  node src/index.js track [target] [--port COM3]

Notes:
  Targets can be catalog stars, major planets (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune), or the Moon.
  align2 does a two-target alignment, then tracks the second target. It slews to target 1, you centre it with the handset
  and press Enter, then the same for target 2. The alignment is saved to alignment.json. Quote names with spaces:
  align2 moon vega or align2 jupiter vega. Pick targets at least 20 deg apart. The scope must read Alt 0 / Az 0 at the start.
  track [target] loads the saved alignment, slews to the target (default: the last one) and tracks it. While tracking,
  Enter pauses so you can centre the target by hand and press Enter again to sync; Esc resumes without syncing; q quits.
  Tracking is done by the PC nudging the scope with move/stop commands; nothing is written to the controller.
  planets lists the Moon and 7 major planets with their magnitude, phase, and current altitude/azimuth.
  stars lists visible solar system bodies (Moon, planets) and the 200 brightest named stars currently usable (altitude ${MIN_ALT_DEG}-${MAX_ALT_DEG} deg).
  Target names are case-insensitive, spaces optional, unique prefixes work (align moon, align jupiter, align vega, align "rigil kent").
  Write negative values with '=', e.g. --dec=-16:42:58 --lon=-0.13
  This tool only reads from the controller, except slew-alt / slew-az, which send move, stop and move-rate
  commands and nothing else (no settings, time, site, target or sync). You move the scope yourself for align.
  slew-alt / slew-az work in the scope's own reported frame (Alt 0 / Az 0 = home), step down through the
  Slew/Move/Center/Guide rates, and stop if a limit is hit (altitude -1..${MAX_ALT_DEG}, azimuth within 300 of home).
  align expects the scope to report Alt 0 / Az 0 at home (level, pointing magnetic north).
  --ra/--dec are taken as of-date; star names are J2000 and are precessed automatically; planets and Moon are computed of-date with topocentric parallax.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: 'COM3' },
    interval: { type: 'string', default: '500' },
    ra: { type: 'string' },
    dec: { type: 'string' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    declination: { type: 'string' },
    all: { type: 'boolean' },
    to: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'monitor';

try {
  if (values.help) {
    console.log(USAGE);
  } else if (command === 'monitor') {
    await monitor(values.port, Number(values.interval));
  } else if (command === 'home') {
    await homeCommand(values);
  } else if (command === 'go-home' || command === 'park') {
    await goHomeCommand(values.port);
  } else if (command === 'align') {
    await align(values, positionals.slice(1).join(' ') || undefined);
  } else if (command === 'align2') {
    await twoStarCommand(values, positionals[1], positionals[2]);
  } else if (command === 'track') {
    await trackCommand(values, positionals.slice(1).join(' ') || undefined);
  } else if (command === 'slew-alt' || command === 'slew-az') {
    const raw = values.to ?? positionals[1];
    if (raw === undefined) throw new Error(`${command} needs a value in degrees, e.g. ${command} 30`);
    await slewCommand(values.port, command === 'slew-alt' ? 'alt' : 'az', parseDegrees(raw));
  } else if (command === 'planets') {
    const location = await resolveLocation(values);
    listPlanets({ location, minAlt: MIN_ALT_DEG, maxAlt: MAX_ALT_DEG, showAll: values.all });
  } else if (command === 'stars') {
    const location = await resolveLocation(values);
    listStars({ location, minAlt: MIN_ALT_DEG, maxAlt: MAX_ALT_DEG, showAll: values.all });
  } else {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
}
