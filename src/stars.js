import { formatAlt, formatAz } from './angles.js';
import { precessFromJ2000, raDecToAltAz } from './astro.js';

// The 200 brightest stars (by V magnitude) that have an IAU-approved proper name.
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
  ["Lesath", 262.690979, -37.295813, 2.7],
  ["Sheratan", 28.660046, 20.808031, 2.7],
  ["Kaus Media", 275.248508, -29.828104, 2.72],
  ["Tarazed", 296.564915, 10.613262, 2.72],
  ["Athebyne", 245.997858, 61.514214, 2.73],
  ["Yed Prior", 243.586411, -3.694323, 2.73],
  ["Imai", 183.78632, -58.748927, 2.75],
  ["Zubenelgenubi", 222.719638, -16.041777, 2.75],
  ["Cebalrai", 265.868136, 4.5673, 2.76],
  ["Cursa", 76.96244, -5.086446, 2.78],
  ["Kornephoros", 247.554998, 21.489611, 2.78],
  ["Rastaban", 262.608174, 52.301389, 2.79],
  ["Hatysa", 83.858258, -5.909901, 2.8],
  ["Kaus Borealis", 276.992668, -25.421701, 2.82],
  ["Paikauhale", 248.970637, -28.216017, 2.82],
  ["Algenib", 3.308963, 15.183594, 2.83],
  ["Nihal", 82.061346, -20.759441, 2.83],
  ["Tureis", 121.886037, -24.304324, 2.83],
  ["Alcyone", 56.871152, 24.105136, 2.85],
  ["Deneb Algedi", 326.760184, -16.127287, 2.85],
  ["Vindemiatrix", 195.544157, 10.959149, 2.85],
  ["Tejat", 95.740112, 22.513583, 2.87],
  ["Acamar", 44.565311, -40.304672, 2.88],
  ["Albaldah", 287.440971, -21.023615, 2.88],
  ["Cor Caroli", 194.006943, 38.318376, 2.89],
  ["Fang", 239.712972, -26.114108, 2.89],
  ["Gomeisa", 111.787674, 8.289316, 2.89],
  ["Alniyat", 245.297149, -25.592792, 2.9],
  ["Fawaris", 296.243658, 45.13081, 2.9],
  ["Sadalsuud", 322.889715, -5.571176, 2.9],
  ["Matar", 340.750579, 30.221244, 2.93],
  ["Algorab", 187.466063, -16.515431, 2.94],
  ["Sadalmelik", 331.445983, -0.319849, 2.95],
  ["Tianguan", 84.411189, 21.142544, 2.97],
  ["Zaurak", 59.50736, -13.508516, 2.97],
  ["Alnasl", 271.452025, -30.4241, 2.98],
  ["Okab", 286.352533, 13.863477, 2.99],
  ["Aldhanab", 328.482192, -37.364855, 3],
  ["Pherkad", 230.18215, 71.834017, 3],
  ["Xamidimura", 252.96763, -38.04738, 3],
  ["Furud", 95.0783, -30.063367, 3.02],
  ["Almaaz", 75.492219, 43.823307, 3.03],
  ["Seginus", 218.019466, 38.308251, 3.04],
  ["Dabih", 305.252803, -14.781405, 3.05],
  ["Mebsuta", 100.983026, 25.131127, 3.06],
  ["Tania Australis", 155.58225, 41.499519, 3.06],
  ["Altais", 288.13875, 67.661541, 3.07],
  ["Sarin", 258.757963, 24.839204, 3.12],
  ["Talitha", 134.80189, 48.041826, 3.12],
  ["Wazn", 87.739968, -35.76831, 3.12],
  ["Aldhibah", 257.19665, 65.714684, 3.17],
  ["Haedus", 76.628722, 41.234476, 3.18],
  ["Fuyue", 267.464503, -37.043305, 3.19],
  ["Tabit", 72.460045, 6.961275, 3.19],
  ["Errai", 354.836655, 77.632313, 3.21],
  ["Alfirk", 322.164987, 70.560715, 3.23],
  ["Yed Posterior", 244.580374, -4.69251, 3.23],
  ["Brachium", 226.017567, -25.281961, 3.25],
  ["Sulafat", 284.735928, 32.689557, 3.25],
  ["Skat", 343.662556, -15.820827, 3.27],
  ["Edasich", 231.232396, 58.966063, 3.29],
  ["Megrez", 183.856503, 57.032615, 3.32],
  ["Propus", 93.719405, 22.506794, 3.32],
  ["Chertan", 168.560019, 15.429571, 3.33],
  ["Alzirr", 101.322351, 12.895592, 3.35],
  ["Muscida", 127.566128, 60.71817, 3.35],
  ["Segin", 28.598857, 63.670101, 3.35],
  ["Albireo", 292.680351, 27.959692, 3.37],
  ["Rasalgethi", 258.66191, 14.390333, 3.37],
  ["Heze", 203.6733, -0.59582, 3.38],
  ["Meissa", 83.784486, 9.934156, 3.39],
  ["Minelauva", 193.900869, 3.39747, 3.39],
  ["Homam", 340.365503, 10.831363, 3.41],
  ["Mothallah", 28.27045, 29.578826, 3.42],
  ["Adhafera", 154.172567, 23.417312, 3.43],
  ["Porrima", 190.415181, -1.449373, 3.44],
  ["Azmidi", 117.323563, -24.859786, 3.45],
  ["Tania Borealis", 154.274095, 42.914356, 3.45],
  ["Achird", 12.276213, 57.815187, 3.46],
  ["Alula Borealis", 169.619737, 33.094305, 3.49],
  ["Ashlesha", 131.693794, 6.418809, 3.49],
  ["Nekkar", 225.48651, 40.390567, 3.49],
  ["Nganurganity", 105.429782, -27.93483, 3.49],
  ["Sadalbari", 342.500809, 24.601577, 3.51],
  ["Biham", 332.549939, 6.197863, 3.52],
  ["Subra", 145.28764, 9.892308, 3.52],
  ["Wasat", 110.030749, 21.982316, 3.52],
  ["Ain", 67.154163, 19.180435, 3.53],
  ["Rana", 55.812086, -9.763392, 3.53],
  ["Tarf", 124.128838, 9.185544, 3.53],
  ["Kaffaljidhma", 40.825163, 3.235816, 3.56],
  ["Pipirima", 253.083939, -38.017535, 3.56],
  ["Algedi", 304.513566, -12.544852, 3.58],
  ["Ginan", 185.340039, -60.401147, 3.59],
  ["Nembus", 24.498154, 48.628214, 3.59],
  ["Zavijava", 177.673826, 1.764717, 3.59],
  ["Sheliak", 282.519978, 33.362668, 3.6],
  ["Bharani", 42.495972, 27.260507, 3.61],
  ["Atlas", 57.290597, 24.053415, 3.62],
  ["Rotanev", 309.387235, 14.595115, 3.64],
];

export const STAR_LIST = STARS.map(([name, raDeg, decDeg, mag]) => ({ name, raHours: raDeg / 15, decDeg, mag }));

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Exact (case/space-insensitive) match first, then a unique prefix match.
export function findStar(query) {
  const q = key(query);
  const exact = STAR_LIST.find((s) => key(s.name) === q);
  if (exact) return exact;
  const matches = STAR_LIST.filter((s) => key(s.name).startsWith(q));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${query}" is ambiguous: ${matches.map((s) => s.name).join(', ')}`);
  const close = STAR_LIST.map((s) => ({ s, d: editDistance(q, key(s.name)) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(q.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.s.name);
  throw new Error(`Unknown star "${query}".${close.length ? ` Did you mean ${close.join(', ')}?` : ''} Run "stars" to list the available names.`);
}

// Prints the catalogue with each star's current altitude/azimuth. Stars outside the allowed
// altitude window are hidden unless showAll is set.
export function listStars({ location, minAlt, maxAlt, showAll, now = new Date() }) {
  console.log(`${'Name'.padEnd(18)} ${'Mag'.padStart(5)}  ${'Alt'.padStart(10)}  ${'Az'.padStart(10)}`);
  let shown = 0;
  for (const star of STAR_LIST) {
    const of = precessFromJ2000(star.raHours, star.decDeg, now);
    const { alt, az } = raDecToAltAz(of.raHours, of.decDeg, now, location.latitude, location.longitude);
    const ok = alt >= minAlt && alt < maxAlt;
    if (!ok && !showAll) continue;
    shown += 1;
    console.log(`${star.name.padEnd(18)} ${star.mag.toFixed(2).padStart(5)}  ${formatAlt(alt, 0).padStart(10)}  ${formatAz(az, 0).padStart(10)}${ok ? '' : '  (not usable)'}`);
  }
  console.log(`\n${shown} of ${STAR_LIST.length} stars shown (usable: altitude ${minAlt}\u00b0 to ${maxAlt}\u00b0).`);
}
