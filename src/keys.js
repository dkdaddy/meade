import readline from 'node:readline';

// Single-key input from an interactive terminal. Ctrl+C arrives as the key 'interrupt' (raw mode disables SIGINT).
export function openKeys(onInterrupt) {
  if (!process.stdin.isTTY) throw new Error('This command needs an interactive terminal (keyboard input).');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const handlers = new Set();
  const listener = (str, key = {}) => {
    const name = key.ctrl && key.name === 'c' ? 'interrupt' : (key.name ?? str);
    if (name === 'interrupt') onInterrupt?.();
    for (const h of [...handlers]) h(name);
  };
  process.stdin.on('keypress', listener);

  return {
    // Resolves with the next pressed key whose name is in `names`; 'interrupt' (Ctrl+C) always resolves.
    wait(names) {
      return new Promise((resolve) => {
        const h = (name) => {
          if (name === 'interrupt' || names.includes(name)) {
            handlers.delete(h);
            resolve(name);
          }
        };
        handlers.add(h);
      });
    },
    onKey(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    close() {
      process.stdin.off('keypress', listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}
