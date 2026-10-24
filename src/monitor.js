import { Scope } from './lx200.js';

const QUERIES = [
  ['RA', ':GR#'],
  ['Dec', ':GD#'],
  ['Alt', ':GA#'],
  ['Az', ':GZ#'],
  ['Time', ':GL#'],
  ['Date', ':GC#'],
  ['Lat', ':Gt#'],
  ['Long', ':Gg#'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function monitor(portPath, intervalMs) {
  const scope = new Scope(portPath);
  await scope.open();
  console.log(`Connected to ${portPath}. Polling every ${intervalMs} ms. Ctrl+C to quit.`);
  console.log(`Device: ${(await scope.queryOrNull(':GVP#')) ?? '?'} ${(await scope.queryOrNull(':GVN#')) ?? '?'}`);

  let running = true;
  process.once('SIGINT', () => {
    running = false;
  });

  while (running) {
    const parts = [];
    for (const [name, cmd] of QUERIES) {
      parts.push(`${name}=${(await scope.queryOrNull(cmd)) ?? '--'}`);
    }
    console.log(`${new Date().toISOString()}  ${parts.join('  ')}`);
    await sleep(intervalMs);
  }
  await scope.close();
}
