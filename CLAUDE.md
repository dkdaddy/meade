# CLAUDE.md

Node.js (ESM, Node 24) CLI for a Meade Autostar telescope over serial (COM3, 9600 8N1). Windows, PowerShell 5.1: chain with `;`, not `&&`.
See README.md for commands and hardware findings. Run with `npm start -- <command>`; there are no automated tests.

## Hard rules

- **Never write to the controller.** No site, time, date, target, sync or setting commands. The user forbade it after a diagnostic
  write left the handset at Alt -38 / Az 70. The only allowed traffic is:
  - `Scope.query()`: read commands, regex `^:G[A-Za-z]+#$`
  - `Scope.command()`: motion only, regex `^:(M[nsew]|Q[nsew]?|R[CGMS])#$`
  Do not loosen these regexes.
- **Do not move the real scope without the user asking.** Test motion logic against a fake scope (implement `readAlt`, `readAz`,
  `readAltAz`, `command`, `stopAll`) instead. Reads on the real scope are fine.
- Keep limits: altitude -1..75 (hard stop), azimuth within 300 of home (targets within 300), targets at least 5 deg up (15 deg for `align` / `align2`). Always `stopAll()` in `finally`.
- The scope must never be pointed down. The user was upset when it did.
- Home = level, pointing true north, reading Alt 0 / Az 0. Everything is relative to true north (no magnetic declination). Scope az is assumed clockwise; true az of home = 0.
- Do not commit or push unless asked. The repo has local commits only and no remote.

## Architecture

- `lx200.js`: serial link. `readAz` goes through `decodeAzimuth` because the Autostar packs 3-digit azimuths (`S9*58:47` = 359*58:47).
- `slew.js`: `slewAxis(scope, 'alt'|'az', target, {session, tolerance, isCancelled, onStatus})`.
  Learns which key raises the reading (cached in `session.keys`), coarse phases at Slew then Move rate, then a Center-rate final approach
  that releases the key a measured coast `lead` before the target (cached in `session.lead`). `:RG#` (Guide) does not move the axes; do not use it.
  Azimuth is handled as unwrapped degrees from home in [-300, 300]. `bestAzFromHome(reading, cur)` unwraps to the closest branch within [-300, 300]. `CancelledError` is thrown when `isCancelled()` is true.
- `planets.js`: analytical ephemerides for the Moon and planets (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune). Computes of-date apparent RA/Dec with topocentric parallax, visual magnitude, and lunar phase.
- `stars.js`: IAU catalog stars (J2000 precessed to date) and unified target search (`findStar` / `findTarget`) matching stars, planets, and the Moon.
- `twostar.js`: pointing model is a 3x3 rotation `R` (scope frame to true frame; x north, y east, z up) built from **exactly two
  reference points**, fit by `fitTwoPoints(anchor, other)` (`twoPointRotation` in `pointing.js`): the anchor is held exact and the
  rotation twists about the anchor's true axis to bring `other` in (both exact when the measured separation matches the sky).
  `align` (single target, `runOneStar`): points are home (scope 0/0, true alt 0 / az 0) and the centred target; the
  target is the anchor (kept exact). `align2` (`runTwoStar`): points are target 1 (anchor) and target 2; home is not stored.
  Sync in tracking replaces whichever stored point is closest in the sky (`closestPointIndex`, true-position angle) with the fresh
  measurement, which becomes the anchor (kept exact); the model never grows past two points. `describeAlignment` adds
  human-readable levelness / home-error diagnostics to the saved file (`alignment.json`, version 1). Supports stars, planets, and the
  Moon (`targetRaDec`). `runOneStar`, `runTwoStar` and `runTrack` take a `ctx` (`scope, keys, ctl, location, session, log, status`) so
  they can be driven by a fake scope and fake keys.
- Tracking is the PC nudging the scope (trigger 0.04 deg, aims ahead based on drift rate). It cannot be smooth with the speeds available.

## Status

- Tested on hardware: monitor, slew-alt / slew-az (az up to +/-300 from home), read-only `home` pre-flight.
- Only simulated / fake-scope: `align`, `align2`, `track`, sync. Hardware test is the next step. Expect to tune the trigger, lead and tolerances.
- Not done: any smoother tracking, saving more than the last alignment, a test suite.

## Gotchas

- `parseArgs` needs `=` for negatives: `--to=-90`.
- Orphaned `node.exe` processes lock COM3 ("Access denied"); kill our own, not VS Code's.
- A simulation run of `align` / `align2` overwrites `alignment.json`; back it up or delete it afterwards.
- Windows location needs a PowerShell polling loop in `location.js`; the Node-side API returns no data.
