// Pointing model maths. Frame: x = north, y = east, z = up, so an (alt, az) direction with azimuth measured
// clockwise from north is [cos(alt)cos(az), cos(alt)sin(az), sin(alt)].
// The scope's reported Alt/Az (its own frame) is related to true Alt/Az by one 3x3 rotation R: true = R * scope.
import { norm360 } from './astro.js';

const RAD = Math.PI / 180;
const clamp = (x) => Math.max(-1, Math.min(1, x));

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (v) => Math.hypot(v[0], v[1], v[2]);
export const angleBetweenDeg = (a, b) => Math.atan2(length(cross(a, b)), dot(a, b)) / RAD;

export const mulMV = (M, v) => M.map((row) => dot(row, v));
export const transpose = (M) => [0, 1, 2].map((i) => [M[0][i], M[1][i], M[2][i]]);
export const mulMM = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));

export function altAzToVec(altDeg, azDeg) {
  const alt = altDeg * RAD;
  const az = azDeg * RAD;
  return [Math.cos(alt) * Math.cos(az), Math.cos(alt) * Math.sin(az), Math.sin(alt)];
}

export function vecToAltAz(v) {
  return { alt: Math.asin(clamp(v[2])) / RAD, az: norm360(Math.atan2(v[1], v[0]) / RAD) };
}

// Rotation that adds `deg` to the azimuth of every direction.
export function rotationZ(deg) {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

// Smallest rotation that takes direction `from` onto direction `to` (Rodrigues).
export function correctionRotation(from, to) {
  const axis = cross(from, to);
  const s = length(axis);
  const c = dot(from, to);
  if (s < 1e-12) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const [x, y, z] = [axis[0] / s, axis[1] / s, axis[2] / s];
  const t = 1 - c;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}

// Rotation about a unit-ish `axis` by `rad` radians (Rodrigues).
export function rotationAboutAxis(axis, rad) {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}

// Scope->true rotation that holds `anchor` exactly on `anchorTrue` and then twists about the anchor's true
// direction to bring `other` onto `otherTrue` as closely as a single rotation allows. When the measured
// separation between the two directions matches the sky, `other` also lands exactly. The anchor is always exact,
// so it is the trusted/fixed point; `other` supplies the remaining (twist) degree of freedom.
export function twoPointRotation(anchor, anchorTrue, other, otherTrue) {
  const R0 = correctionRotation(anchor, anchorTrue);
  const a = anchorTrue; // unit vector (direction cosines)
  const proj = (w) => {
    const d = dot(w, a);
    return [w[0] - d * a[0], w[1] - d * a[1], w[2] - d * a[2]];
  };
  const u = proj(mulMV(R0, other)); // where `other` sits after R0, in the plane perpendicular to the anchor axis
  const v = proj(otherTrue); // where it should sit, same plane
  const phi = Math.atan2(dot(a, cross(u, v)), dot(u, v)); // signed twist about the anchor axis
  return mulMM(rotationAboutAxis(a, phi), R0);
}
