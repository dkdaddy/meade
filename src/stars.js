import { formatDMS } from './angles.js';
import { precessFromJ2000, raDecToAltAz } from './astro.js';

// The 100 brightest stars (by V magnitude) that have an IAU-approved proper name.
// Source: IAU Catalog of Star Names (WGSN), https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt
// Columns: name, RA J2000 (degrees), Dec J2000 (degrees), V magnitude. Proper motion is ignored.
const STARS = [
  ["Sirius", 101.287155, -16.716116, -1.45],
  ["Canopus", 95.987958, -52.695661, -0.62],
  ["Arcturus", 213.9153, 19.182409, -0.05],
  ["Rigil Kentaurus", 219.902066, -60.833975, -0.01],
  ["Vega", 279.234735, 38.783689, 0.03],
  ["Capella", 79.172328, 45.997991, 0.08],
  ["Rigel", 78.634467, -8.201638, 0.18],
  ["Procyon", 114.825493, 5.224993, 0.4],
  ["Achernar", 24.428523, -57.236753, 0.45],
  ["Betelgeuse", 88.792939, 7.407064, 0.45],
  ["Hadar", 210.955856, -60.373035, 0.61],
  ["Altair", 297.695827, 8.868321, 0.76],
  ["Aldebaran", 68.980163, 16.509302, 0.87],
  ["Spica", 201.298247, -11.161319, 0.98],
  ["Antares", 247.351915, -26.432003, 1.06],
  ["Pollux", 116.328958, 28.026199, 1.16],
  ["Fomalhaut", 344.412693, -29.622237, 1.17],
  ["Deneb", 310.35798, 45.280339, 1.25],
  ["Mimosa", 191.930263, -59.688764, 1.25],
  ["Acrux", 186.649563, -63.099093, 1.33],
  ["Toliman", 219.896096, -60.837528, 1.35],
  ["Regulus", 152.092962, 11.967209, 1.36],
  ["Adhara", 104.656453, -28.972086, 1.5],
  ["Gacrux", 187.791498, -57.113213, 1.59],
  ["Bellatrix", 81.282764, 6.349703, 1.64],
  ["Elnath", 81.572971, 28.607452, 1.65],
  ["Miaplacidus", 138.299906, -69.717208, 1.67],
  ["Alnilam", 84.053389, -1.201919, 1.69],
  ["Alnair", 332.05827, -46.960974, 1.73],
  ["Alnitak", 85.189694, -1.942574, 1.74],
  ["Alioth", 193.50729, 55.959823, 1.76],
  ["Kaus Australis", 276.042993, -34.384616, 1.79],
  ["Mirfak", 51.080709, 49.861179, 1.79],
  ["Dubhe", 165.931965, 61.751035, 1.81],
  ["Wezen", 107.09785, -26.3932, 1.83],
  ["Alkaid", 206.885157, 49.313267, 1.85],
  ["Avior", 125.62848, -59.509484, 1.86],
  ["Sargas", 264.329711, -42.997824, 1.86],
  ["Menkalinan", 89.882179, 44.947433, 1.9],
  ["Atria", 252.166229, -69.027712, 1.91],
  ["Alhena", 99.42796, 16.39928, 1.93],
  ["Peacock", 306.411904, -56.73509, 1.94],
  ["Castor", 113.649428, 31.888276, 1.98],
  ["Mirzam", 95.674939, -17.955919, 1.98],
  ["Alphard", 141.896847, -8.658602, 1.99],
  ["Alsephina", 131.175944, -54.708819, 1.99],
  ["Hamal", 31.793357, 23.462418, 2.01],
  ["Diphda", 10.897379, -17.986606, 2.04],
  ["Nunki", 283.81636, -26.296724, 2.05],
  ["Menkent", 211.670617, -36.369958, 2.06],
  ["Alpheratz", 2.096916, 29.090431, 2.07],
  ["Kochab", 222.676357, 74.155504, 2.07],
  ["Mirach", 17.433013, 35.620557, 2.07],
  ["Saiph", 86.93912, -9.669605, 2.07],
  ["Rasalhague", 263.733627, 12.560035, 2.08],
  ["Shaula", 263.402167, -37.103824, 2.08],
  ["Algol", 47.042215, 40.955648, 2.09],
  ["Almach", 30.974804, 42.329725, 2.1],
  ["Tiaki", 340.666876, -46.884576, 2.12],
  ["Polaris", 37.954561, 89.264109, 2.13],
  ["Denebola", 177.26491, 14.572058, 2.14],
  ["Aspidiske", 139.272529, -59.275232, 2.21],
  ["Naos", 120.896031, -40.003148, 2.21],
  ["Alphecca", 233.67195, 26.714693, 2.22],
  ["Mizar", 200.981429, 54.925362, 2.23],
  ["Sadr", 305.557091, 40.256679, 2.23],
  ["Suhail", 136.998993, -43.432589, 2.23],
  ["Eltanin", 269.151541, 51.488896, 2.24],
  ["Schedar", 10.126838, 56.537331, 2.24],
  ["Mintaka", 83.001667, -0.299095, 2.25],
  ["Caph", 2.294522, 59.149781, 2.28],
  ["Dschubba", 240.083359, -22.62171, 2.29],
  ["Larawag", 252.540878, -34.293232, 2.29],
  ["Merak", 165.460319, 56.382426, 2.34],
  ["Izar", 221.246763, 27.074207, 2.35],
  ["Enif", 326.046484, 9.875009, 2.38],
  ["Ankaa", 6.570939, -42.306084, 2.4],
  ["Phecda", 178.457679, 53.694758, 2.41],
  ["Sabik", 257.594529, -15.724907, 2.43],
  ["Scheat", 345.943572, 28.082785, 2.44],
  ["Alderamin", 319.644885, 62.585574, 2.45],
  ["Aludra", 111.02376, -29.303106, 2.45],
  ["Markeb", 140.528407, -55.010667, 2.47],
  ["Aljanah", 311.552843, 33.970257, 2.48],
  ["Markab", 346.190223, 15.205267, 2.49],
  ["Menkar", 45.569885, 4.089737, 2.54],
  ["Acrab", 241.3593, -19.805453, 2.56],
  ["Zosma", 168.527089, 20.523718, 2.56],
  ["Arneb", 83.182567, -17.822289, 2.58],
  ["Gienah", 183.951543, -17.541929, 2.58],
  ["Ascella", 285.653043, -29.880063, 2.6],
  ["Algieba", 154.993144, 19.841489, 2.61],
  ["Zubeneschamali", 229.251724, -9.382914, 2.61],
  ["Unukalhai", 236.066976, 6.425629, 2.63],
  ["Kraz", 188.59681, -23.396759, 2.65],
  ["Mahasim", 89.930292, 37.212585, 2.65],
  ["Phact", 84.912254, -34.07411, 2.65],
  ["Ruchbah", 21.453964, 60.235284, 2.66],
  ["Muphrid", 208.671161, 18.397717, 2.68],
  ["Hassaleh", 74.248421, 33.1661, 2.69],
];

export const STAR_LIST = STARS.map(([name, raDeg, decDeg, mag]) => ({ name, raHours: raDeg / 15, decDeg, mag }));

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Exact (case/space-insensitive) match first, then a unique prefix match.
export function findStar(query) {
  const q = key(query);
  const exact = STAR_LIST.find((s) => key(s.name) === q);
  if (exact) return exact;
  const matches = STAR_LIST.filter((s) => key(s.name).startsWith(q));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${query}" is ambiguous: ${matches.map((s) => s.name).join(', ')}`);
  throw new Error(`Unknown star "${query}". Run "stars" to list the available names.`);
}

// Prints the catalogue with each star's current altitude/azimuth. Stars outside the allowed
// altitude window are hidden unless showAll is set.
export function listStars({ location, minAlt, maxAlt, showAll, now = new Date() }) {
  console.log(`${'Name'.padEnd(18)} ${'Mag'.padStart(5)}  ${'Alt'.padStart(9)}  ${'Az'.padStart(7)}`);
  let shown = 0;
  for (const star of STAR_LIST) {
    const of = precessFromJ2000(star.raHours, star.decDeg, now);
    const { alt, az } = raDecToAltAz(of.raHours, of.decDeg, now, location.latitude, location.longitude);
    const ok = alt >= minAlt && alt < maxAlt;
    if (!ok && !showAll) continue;
    shown += 1;
    console.log(`${star.name.padEnd(18)} ${star.mag.toFixed(2).padStart(5)}  ${formatDMS(alt).padStart(9)}  ${az.toFixed(1).padStart(6)}\u00b0${ok ? '' : '  (not usable)'}`);
  }
  console.log(`\n${shown} of ${STAR_LIST.length} stars shown (usable: altitude ${minAlt}\u00b0 to ${maxAlt}\u00b0).`);
}
