/**
 * The queue. One SQLite file, one process, every agent on the machine.
 *
 * The invariant that makes partial answering safe lives here: an agent may
 * have any number of open `file` asks but at most ONE open `park` ask, because
 * an agent can only be stopped in one place.
 */

import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { matchesProfile, missingRequired } from './schema.js'

export function defaultDbPath() {
  const base =
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  return join(base, 'queue.db')
}

const TICKET_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // no look-alikes

function newTicket() {
  const bytes = randomBytes(6)
  let out = ''
  for (const b of bytes) out += TICKET_ALPHABET[b % TICKET_ALPHABET.length]
  return `ub_${out}`
}

const nowMs = () => Date.now()

/** Agents are identified for the one-park-at-a-time rule by the most specific id they gave us. */
function agentKey(origin) {
  return origin.session_id || origin.pane_id || `${origin.agent}:${origin.cwd || 'unknown'}`
}

export class Store {
  #db

  constructor(dbPath = defaultDbPath()) {
    // 0700/0600, because this file holds live link tokens as well as every ask,
    // answer and draft. A token is a capability; leaving it 0644 hands every
    // local account the queue.
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    try {
      chmodSync(dirname(dbPath), 0o700)
    } catch {
      /* pre-existing dir owned by someone else; the file mode below still helps */
    }
    this.#db = new DatabaseSync(dbPath)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#migrate()
    // WAL and SHM are created by the first write, so tighten after migrating.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${dbPath}${suffix}`, 0o600)
      } catch {
        /* not created yet; it inherits the 0700 directory either way */
      }
    }
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS asks (
        id            TEXT PRIMARY KEY,
        ticket        TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL,
        purpose       TEXT NOT NULL DEFAULT 'blocker',
        status        TEXT NOT NULL,
        title         TEXT NOT NULL,
        why           TEXT NOT NULL,
        fields_json   TEXT NOT NULL,
        steps_json    TEXT NOT NULL DEFAULT '[]',
        links_json    TEXT NOT NULL DEFAULT '[]',
        origin_json   TEXT NOT NULL,
        agent_key     TEXT NOT NULL,
        note          TEXT,
        reply         TEXT,
        created_at    INTEGER NOT NULL,
        answered_at   INTEGER,
        collected_at  INTEGER,
        closed_at     INTEGER,
        expires_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS asks_status_idx ON asks(status, kind);
      CREATE INDEX IF NOT EXISTS asks_agent_idx  ON asks(agent_key, status);

      CREATE TABLE IF NOT EXISTS answers (
        ask_id      TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
        field_name  TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        is_ref      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (ask_id, field_name)
      );

      -- Drafts live on the daemon, not the browser, so an ask half-filled on a
      -- phone shows up half-filled in the herdr pane.
      CREATE TABLE IF NOT EXISTS drafts (
        ask_id      TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
        field_name  TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (ask_id, field_name)
      );

      CREATE TABLE IF NOT EXISTS links (
        token       TEXT PRIMARY KEY,
        ask_id      TEXT REFERENCES asks(id) ON DELETE CASCADE,
        scope       TEXT NOT NULL DEFAULT 'queue',
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER
      );
    `)
    this.#addColumn('asks', 'reply', 'TEXT')
    this.#addColumn('asks', 'purpose', "TEXT NOT NULL DEFAULT 'blocker'")
  }

  /** Additive column, so an existing queue file keeps working. */
  #addColumn(table, column, type) {
    const has = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column)
    if (!has.n) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  close() {
    this.#db.close()
  }

  // ---------------------------------------------------------------- asks

  /**
   * Register an ask. `body` is the output of validateAsk, `origin` of
   * normalizeOrigin. Throws if the agent is already parked.
   */
  create(body, origin) {
    const key = agentKey(origin)

    if (body.kind === 'park') {
      const existing = this.#db
        .prepare(`SELECT ticket FROM asks WHERE agent_key = ? AND kind = 'park' AND status = 'open'`)
        .get(key)
      if (existing) {
        const err = new Error(
          `already parked on ${existing.ticket}. An agent can only be stopped in one place — ` +
            `add fields to that ask, or file this one instead.`,
        )
        err.code = 'ALREADY_PARKED'
        err.ticket = existing.ticket
        throw err
      }
    }

    const id = randomUUID()
    const ticket = newTicket()
    const created = nowMs()
    const expires = body.ttl_seconds ? created + body.ttl_seconds * 1000 : null

    this.#db
      .prepare(
        `INSERT INTO asks (id, ticket, kind, purpose, status, title, why, fields_json, steps_json,
                           links_json, origin_json, agent_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ticket,
        body.kind,
        body.purpose ?? 'blocker',
        body.title,
        body.why,
        JSON.stringify(body.fields),
        JSON.stringify(body.steps),
        JSON.stringify(body.links),
        JSON.stringify(origin),
        key,
        created,
        expires,
      )

    return this.get(id)
  }

  #hydrate(row) {
    if (!row) return null
    const answers = {}
    const refs = {}
    for (const a of this.#db
      .prepare('SELECT field_name, value_json, is_ref FROM answers WHERE ask_id = ?')
      .all(row.id)) {
      answers[a.field_name] = JSON.parse(a.value_json)
      if (a.is_ref) refs[a.field_name] = true
    }
    const draft = {}
    for (const d of this.#db
      .prepare('SELECT field_name, value_json FROM drafts WHERE ask_id = ?')
      .all(row.id)) {
      draft[d.field_name] = JSON.parse(d.value_json)
    }

    const ask = {
      id: row.id,
      ticket: row.ticket,
      kind: row.kind,
      purpose: row.purpose ?? 'blocker',
      status: row.status,
      gating: row.kind === 'park' && row.status === 'open',
      title: row.title,
      why: row.why,
      fields: JSON.parse(row.fields_json),
      steps: JSON.parse(row.steps_json),
      links: JSON.parse(row.links_json),
      origin: JSON.parse(row.origin_json),
      note: row.note ?? undefined,
      reply: row.reply ?? undefined,
      answers,
      answer_is_ref: refs,
      draft,
      created_at: row.created_at,
      answered_at: row.answered_at ?? undefined,
      collected_at: row.collected_at ?? undefined,
      closed_at: row.closed_at ?? undefined,
      expires_at: row.expires_at ?? undefined,
    }
    ask.missing = missingRequired(ask, { ...answers })
    return ask
  }

  get(idOrTicket) {
    const row = this.#db
      .prepare('SELECT * FROM asks WHERE id = ? OR ticket = ?')
      .get(idOrTicket, idOrTicket)
    return this.#hydrate(row)
  }

  /**
   * The queue view. `profile` filters using herdr's own visibility rule;
   * pass '*' for everything. Gating asks always sort first.
   */
  list({ profile = '*', status = ['open', 'answered'], agentKey: key, includeClosed = false } = {}) {
    const statuses = includeClosed ? null : status
    const rows = this.#db.prepare('SELECT * FROM asks ORDER BY created_at ASC').all()
    const asks = rows
      .map((r) => this.#hydrate(r))
      .filter((a) => (statuses ? statuses.includes(a.status) : true))
      .filter((a) => (key ? a.origin && agentKey(a.origin) === key : true))
      .filter((a) => matchesProfile(a.origin, profile))

    return asks.sort((a, b) => {
      if (a.gating !== b.gating) return a.gating ? -1 : 1
      return a.created_at - b.created_at
    })
  }

  /** Asks the active profile hides, so the UI can say "2 elsewhere" instead of silently dropping them. */
  countHidden(profile) {
    if (!profile || profile === '*') return 0
    return this.#db
      .prepare(`SELECT * FROM asks WHERE status IN ('open','answered')`)
      .all()
      .map((r) => JSON.parse(r.origin_json))
      .filter((o) => !matchesProfile(o, profile)).length
  }

  // ------------------------------------------------------------- answers

  /**
   * Record answers. Secret values must already have been swapped for a
   * reference by the secret store — pass `{ [field]: {ref, store} }` with
   * isRef true. Raw secret values never reach this table.
   */
  answer(idOrTicket, values, { refs = {}, reply } = {}) {
    const ask = this.get(idOrTicket)
    if (!ask) throw new Error(`no such ask: ${idOrTicket}`)
    if (['collected', 'cancelled', 'expired'].includes(ask.status)) {
      throw new Error(`ask ${ask.ticket} is ${ask.status}`)
    }

    const known = new Set(ask.fields.map((f) => f.name))
    const secretFields = new Set(ask.fields.filter((f) => f.type === 'secret').map((f) => f.name))

    // The invariant lives HERE, not in the transport, because there is more
    // than one transport. The daemon swaps a secret for a reference only when
    // the value is a non-empty string; a caller sending an array, a number or a
    // boolean slipped straight past that check and landed in this table as
    // plaintext, then read back into a model's context. Any script, phone
    // shortcut or CLI coercion could do it. So the store refuses outright: a
    // field declared `secret` is written only as a reference, whatever the
    // caller claims.
    for (const name of Object.keys(values)) {
      if (!secretFields.has(name)) continue
      const record = values[name]
      const isReference =
        refs[name] && record && typeof record === 'object' && typeof record.ref === 'string'
      if (!isReference) {
        const err = new Error(
          `field "${name}" is declared secret and can only be stored as a reference`,
        )
        err.code = 'SECRET_NOT_REFERENCED'
        throw err
      }
    }

    const at = nowMs()
    const stmt = this.#db.prepare(
      `INSERT INTO answers (ask_id, field_name, value_json, is_ref, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ask_id, field_name) DO UPDATE SET value_json = excluded.value_json,
                                                     is_ref     = excluded.is_ref,
                                                     created_at = excluded.created_at`,
    )
    for (const [name, value] of Object.entries(values)) {
      if (!known.has(name)) continue
      stmt.run(ask.id, name, JSON.stringify(value), refs[name] ? 1 : 0, at)
    }
    if (reply !== undefined) {
      // Free text on every ask, always optional. This is where "yes but also
      // check X" goes — the part a typed field cannot hold.
      this.#db.prepare('UPDATE asks SET reply = ? WHERE id = ?').run(reply || null, ask.id)
    }
    this.#db.prepare('DELETE FROM drafts WHERE ask_id = ?').run(ask.id)

    const updated = this.get(ask.id)
    if (updated.missing.length === 0 && updated.status === 'open') {
      this.#db.prepare(`UPDATE asks SET status = 'answered', answered_at = ? WHERE id = ?`).run(at, ask.id)
      return { ask: this.get(ask.id), complete: true }
    }
    return { ask: updated, complete: false }
  }

  saveDraft(idOrTicket, values) {
    const ask = this.get(idOrTicket)
    if (!ask) throw new Error(`no such ask: ${idOrTicket}`)
    const known = new Set(ask.fields.map((f) => f.name))
    const at = nowMs()
    const stmt = this.#db.prepare(
      `INSERT INTO drafts (ask_id, field_name, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ask_id, field_name) DO UPDATE SET value_json = excluded.value_json,
                                                     updated_at = excluded.updated_at`,
    )
    for (const [name, value] of Object.entries(values)) {
      if (!known.has(name)) continue
      // A draft never holds a secret. Half-typed keys stay in the browser.
      const field = ask.fields.find((f) => f.name === name)
      if (field.type === 'secret') continue
      stmt.run(ask.id, name, JSON.stringify(value), at)
    }
    return this.get(ask.id)
  }

  /** The agent picked up its answers. */
  collect(idOrTicket) {
    const ask = this.get(idOrTicket)
    if (!ask) return null
    this.#db
      .prepare(`UPDATE asks SET status = 'collected', collected_at = ? WHERE id = ?`)
      .run(nowMs(), ask.id)
    return this.get(ask.id)
  }

  /** Everything this agent can be told right now: its answered asks, filed or parked. */
  pending(origin) {
    return this.list({ agentKey: agentKey(origin), status: ['answered'] })
  }

  cancel(idOrTicket, note) {
    const ask = this.get(idOrTicket)
    if (!ask) return null
    this.#db
      .prepare(`UPDATE asks SET status = 'cancelled', closed_at = ?, note = ? WHERE id = ?`)
      .run(nowMs(), note ?? null, ask.id)
    return this.get(ask.id)
  }

  /** The agent is gone. Answers are kept so a later agent can claim them by ticket. */
  orphan(idOrTicket, note) {
    const ask = this.get(idOrTicket)
    if (!ask) return null
    this.#db
      .prepare(`UPDATE asks SET status = 'orphaned', note = ? WHERE id = ?`)
      .run(note ?? null, ask.id)
    return this.get(ask.id)
  }

  /** Expire anything past its TTL. Returns the asks that just expired. */
  sweep() {
    const at = nowMs()
    const stale = this.#db
      .prepare(`SELECT id FROM asks WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`)
      .all(at)
    for (const { id } of stale) {
      this.#db.prepare(`UPDATE asks SET status = 'expired', closed_at = ? WHERE id = ?`).run(at, id)
    }
    this.#db.prepare('DELETE FROM links WHERE expires_at < ?').run(at)
    return stale.map(({ id }) => this.get(id))
  }

  // --------------------------------------------------------------- links

  /**
   * An ephemeral URL token. Dies on use for a single ask, or on expiry for the
   * whole-queue link. Stolen from one-time-secret services: a stale tab in a
   * pocket should not still be live tomorrow.
   */
  mintLink({ askId = null, scope = 'queue', ttlSeconds = 900 } = {}) {
    // Clamp, because an unvalidated TTL from a request body minted links that
    // expire in the year 33715. A link is a capability; it must always die.
    const ttl = Math.min(Math.max(Math.round(Number(ttlSeconds) || 900), 30), 60 * 60 * 24)
    const token = randomBytes(24).toString('base64url')
    const at = nowMs()
    this.#db
      .prepare('INSERT INTO links (token, ask_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, askId, scope, at, at + ttl * 1000)
    return { token, expires_at: at + ttl * 1000 }
  }

  resolveLink(token) {
    const row = this.#db.prepare('SELECT * FROM links WHERE token = ?').get(token)
    if (!row) return null
    if (row.expires_at < nowMs()) return null
    if (row.used_at) return null
    return row
  }

  burnLink(token) {
    this.#db.prepare('UPDATE links SET used_at = ? WHERE token = ?').run(nowMs(), token)
  }
}

export { agentKey }
