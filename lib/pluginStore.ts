// @ts-nocheck
/***
 * lib/pluginStore.ts
 *
 * Gives every plugin its own physical table in whichever database backend
 * the bot is running — with zero changes to lightweight_store.ts.
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 *  SINGLE TABLE:
 *    import { createStore } from '../lib/pluginStore';
 *    const db = createStore('myplugin');
 *    await db.set('config', { enabled: true });
 *
 *  MULTIPLE TABLES:
 *    const db      = createStore('attendance');
 *    const records = db.table('records');   // → plugin_attendance_records
 *    const cfg     = db.table('settings'); // → plugin_attendance_settings
 *
 *  METHODS (root store and every named table):
 *    .get(key)                    → value | null
 *    .set(key, value)             → void
 *    .del(key)                    → void
 *    .getAll()                    → { key: value, ... }
 *    .has(key)                    → boolean
 *    .getOrDefault(key, fallback) → value | fallback
 *    .patch(key, partialObject)   → void
 *
 *  ROOT STORE ONLY:
 *    .table(name)                 → isolated store for that physical table
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import fs   from 'fs';
import path from 'path';

// ── Environment ───────────────────────────────────────────────────────────────

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Adapter {
  name:         string;
  ensureTable:  (table: string) => Promise<void>;
  get:          (table: string, key: string) => Promise<any>;
  set:          (table: string, key: string, value: any) => Promise<void>;
  del:          (table: string, key: string) => Promise<void>;
  getAll:       (table: string) => Promise<Record<string, any>>;
}

interface PluginStore {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  getAll(): Promise<Record<string, any>>;
  has(key: string): Promise<boolean>;
  getOrDefault(key: string, defaultValue: any): Promise<any>;
  patch(key: string, patch: Record<string, any>): Promise<void>;
  table?(name: string): PluginStore;
  readonly namespace:     string;
  readonly tableName:     string | null;
  readonly physicalTable: string;
}

// ── Table name helpers ────────────────────────────────────────────────────────

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

function physicalName(namespace: string, tableName?: string): string {
  return tableName ? `${sanitize(namespace)}_${sanitize(tableName)}` : sanitize(namespace);
}

// ── Backend adapter factory ───────────────────────────────────────────────────

let _adapter:        Adapter | null = null;
let _adapterPromise: Promise<Adapter> | null = null;

async function getAdapter(): Promise<Adapter> {
  if (_adapter) return _adapter;
  if (_adapterPromise) return _adapterPromise;
  _adapterPromise = _initAdapter();
  _adapter = await _adapterPromise;
  return _adapter;
}

async function _initAdapter(): Promise<Adapter> {

  // ── MongoDB ────────────────────────────────────────────────────────────────
  if (MONGO_URL) {
    try {
      const mongoose = require('mongoose');

      await new Promise<void>((resolve, reject) => {
        if (mongoose.connection.readyState === 1) return resolve();
        if (mongoose.connection.readyState === 2) {
          mongoose.connection.once('connected', resolve);
          mongoose.connection.once('error', reject);
          return;
        }
        mongoose.connect(MONGO_URL).then(resolve).catch(reject);
      });

      const db = mongoose.connection.db;

      return {
        name: 'mongo',

        async ensureTable(table) {
          const list = await db.listCollections({ name: table }).toArray();
          if (list.length === 0) await db.createCollection(table);
        },

        async get(table, key) {
          const doc = await db.collection(table).findOne({ _id: key });
          return doc ? doc.value : null;
        },

        async set(table, key, value) {
          await db.collection(table).updateOne(
            { _id: key },
            { $set: { value, ts: Date.now() } },
            { upsert: true }
          );
        },

        async del(table, key) {
          await db.collection(table).deleteOne({ _id: key });
        },

        async getAll(table) {
          const docs = await db.collection(table).find({}).toArray();
          const result: Record<string, any> = {};
          for (const doc of docs) result[doc._id] = doc.value;
          return result;
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] MongoDB adapter failed, falling back:', e.message);
    }
  }

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  if (POSTGRES_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: POSTGRES_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 60000,
      });

      const ready = new Set<string>();

      return {
        name: 'postgres',

        async ensureTable(table) {
          if (ready.has(table)) return;
          const client = await pool.connect();
          try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS "${table}" (
                key   TEXT   NOT NULL PRIMARY KEY,
                value TEXT,
                ts    BIGINT NOT NULL DEFAULT 0
              )
            `);
            ready.add(table);
          } finally {
            client.release();
          }
        },

        async get(table, key) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            const res = await client.query(
              `SELECT value FROM "${table}" WHERE key=$1`, [key]
            );
            return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
          } finally {
            client.release();
          }
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            await client.query(
              `INSERT INTO "${table}"(key, value, ts) VALUES($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET value=$2, ts=$3`,
              [key, JSON.stringify(value), Date.now()]
            );
          } finally {
            client.release();
          }
        },

        async del(table, key) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            await client.query(`DELETE FROM "${table}" WHERE key=$1`, [key]);
          } finally {
            client.release();
          }
        },

        async getAll(table) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            const res = await client.query(`SELECT key, value FROM "${table}"`);
            const result: Record<string, any> = {};
            for (const row of res.rows) result[row.key] = JSON.parse(row.value);
            return result;
          } finally {
            client.release();
          }
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] PostgreSQL adapter failed, falling back:', e.message);
    }
  }

  // ── MySQL ──────────────────────────────────────────────────────────────────
  if (MYSQL_URL) {
    try {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection(MYSQL_URL);
      const ready = new Set<string>();

      return {
        name: 'mysql',

        async ensureTable(table) {
          if (ready.has(table)) return;
          await conn.execute(`
            CREATE TABLE IF NOT EXISTS \`${table}\` (
              \`key\`   VARCHAR(512) NOT NULL PRIMARY KEY,
              \`value\` LONGTEXT,
              \`ts\`    BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          `);
          ready.add(table);
        },

        async get(table, key) {
          await this.ensureTable(table);
          const [rows] = await conn.execute(
            `SELECT \`value\` FROM \`${table}\` WHERE \`key\`=?`, [key]
          );
          return rows[0] ? JSON.parse(rows[0].value) : null;
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          await conn.execute(
            `INSERT INTO \`${table}\`(\`key\`, \`value\`, \`ts\`) VALUES(?, ?, ?)
             ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`ts\`=VALUES(\`ts\`)`,
            [key, JSON.stringify(value), Date.now()]
          );
        },

        async del(table, key) {
          await this.ensureTable(table);
          await conn.execute(`DELETE FROM \`${table}\` WHERE \`key\`=?`, [key]);
        },

        async getAll(table) {
          await this.ensureTable(table);
          const [rows] = await conn.execute(
            `SELECT \`key\`, \`value\` FROM \`${table}\``
          );
          const result: Record<string, any> = {};
          for (const row of rows) result[row.key] = JSON.parse(row.value);
          return result;
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] MySQL adapter failed, falling back:', e.message);
    }
  }

  // ── SQLite ─────────────────────────────────────────────────────────────────
  if (SQLITE_URL) {
    try {
      const Database = require('better-sqlite3');
      const sqlite   = new Database(SQLITE_URL);
      sqlite.pragma('journal_mode = WAL');

      const ready = new Set<string>();

      return {
        name: 'sqlite',

        async ensureTable(table) {
          if (ready.has(table)) return;
          sqlite.prepare(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT NOT NULL PRIMARY KEY,
              value TEXT,
              ts    INTEGER NOT NULL DEFAULT 0
            )
          `).run();
          ready.add(table);
        },

        async get(table, key) {
          await this.ensureTable(table);
          const row = sqlite.prepare(
            `SELECT value FROM "${table}" WHERE key=?`
          ).get(key);
          return row ? JSON.parse(row.value) : null;
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          sqlite.prepare(
            `INSERT OR REPLACE INTO "${table}"(key, value, ts) VALUES(?, ?, ?)`
          ).run(key, JSON.stringify(value), Date.now());
        },

        async del(table, key) {
          await this.ensureTable(table);
          sqlite.prepare(`DELETE FROM "${table}" WHERE key=?`).run(key);
        },

        async getAll(table) {
          await this.ensureTable(table);
          const rows = sqlite.prepare(
            `SELECT key, value FROM "${table}"`
          ).all();
          const result: Record<string, any> = {};
          for (const row of rows) result[row.key] = JSON.parse(row.value);
          return result;
        }
      };
    } catch (e: any) {
      console.error('[pluginStore] SQLite adapter failed, falling back:', e.message);
    }
  }

  // ── File / memory fallback ─────────────────────────────────────────────────

  const DATA_DIR = path.join(process.cwd(), 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  function filePath(table: string): string {
    return path.join(DATA_DIR, `${table}.json`);
  }

  function readFile(table: string): Record<string, any> {
    const fp = filePath(table);
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
    catch { return {}; }
  }

  function writeFile(table: string, data: Record<string, any>): void {
    fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
  }

  return {
    name: 'file',

    async ensureTable(_table) { /* file created on first write */ },

    async get(table, key) {
      return readFile(table)[key] ?? null;
    },

    async set(table, key, value) {
      const data = readFile(table);
      data[key]  = value;
      writeFile(table, data);
    },

    async del(table, key) {
      const data = readFile(table);
      delete data[key];
      writeFile(table, data);
    },

    async getAll(table) {
      return readFile(table);
    }
  };
}

// ── Core store factory ────────────────────────────────────────────────────────

function makeStore(namespace: string, tableName: string | undefined, isRoot: boolean): PluginStore {
  const physical = physicalName(namespace, tableName);
  const tag       = `[pluginStore:${physical}]`;

  let _tableReady = false;

  async function ready(): Promise<void> {
    if (_tableReady) return;
    const adapter = await getAdapter();
    await adapter.ensureTable(physical);
    _tableReady = true;
  }

  async function adapter(): Promise<Adapter> {
    await ready();
    return getAdapter();
  }

  const store: PluginStore = {
    async get(key) {
      try {
        const a = await adapter();
        return await a.get(physical, key);
      } catch (err: any) {
        console.error(`${tag} get("${key}"):`, err.message);
        return null;
      }
    },

    async set(key, value) {
      try {
        const a = await adapter();
        await a.set(physical, key, value);
      } catch (err: any) {
        console.error(`${tag} set("${key}"):`, err.message);
      }
    },

    async del(key) {
      try {
        const a = await adapter();
        await a.del(physical, key);
      } catch (err: any) {
        console.error(`${tag} del("${key}"):`, err.message);
      }
    },

    async getAll() {
      try {
        const a = await adapter();
        return await a.getAll(physical);
      } catch (err: any) {
        console.error(`${tag} getAll():`, err.message);
        return {};
      }
    },

    async has(key) {
      return (await this.get(key)) !== null;
    },

    async getOrDefault(key, defaultValue) {
      const value = await this.get(key);
      return value !== null ? value : defaultValue;
    },

    async patch(key, patch) {
      const existing = (await this.get(key)) || {};
      await this.set(key, { ...existing, ...patch });
    },

    get namespace()     { return namespace; },
    get tableName()     { return tableName ?? null; },
    get physicalTable() { return physical; },
  };

  if (isRoot) {
    store.table = (name: string): PluginStore => {
      if (!name || typeof name !== 'string' || /[^a-z0-9_]/i.test(name)) {
        throw new Error(
          `${tag} table name must be a non-empty alphanumeric string (got: "${name}")`
        );
      }
      return makeStore(namespace, name, false);
    };
  }

  return store;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an isolated, physical-table-backed store for a plugin.
 *
 * @param namespace  Unique plugin name e.g. 'attendance'. Alphanumeric + underscore only.
 *
 * @example
 *   const db      = createStore('attendance');
 *   const records = db.table('records');   // → plugin_attendance_records
 *   await records.set(`user:${userId}`, { date, streak });
 */
export function createStore(namespace: string): PluginStore {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('[pluginStore] namespace must be a non-empty string');
  }
  if (/[^a-z0-9_]/i.test(namespace)) {
    throw new Error(
      `[pluginStore] namespace "${namespace}" must contain only letters, digits, or underscores`
    );
  }
  return makeStore(namespace, undefined, true);
}
