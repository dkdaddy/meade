# meade-cli

Node.js command-line tool for a Meade Autostar (LX200 protocol) telescope on a serial port (default `COM3`, 9600 8N1).
Developed against an Autostar handset, firmware 30Eb, in Alt/Az mode.

**Status:** monitor, single-axis slews and the read-only single-star align are tested on the real scope.
Two-star alignment (`align2`) and `track` have only been tested against a simulated scope, not on hardware.

## Setup

```
npm install
npm start -- --help
```

Requires Node 20+ (developed on Node 24) and the Windows location service for the PC position (or `--lat` / `--lon`).

## Commands

Run with `npm start -- <command>`. Write negative values with `=`, e.g. `--to=-90`, `--dec=-16:42:58`.

| Command | What it does |
|---|---|
| `monitor [--interval 500]` | Reads RA, Dec, Alt, Az, time, date, latitude, longitude in a loop. Default command. |
| `planets [--all]` | Lists the 7 major planets with magnitude and current altitude/azimuth. |
| `stars [--all]` | Lists visible planets and the 200 brightest named stars currently usable (altitude 5-75 deg). |
| `align <target>` or `align --ra --dec` | Read-only single-target alignment (star or planet): you move the scope, press Enter, the offset is saved. Superseded by `align2`. |
| `slew-alt <deg>` | Closed-loop slew of altitude to `<deg>` (0 up to, not including, 75), in the scope's own reported frame. |
| `slew-az <deg>` | Closed-loop slew of azimuth within 300 deg of home (e.g. 0-300 or `--to=-90`). |
| `align2 <target1> <target2>` | Two-target alignment (stars or planets, e.g. `align2 jupiter vega`), then tracks target 2. Targets must be 20+ deg apart. |
| `track [target]` | Loads `alignment.json`, slews to the target (star or planet; default: the last one used) and tracks it. |

Common options: `--port COM3`, `--lat D --lon D`, `--declination D` (override the PC location / magnetic declination).

### Two-star/planet alignment and tracking

1. Put the scope at home (level, pointing magnetic north) and power-cycle the handset so it reads Alt 0 / Az 0.
2. `npm start -- align2 jupiter vega`. It slews to the first target; centre it with the handset and press Enter. Repeat for the second.
3. The PC fits a rotation between the scope's reported Alt/Az and the true Alt/Az, saves it to `alignment.json`, and starts tracking target 2.
4. While tracking: Enter pauses so you can centre the target by hand, Enter again syncs and resumes, Esc resumes without syncing, q or Ctrl+C stops.

Tracking is the PC nudging the scope with move/stop commands, so it moves in small steps, not smoothly (see Limitations).
The saved alignment is only valid until the handset is power-cycled or the scope slips.

## Safety rules

- **Nothing is ever written to the controller.** No site, time, sync, target or setting commands. The only things sent are
  read commands (`:G...#`, through `Scope.query()`) and motion commands (move, stop, move-rate, through `Scope.command()`).
  Both channels are whitelisted by regex in `src/lx200.js`.
- Limits: altitude -1 to 75 deg (hard stop), azimuth within 300 deg of home (hard stop). Slews refuse to start if the scope is
  already outside them. Alignment targets must be at least 5 deg above the horizon (15 deg for `align2`).
- Ctrl+C stops all motion. Every slew and track ends with a stop on all axes.
- The handset's speed setting is changed by the rate commands (`:RS#`, `:RM#`, `:RC#`).

## Layout

| File | Purpose |
|---|---|
| `src/index.js` | CLI entry, argument parsing, usage text |
| `src/lx200.js` | Serial link, whitelisted `query()` / `command()`, `readAlt` / `readAz` / `readAltAz`, azimuth decoding |
| `src/slew.js` | `slewAxis()`: closed-loop single-axis slew; `slewCommand()` for the CLI |
| `src/twostar.js` | `align2` and `track`: two-target alignment, tracking loop, sync, `alignment.json` read/write |
| `src/pointing.js` | Vector / rotation maths for the pointing model |
| `src/keys.js` | Single-key terminal input (Ctrl+C arrives as `interrupt`) |
| `src/align.js` | Old read-only single-target alignment; also exports the limit constants |
| `src/astro.js` | Sidereal time, RA/Dec to Alt/Az, precession from J2000 |
| `src/planets.js` | Analytical planetary ephemerides (Keplerian orbits, perturbations, RA/Dec of date, magnitude) |
| `src/location.js` | PC position (Windows location service) and magnetic declination (WMM via `geomagnetism`) |
| `src/stars.js`, `src/angles.js`, `src/monitor.js` | Target resolution (stars & planets), angle parsing/formatting, monitor loop |

## Hardware findings

- The Autostar has no `:MA#`, `:Sa#` or `:Sz#` (those are 16-inch only), so there is no Alt/Az GoTo. Slewing is done by holding
  the direction keys (`:Mn/:Ms/:Me/:Mw#`) and watching `:GA#` / `:GZ#` from the PC.
- `:GZ#` packs 3-digit azimuths: the first two digits come as one character, `chr(0x30 + deg/10)`.
  `S9*58:47` means 359*58:47. Decoded in `src/lx200.js`.
- The degree sign arrives as byte 0xDF (shown as `*`).
- Move rates: `:RG#` (Guide) does not move the axes at all. `:RC#` (Center) is about 0.18 deg/s with about 0.4 s start-up lag
  and some coasting after release. The fine approach in `slew.js` holds the key and releases it a measured "lead" before the target.
- Writing site/time/sync to the handset (done once during early diagnostics) left it at Alt -38 / Az 70; a power-cycle at home fixes that.
- If COM3 gives "Access denied", a leftover `node.exe` is holding it.

## Limitations and ideas

- Tracking is not smooth: the slowest speed that moves the axis (about 0.18 deg/s) is about 45 times faster than a star, and the
  handset lags 0.4 s, so corrections are small jumps once the star drifts about 0.04 deg. Options: a smaller trigger, or better
  pulse timing. The scope's own tracking would need controller writes, which are ruled out.
- The azimuth is assumed to increase clockwise. `align2` warns if the measured target separation disagrees with the sky.
- The old `align` writes `alignment.json` in an older format that `track` rejects. Re-run `align2`.
- There are no automated tests. Simulated-scope checks live in `%TEMP%` (`slewsim.mjs`, `twostarsim.mjs`) and are not in the repo;
  the two-star simulation writes `alignment.json`, so delete it afterwards.
