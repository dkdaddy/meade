import { prettyReply } from './angles.js';
import { Scope } from './lx200.js';

const QUERIES = [
  ['RA', ':GR#', 'ra'],
  ['Dec', ':GD#', 'angle'],
  ['Alt', ':GA#', 'angle'],
  ['Az', ':GZ#', 'angle'],
  ['Time', ':GL#'],
  ['Date', ':GC#'],
  ['Lat', ':Gt#', 'angle'],
  ['Long', ':Gg#', 'angle'],
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
    for (const [name, cmd, kind] of QUERIES) {
      const reply = await scope.queryOrNull(cmd);
      parts.push(`${name}=${reply === null ? '--' : kind ? prettyReply(reply, kind) : reply}`);
    }
    console.log(`${new Date().toISOString()}  ${parts.join('  ')}`);
    await sleep(intervalMs);
  }
  await scope.close();
}
