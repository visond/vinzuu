'use strict';
/**
 * One database interface for two places Vinzuu runs:
 *
 *  - On your computer (and in the tests): a SQLite file through Node's built-in node:sqlite.
 *  - Online on Vercel: Turso, a hosted SQLite-compatible database (set TURSO_DATABASE_URL and
 *    TURSO_AUTH_TOKEN). Vercel has no disk that survives a restart, so the data lives there.
 *
 * Both speak the same SQL. The interface mirrors node:sqlite's, except every call returns a
 * promise, because a hosted database answers over the network:
 *
 *    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
 *    const rows = await db.prepare('SELECT ...').all(a, b);
 *    const { changes, lastInsertRowid } = await db.prepare('INSERT ...').run(x);
 *    await db.exec('CREATE TABLE ...; CREATE INDEX ...');
 *
 * Many writes at once: `await db.batch([[sql, [args]], ...])` runs them all in one transaction,
 * and online in one network round trip (much faster than one await per row).
 *
 * Transactions: `await db.transaction(async () => { ... })`. Every db call made inside the
 * function, however deep, joins the transaction (AsyncLocalStorage tracks it), and an error
 * rolls all of it back. Nested transactions simply join the outer one.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const txStore = new AsyncLocalStorage();

/** node:sqlite wants no `undefined`; libsql wants plain numbers, strings, null or bytes. */
const cleanArgs = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  get(...args) { return this.db._query('get', this.sql, cleanArgs(args)); }
  all(...args) { return this.db._query('all', this.sql, cleanArgs(args)); }
  run(...args) { return this.db._query('run', this.sql, cleanArgs(args)); }
}

class Db {
  prepare(sql) { return new Statement(this, sql); }
}

const toStatements = (list) => list.map(([sql, args = []]) => ({ sql, args: cleanArgs(args) }));

// ---------------------------------------------------------------- node:sqlite (local file)

class LocalDb extends Db {
  constructor(file) {
    super();
    const { DatabaseSync } = require('node:sqlite');
    this.raw = new DatabaseSync(file);
    this.kind = 'sqlite';
    this.locked = null; // the promise of the transaction running now, if any
  }

  /** One connection is shared, so while a transaction is open other requests wait for it. */
  async _ready() {
    if (txStore.getStore()) return;
    while (this.locked) await this.locked;
  }

  async _query(mode, sql, args) {
    await this._ready();
    const stmt = this.raw.prepare(sql);
    if (mode !== 'run') return mode === 'get' ? stmt.get(...args) : stmt.all(...args);
    const r = stmt.run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  async exec(sql) { await this._ready(); this.raw.exec(sql); }

  async batch(list) {
    if (!list.length) return;
    await this.transaction(async () => {
      for (const { sql, args } of toStatements(list)) this.raw.prepare(sql).run(...args);
    });
  }

  async transaction(fn) {
    if (txStore.getStore()) return fn();
    // Check and take the lock with no await in between, so two transactions never both get it.
    while (this.locked) await this.locked;
    let release;
    this.locked = new Promise((r) => { release = r; });
    try {
      this.raw.exec('BEGIN');
      try {
        const result = await txStore.run({ local: true }, fn);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    } finally {
      this.locked = null;
      release();
    }
  }

  async close() { this.raw.close(); }
}

// ---------------------------------------------------------------- libsql (Turso, or a file)

class LibsqlDb extends Db {
  constructor(url, authToken) {
    super();
    // Online Vinzuu talks to Turso over plain HTTPS (the "web" client, pure JavaScript, which
    // suits Vercel's short-lived functions); only a local file needs the full client.
    const local = /^file:/.test(url);
    const { createClient } = require(local ? '@libsql/client' : '@libsql/client/web');
    this.client = createClient({ url: local ? url : url.replace(/^libsql:/, 'https:'), authToken, intMode: 'number' });
    this.kind = 'libsql';
    // Turso opens a fresh connection for every request, and SQLite starts each connection with
    // foreign keys off, so the schema's PRAGMA does not carry over. Online, every write therefore
    // runs in a transaction whose connection turns them on first (see transaction()). A local
    // file keeps one connection, where the schema's PRAGMA already holds.
    this.remote = !local;
  }

  _target() {
    const store = txStore.getStore();
    return store && store.tx ? store.tx : this.client;
  }

  async _query(mode, sql, args) {
    if (mode === 'run' && this.remote && !txStore.getStore()) return this.transaction(() => this._query(mode, sql, args));
    const rs = await this._target().execute({ sql, args });
    if (mode === 'run') return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? 0 : Number(rs.lastInsertRowid) };
    const rows = rs.rows.map((row) => {
      const o = {};
      rs.columns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    return mode === 'get' ? rows[0] : rows;
  }

  async exec(sql) { await this._target().executeMultiple(sql); }

  async batch(list) {
    if (!list.length) return;
    const store = txStore.getStore();
    if (store && store.tx) await store.tx.batch(toStatements(list));
    else if (this.remote) await this.transaction(() => this.batch(list));
    else await this.client.batch(toStatements(list), 'write');
  }

  async transaction(fn) {
    if (txStore.getStore()) return fn();
    const tx = await this.client.transaction('write');
    // The transaction sends BEGIN with its first statement, so this runs just before it, on the
    // same connection. (_getStream is the client's own; package.json pins the client version.)
    const foreignKeys = this.remote ? tx._getStream().run('PRAGMA foreign_keys = ON') : null;
    try {
      if (foreignKeys) await foreignKeys;
      const result = await txStore.run({ tx }, fn);
      await tx.commit();
      return result;
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already closed */ }
      throw err;
    } finally {
      tx.close();
    }
  }

  async close() { this.client.close(); }
}

/**
 * A local file path (or ':memory:') opens node:sqlite. A libsql:// or https:// URL opens Turso;
 * a file: URL opens the same file through libsql (the tests use it to check that path offline).
 */
function connect(target, authToken) {
  if (/^(libsql|https?|wss?|file):/.test(target)) return new LibsqlDb(target, authToken);
  return new LocalDb(target);
}

/** True for a unique or foreign-key violation, whichever database raised it. */
function constraintKind(err) {
  const msg = String(err && err.message || '');
  if (/UNIQUE constraint failed/i.test(msg)) return 'unique';
  if (/FOREIGN KEY constraint failed/i.test(msg)) return 'foreign_key';
  return null;
}

module.exports = { connect, constraintKind };
