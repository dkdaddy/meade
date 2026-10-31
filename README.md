# meade-cli

Node.js command-line tool for a Meade Autostar (LX200 protocol) telescope on a serial port (default `COM3`, 9600 8N1).
Developed against an Autostar handset, firmware 30Eb, in Alt/Az mode.

**Status:** monitor and single-axis slews are tested on the real scope. Alignment (`align`, `align2`) and `track`
have only been exercised against a simulated/fake scope, not on hardware.

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
| `home` | Read-only check that the scope is currently at home (Alt 0 / Az 0). |
| `go-home` or `park` | Slews the scope back to home (Alt 0 / Az 0), moving both axes together. |
| `planets [--all]` | Lists the Moon and 7 major planets with magnitude, illumination, and current altitude/azimuth. |
| `stars [--all]` | Lists visible solar system bodies (Moon, planets) and the 200 brightest named stars currently usable (altitude 5-75 deg). |
| `align <target>` or `align --ra --dec` | Single-target alignment: home (scope Alt 0 / Az 0) is the anchor. You physically set the scope level and pointing north, power-cycle the handset so it reads 0 / 0, and press Enter, it slews to the target, you centre it with the handset and press Enter, a two-point pointing model is fitted and saved, then it tracks the target. |
| `slew-alt <deg>` | Closed-loop slew of altitude to `<deg>` (0 up to, not including, 75), in the scope's own reported frame. |
| `slew-az <deg>` | Closed-loop slew of azimuth within 300 deg of home (e.g. 0-300 or `--to=-90`). |
| `align2 <target1> <target2>` | Two-target alignment anchored on target 1 (stars, planets, or Moon, e.g. `align2 moon vega`), then tracks target 2. Targets must be 20+ deg apart. |
| `track [target]` | Loads `alignment.json`, slews to the target (star, planet, or Moon; default: the last one used) and tracks it. |

Common options: `--port COM3`, `--lat D --lon D` (override the PC location).

### Alignment and tracking

The pointing model is one 3x3 rotation between the scope's reported Alt/Az and the true Alt/Az, built from **exactly
two reference points**. It is saved to `alignment.json` together with human-readable diagnostics describing the
scope's levelness and how far its home pose is from true level / true north.

- **`align <target>`** (single target): home (scope Alt 0 / Az 0, assumed level and pointing true north) is one
  point; the target you centre is the other. The target reading is kept exact and home fixes the remaining twist.
- **`align2 <target1> <target2>`** (two targets): both points are real sky targets, anchored on target 1; home is
  not stored. Pick targets 20+ deg apart.

Both start with the scope at home (power-cycle the handset so it reads Alt 0 / Az 0), fit the model, save it, and
then track the (last) target.

While tracking: Enter pauses so you can centre the target by hand, Enter again syncs and resumes, Esc resumes without
syncing, q or Ctrl+C stops. **A sync replaces whichever of the two points is closest in the sky to the fresh
measurement (the freshly centred point is kept exact); the model never grows past two points.** So a single-star
model whose sync lands nearer home than the target replaces the home anchor, becoming a true two-target alignment.

Tracking is the PC nudging the scope with move/stop commands, so it moves in small steps, not smoothly (see Limitations).
The saved alignment is only valid until the handset is power-cycled or the scope slips.

## Safety rules

- **Nothing is ever written to the controller.** No site, time, sync, target or setting commands. The only things sent are
  read commands (`:G...#`, through `Scope.query()`) and motion commands (move, stop, move-rate, through `Scope.command()`).
  Both channels are whitelisted by regex in `src/lx200.js`.
- Limits: altitude -1 to 75 deg (hard stop), azimuth within 300 deg of home (hard stop). Slews refuse to start if the scope is
  already outside them. Alignment targets must be at least 5 deg above the horizon (10 deg for `align` / `align2`).
- Ctrl+C stops all motion. Every slew and track ends with a stop on all axes.
- The handset's speed setting is changed by the rate commands (`:RS#`, `:RM#`, `:RC#`).

## Layout

| File | Purpose |
|---|---|
| `src/index.js` | CLI entry, argument parsing, usage text |
| `src/lx200.js` | Serial link, whitelisted `query()` / `command()`, `readAlt` / `readAz` / `readAltAz`, azimuth decoding |
| `src/slew.js` | `slewAxis()`: closed-loop single-axis slew; `slewCommand()` for the CLI |
| `src/twostar.js` | `align`, `align2` and `track`: two-point alignment, tracking loop, replace-closest sync, `alignment.json` read/write |
| `src/pointing.js` | Vector / rotation maths for the pointing model (two-point fit, twist about an axis) |
| `src/keys.js` | Single-key terminal input (Ctrl+C arrives as `interrupt`) |
| `src/align.js` | `home` read-only check and the shared limit constants / `alignment.json` path |
| `src/astro.js` | Sidereal time, RA/Dec to Alt/Az, precession from J2000 |
| `src/planets.js` | Analytical ephemerides for the Moon & planets (Keplerian orbits, perturbations, topocentric parallax, RA/Dec of date, magnitude) |
| `src/location.js` | PC position (Windows location service) |
| `src/stars.js`, `src/angles.js`, `src/monitor.js` | Target resolution (stars, planets, Moon), angle parsing/formatting, monitor loop |

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
- There are no automated tests. Simulated-scope checks live in `%TEMP%` (`slewsim.mjs`, `twostarsim.mjs`) and are not in the repo;
  an alignment simulation writes `alignment.json`, so delete it (or restore the previous one) afterwards.
