// @ts-nocheck
/***
 * lib/pluginLoader.ts
 *
 * Central lifecycle manager for all plugins.
 *
 * ─── HOW TO USE ──────────────────────────────────────────────────────────
 *
 * In index.ts, inside the 'connection.update' → connection === 'open' block:
 *   import pluginLoader from './lib/pluginLoader';
 *   await pluginLoader.start(sock);
 *
 * In messageHandler.ts, inside handleMessages():
 *   await pluginLoader.dispatchMessage(sock, message, context);
 *
 * ─── PLUGIN CONTRACT ─────────────────────────────────────────────────────
 *
 * A plugin CAN (all optional) export any of these:
 *
 *   export const command = 'mycommand';
 *   export async function handler(...) {}
 *
 *   // Called once after bot connects
 *   export async function onLoad(sock) {}
 *
 *   // Called on every non-bot message — return true to stop further dispatch
 *   export async function onMessage(sock, message, context) {}
 *
 *   // Time-based tasks
 *   export const schedules = [
 *     { at: '09:00', handler: async (sock) => { ... } },
 *     { every: 60 * 60 * 1000, handler: async (sock) => { ... } }
 *   ];
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const { printLog } = require('./print');

// ── Types ────────────────────────────────────────────────────────────────────

interface Schedule {
  at?:      string;
  every?:   number;
  handler:  (sock: any) => Promise<void>;
}

interface Plugin {
  command?:    string;
  name?:       string;
  onLoad?:     (sock: any) => Promise<void>;
  onMessage?:  (sock: any, message: any, context: any) => Promise<boolean | void>;
  schedules?:  Schedule[];
}

interface MessageHook {
  label: string;
  fn:    NonNullable<Plugin['onMessage']>;
}

// ── Internal state ────────────────────────────────────────────────────────────

let _sock:    any    = null;
let _started: boolean = false;

const _messageHooks: MessageHook[] = [];
const _timers:       NodeJS.Timeout[] = [];

const settings = (() => {
  try { return require('../settings'); }
  catch { return { timeZone: 'UTC' }; }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowInTZ(): string {
  return new Date().toLocaleString('en-GB', {
    timeZone: settings.timeZone || 'UTC',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

function pluginsDir(): string {
  return path.join(__dirname, '../plugins');
}

function loadAllPlugins(): Plugin[] {
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') || f.endsWith('.ts'))
    .map(f => {
      try {
        return require(path.join(dir, f));
      } catch (err: any) {
        printLog('warning', `[pluginLoader] Failed to require ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean) as Plugin[];
}

// ── Schedule engine ───────────────────────────────────────────────────────────

function scheduleAtTime(timeStr: string, handler: (sock: any) => Promise<void>, label: string): void {
  let lastFiredDate: string | null = null;

  const id = setInterval(async () => {
    const now   = nowInTZ();
    const today = new Date().toLocaleDateString();

    if (now === timeStr && lastFiredDate !== today) {
      lastFiredDate = today;
      printLog('info', `[pluginLoader] ⏰ Schedule "${label}" firing at ${timeStr}`);
      try {
        await handler(_sock);
      } catch (err: any) {
        printLog('error', `[pluginLoader] Schedule "${label}" error: ${err.message}`);
      }
    }
  }, 60_000);

  _timers.push(id);
}

function scheduleEvery(ms: number, handler: (sock: any) => Promise<void>, label: string): void {
  const id = setInterval(async () => {
    printLog('info', `[pluginLoader] 🔁 Interval "${label}" firing`);
    try {
      await handler(_sock);
    } catch (err: any) {
      printLog('error', `[pluginLoader] Interval "${label}" error: ${err.message}`);
    }
  }, ms);

  _timers.push(id);
}

// ── Public API ────────────────────────────────────────────────────────────────

const pluginLoader = {
  /**
   * Call once inside `connection.update → connection === 'open'`.
   * Safe to call multiple times — only runs once.
   */
  async start(sock: any): Promise<void> {
    if (_started) return;
    _started = true;
    _sock    = sock;

    printLog('info', '[pluginLoader] Starting plugin lifecycle hooks...');

    const plugins = loadAllPlugins();
    let loadCount        = 0;
    let scheduleCount    = 0;
    let messageHookCount = 0;

    for (const plugin of plugins) {
      const label = plugin.command || plugin.name || '(unnamed)';

      // 1. Register onMessage hooks
      if (typeof plugin.onMessage === 'function') {
        _messageHooks.push({ label, fn: plugin.onMessage });
        messageHookCount++;
      }

      // 2. Run onLoad
      if (typeof plugin.onLoad === 'function') {
        try {
          await plugin.onLoad(sock);
          loadCount++;
          printLog('success', `[pluginLoader] onLoad ✓ ${label}`);
        } catch (err: any) {
          printLog('error', `[pluginLoader] onLoad failed for ${label}: ${err.message}`);
        }
      }

      // 3. Register schedules
      if (Array.isArray(plugin.schedules)) {
        for (const sched of plugin.schedules) {
          const schedLabel = `${label}/${sched.at ?? sched.every + 'ms'}`;

          if (sched.at && typeof sched.handler === 'function') {
            scheduleAtTime(sched.at, sched.handler, schedLabel);
            scheduleCount++;
            printLog('info', `[pluginLoader] Schedule registered: ${schedLabel}`);
          } else if (sched.every && typeof sched.handler === 'function') {
            scheduleEvery(sched.every, sched.handler, schedLabel);
            scheduleCount++;
            printLog('info', `[pluginLoader] Interval registered: ${schedLabel}`);
          }
        }
      }
    }

    printLog('success',
      `[pluginLoader] Ready — onLoad: ${loadCount}, schedules: ${scheduleCount}, onMessage hooks: ${messageHookCount}`
    );
  },

  /**
   * Call inside handleMessages() in messageHandler.ts.
   */
  async dispatchMessage(sock: any, message: any, context: any): Promise<void> {
    for (const { label, fn } of _messageHooks) {
      try {
        const handled = await fn(sock, message, context);
        if (handled === true) break;
      } catch (err: any) {
        printLog('error', `[pluginLoader] onMessage hook "${label}" error: ${err.message}`);
      }
    }
  },

  /** Graceful shutdown — clears all timers */
  stop(): void {
    for (const id of _timers) clearInterval(id);
    _timers.length = 0;
    _started = false;
    printLog('info', '[pluginLoader] All plugin timers cleared.');
  },
};

process.on('SIGINT',  () => pluginLoader.stop());
process.on('SIGTERM', () => pluginLoader.stop());

export default pluginLoader;
