import { SerialPort } from 'serialport';
import { parseSexagesimal } from './angles.js';

const REPLY_TIMEOUT_MS = 2000;

// query() is read-only: only LX200 "get" commands (:G...#) can be sent through it.
const READ_ONLY_COMMAND = /^:G[A-Za-z]+#$/;
// command() is the only way to make the scope move, and accepts nothing else: directional moves (:Mn# :Ms# :Me# :Mw#),
// stops (:Q# :Qn# ...) and the move-rate keys (:RG# :RC# :RM# :RS#). Never settings, time, site, targets or sync.
const MOTION_COMMAND = /^:(M[nsew]|Q[nsew]?|R[CGMS])#$/;

// "+DD*MM:SS" / "DDD*MM:SS" (the scope uses 0xDF, shown as '*', for the degree sign).
const ANGLE_REPLY = /^[+-]?\d{1,3}[^\d]\d{1,2}(:\d{1,2})?$/;

// The Autostar sends azimuths of 100..359 with the first two digits packed into one character, 0x30 + (deg div 10):
// 359*58:47 arrives as "S9*58:47" ('S' = 0x30 + 35). Expand that back to the normal 3-digit form.
function decodeAzimuth(text) {
  const m = /^([^\d+-])(\d)([^\d].*)$/.exec(text);
  if (!m) return text;
  const tens = m[1].charCodeAt(0) - 0x30;
  return tens >= 10 && tens <= 35 ? `${tens}${m[2]}${m[3]}` : text;
}

function parseAngle(text, label, min, max) {
  if (!ANGLE_REPLY.test(text)) throw new Error(`Unexpected ${label} reply from the scope: "${text}"`);
  const value = parseSexagesimal(text, label);
  if (value < min || value > max) throw new Error(`${label} reply out of range: "${text}"`);
  return value;
}

export class Scope {
  #port;
  #rx = '';
  #check = null;

  constructor(path) {
    this.path = path;
    this.#port = new SerialPort({ path, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
    this.#port.on('data', (chunk) => {
      this.#rx += chunk.toString('latin1');
      this.#check?.();
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.#port.open((err) => (err ? reject(new Error(`Cannot open ${this.path}: ${err.message}`)) : resolve()));
    });
  }

  close() {
    return new Promise((resolve) => (this.#port.isOpen ? this.#port.close(() => resolve()) : resolve()));
  }

  #readUntilHash() {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const i = this.#rx.indexOf('#');
        if (i === -1) return false;
        const reply = this.#rx.slice(0, i);
        this.#rx = this.#rx.slice(i + 1);
        resolve(reply);
        return true;
      };
      if (attempt()) return;
      const timer = setTimeout(() => {
        this.#check = null;
        reject(new Error('Timed out waiting for the scope to reply'));
      }, REPLY_TIMEOUT_MS);
      this.#check = () => {
        if (attempt()) {
          clearTimeout(timer);
          this.#check = null;
        }
      };
    });
  }

  #write(text) {
    return new Promise((resolve, reject) => {
      this.#port.write(text, 'latin1', (err) => {
        if (err) return reject(err);
        this.#port.drain(() => resolve());
      });
    });
  }

  // '#'-terminated string reply; the scope's 0xDF degree sign is returned as '*'.
  async query(command) {
    if (!READ_ONLY_COMMAND.test(command)) throw new Error(`Refusing to send "${command}" as a query: queries are read-only`);
    this.#rx = '';
    await this.#write(command);
    const reply = (await this.#readUntilHash()).replaceAll('\xdf', '*');
    return command === ':GZ#' ? decodeAzimuth(reply) : reply;
  }

  // Motion-only commands (no reply expected).
  async command(command) {
    if (!MOTION_COMMAND.test(command)) throw new Error(`Refusing to send "${command}": only motion commands are allowed`);
    await this.#write(command);
  }

  // Halts every axis. Safe to call at any time.
  async stopAll() {
    for (const c of [':Q#', ':Qn#', ':Qs#', ':Qe#', ':Qw#']) {
      await this.command(c);
    }
  }

  async queryOrNull(command) {
    try {
      return await this.query(command);
    } catch {
      return null;
    }
  }

  // The scope's own reported altitude (-90..90) and azimuth (0..360), in degrees.
  async readAlt() {
    const text = await this.query(':GA#');
    return { text, deg: parseAngle(text, 'altitude', -90, 90) };
  }

  async readAz() {
    const text = await this.query(':GZ#');
    return { text, deg: parseAngle(text, 'azimuth', 0, 360) };
  }

  async readAltAz() {
    const a = await this.readAlt();
    const z = await this.readAz();
    return { altText: a.text, azText: z.text, alt: a.deg, az: z.deg };
  }
}
