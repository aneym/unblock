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

import { APPROVAL_PURPOSES, matchesProfile, missingRequired } from './schema.js'

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
const normalizeTitle = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()

/** Agents are identified for the one-park-at-a-time rule by the most specific id they gave us. */
function agentKey(origin) {
  return origin.session_id || origin.pane_id || `${origin.agent}:${origin.cwd || 'unknown'}`
}

/**
 * An answer or send-back for an ask that is already past it. 410, not 500: the
 * page retries a send whose reply it lost, and when the first try landed and
 * the agent collected it, "gone" is the truth the page acts on.
 */
/** Statuses an answer can no longer change. A sent-back ask is done too: the agent re-asks. */
export const CLOSED_TO_ANSWERS = ['collected', 'cancelled', 'expired', 'bounced']

export function finished(ask) {
  const error = new Error(`ask ${ask.ticket} is ${ask.status}`)
  error.status = 410
  return error
}

/**
 * The verdict, per purpose, that a WebAuthn assertion gates. Tailscale
 * identity alone is forgeable by any agent on this machine (they share the
 * macOS user with `tailscaled`), so these three go through Touch ID as well.
 * Spend does not: Link's own push to Alex's phone is spend's human check.
 */
export const PASSKEY_VERDICTS = { consent: 'approve', message: 'approve', permission: 'allow_once' }
export const PASSKEY_CREDENTIAL_CAP = 5

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

      -- Per-field free text from the human: context that belongs to ONE
      -- question rather than the whole ask. Unlike a draft it survives the
      -- answer, so the agent reads it back next to the value it annotates.
      CREATE TABLE IF NOT EXISTS field_notes (
        ask_id      TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
        field_name  TEXT NOT NULL,
        note        TEXT NOT NULL,
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

      -- A single-use WebAuthn challenge. An 'approve' challenge is bound to the
      -- exact (ask_id, revision) it was minted for, so it cannot gate a
      -- different ask or a revised one; 'register' and 'enroll_auth' carry no
      -- ask at all.
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id          TEXT PRIMARY KEY,
        challenge   BLOB NOT NULL,
        kind        TEXT NOT NULL,
        ask_id      TEXT,
        revision    INTEGER,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER,
        -- 1 when an existing passkey signed off on this 'register' challenge.
        authorized  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id              TEXT PRIMARY KEY,
        public_key_jwk  TEXT NOT NULL,
        alg             INTEGER NOT NULL,
        sign_count      INTEGER NOT NULL,
        label           TEXT,
        created_at      INTEGER NOT NULL,
        created_via     TEXT,
        user_agent      TEXT
      );

      CREATE TABLE IF NOT EXISTS passkey_events (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        credential_id  TEXT NOT NULL,
        label          TEXT,
        at             INTEGER NOT NULL,
        via            TEXT,
        dismissed_at   INTEGER
      );
    `)
    this.#addColumn('asks', 'reply', 'TEXT')
    this.#addColumn('asks', 'purpose', "TEXT NOT NULL DEFAULT 'blocker'")
    this.#addColumn('asks', 'project', 'TEXT')
    this.#addColumn('asks', 'tried_json', "TEXT NOT NULL DEFAULT '[]'")
    this.#addColumn('asks', 'only_you', 'TEXT')
    // Set when an agent revises a live ask in place. A client that is already
    // rendering the ask watches this to know the QUESTIONS changed, which
    // draft_updated_at cannot tell it — that one only moves when the human types.
    this.#addColumn('asks', 'updated_at', 'INTEGER')
    for (const [name, type] of [['plan_json', 'TEXT'], ['spend_json', 'TEXT'], ['message_json', 'TEXT'],
      ['consent_blocked_by', 'TEXT'], ['receipt_json', 'TEXT'], ['revision', 'INTEGER NOT NULL DEFAULT 1']]) this.#addColumn('asks', name, type)
    for (const [name, type] of [['summary', 'TEXT'], ['minutes', 'INTEGER'], ['after', 'TEXT'],
      ['blocks_json', "TEXT NOT NULL DEFAULT '[]'"], ['permission_json', 'TEXT']]) this.#addColumn('asks', name, type)
    this.#addColumn('answers', 'answered_via', 'TEXT')
    this.#addColumn('links', 'minted_by', "TEXT NOT NULL DEFAULT 'local'")
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

    const duplicate = this.#db.prepare("SELECT ticket, title FROM asks WHERE status = 'open' AND project IS ?")
      .all(body.project ?? null)
      .find((ask) => normalizeTitle(ask.title) === normalizeTitle(body.title))
    if (duplicate) {
      const err = new Error(`already open as ${duplicate.ticket}; use unblock_update to revise it`)
      err.code = 'ALREADY_OPEN'
      err.ticket = duplicate.ticket
      throw err
    }

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
        `INSERT INTO asks (id, ticket, kind, purpose, project, status, title, why, fields_json, steps_json,
                           links_json, tried_json, only_you, origin_json, agent_key, created_at, expires_at, plan_json, spend_json, message_json, consent_blocked_by, revision, summary, minutes, after, blocks_json, permission_json)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ticket,
        body.kind,
        body.purpose ?? 'blocker',
        body.project ?? null,
        body.title,
        body.why,
        JSON.stringify(body.fields),
        JSON.stringify(body.steps),
        JSON.stringify(body.links),
        JSON.stringify(body.tried),
        body.only_you,
        JSON.stringify(origin),
        key,
        created,
        expires,
        body.plan ? JSON.stringify(body.plan) : null,
        body.spend ? JSON.stringify(body.spend) : null,
        body.message ? JSON.stringify(body.message) : null,
        body.consent_blocked_by ?? null,
        body.summary ?? null, body.minutes ?? null, body.after ?? null,
        JSON.stringify(body.blocks ?? []), body.permission ? JSON.stringify(body.permission) : null,
      )

    return this.get(id)
  }

  /**
   * Revise an OPEN ask in place. `body` is the output of validateUpdate.
   *
   * This exists because the alternative was cancel-and-refile, which throws
   * away the ticket, the link the human already has open, and everything they
   * had typed. An agent watching the drafts come in should be able to ask the
   * obvious follow-up without taking the page out from under them.
   *
   * Only an open ask can be revised: once a human has answered or sent it back,
   * the record holds their work and the questions they answered must stay the
   * questions they answered.
   */
  update(idOrTicket, { title, why, fields, steps, links, tried, only_you, plan, spend, message, permission, consent_blocked_by, summary, minutes, after, blocks }) {
    const ask = this.get(idOrTicket)
    if (!ask) return null
    if (ask.status !== 'open') {
      const err = new Error(
        `ask ${ask.ticket} is ${ask.status}, not open; a revision would change the question they already answered`,
      )
      err.code = 'ASK_NOT_OPEN'
      err.askStatus = ask.status
      throw err
    }
    const at = nowMs()
    this.#db
      .prepare('UPDATE asks SET title = ?, why = ?, fields_json = ?, steps_json = ?, links_json = ?, tried_json = ?, only_you = ?, plan_json = ?, spend_json = ?, message_json = ?, consent_blocked_by = ?, summary = ?, minutes = ?, after = ?, blocks_json = ?, permission_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(title, why, JSON.stringify(fields), JSON.stringify(steps), JSON.stringify(links), JSON.stringify(tried), only_you,
        plan ? JSON.stringify(plan) : null, spend ? JSON.stringify(spend) : null, message ? JSON.stringify(message) : null,
        consent_blocked_by ?? null, summary ?? null, minutes ?? null, after ?? null, JSON.stringify(blocks ?? []),
        permission ? JSON.stringify(permission) : null, at, ask.id)
    if (JSON.stringify(ask.plan) !== JSON.stringify(plan) || JSON.stringify(ask.spend) !== JSON.stringify(spend) ||
        JSON.stringify(ask.message) !== JSON.stringify(message) || JSON.stringify(ask.permission) !== JSON.stringify(permission)) this.#db.prepare('DELETE FROM drafts WHERE ask_id = ?').run(ask.id)

    // Drafts and notes for fields that no longer exist would hydrate into an
    // ask with nowhere to show them. Everything else is left alone on purpose:
    // an edit must not cost the human the answers they already typed.
    const keep = new Set(fields.map((field) => field.name))
    const dropDraft = this.#db.prepare('DELETE FROM drafts WHERE ask_id = ? AND field_name = ?')
    const dropNote = this.#db.prepare('DELETE FROM field_notes WHERE ask_id = ? AND field_name = ?')
    for (const name of new Set([...Object.keys(ask.draft), ...Object.keys(ask.field_context)])) {
      if (keep.has(name)) continue
      dropDraft.run(ask.id, name)
      dropNote.run(ask.id, name)
    }
    return this.get(ask.id)
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
    let draftReply
    let draftAt = 0
    for (const d of this.#db
      .prepare('SELECT field_name, value_json, updated_at FROM drafts WHERE ask_id = ?')
      .all(row.id)) {
      if (d.updated_at > draftAt) draftAt = d.updated_at
      // '__reply__' is a reserved row: the whole-ask free-text drafted alongside
      // the fields, so a half-written reply survives a reload too.
      if (d.field_name === '__reply__') draftReply = JSON.parse(d.value_json)
      else if (!(APPROVAL_PURPOSES.includes(row.purpose) && d.field_name === 'verdict')) draft[d.field_name] = JSON.parse(d.value_json)
    }
    const fieldContext = {}
    for (const n of this.#db
      .prepare('SELECT field_name, note FROM field_notes WHERE ask_id = ?')
      .all(row.id)) {
      fieldContext[n.field_name] = n.note
    }

    const ask = {
      id: row.id,
      ticket: row.ticket,
      kind: row.kind,
      purpose: row.purpose ?? 'blocker',
      project: row.project ?? undefined,
      status: row.status,
      gating: row.kind === 'park' && row.status === 'open',
      title: row.title,
      why: row.why,
      fields: JSON.parse(row.fields_json),
      steps: JSON.parse(row.steps_json),
      links: JSON.parse(row.links_json),
      tried: JSON.parse(row.tried_json),
      only_you: row.only_you ?? null,
      plan: row.plan_json ? JSON.parse(row.plan_json) : undefined,
      spend: row.spend_json ? JSON.parse(row.spend_json) : undefined,
      message: row.message_json ? JSON.parse(row.message_json) : undefined,
      consent_blocked_by: row.consent_blocked_by ?? undefined,
      permission: row.permission_json ? JSON.parse(row.permission_json) : undefined,
      summary: row.summary ?? undefined,
      minutes: row.minutes ?? undefined,
      after: row.after ?? undefined,
      blocks: JSON.parse(row.blocks_json),
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : undefined,
      revision: row.revision ?? 1,
      answered_via: this.#db.prepare('SELECT answered_via FROM answers WHERE ask_id = ? LIMIT 1').get(row.id)?.answered_via ?? undefined,
      origin: JSON.parse(row.origin_json),
      note: row.note ?? undefined,
      reply: row.reply ?? undefined,
      answers,
      answer_is_ref: refs,
      draft,
      draft_reply: draftReply,
      // Lets a client decide whether its own locally-kept copy is newer than
      // what the daemon has, instead of guessing.
      draft_updated_at: draftAt || undefined,
      field_context: fieldContext,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
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
  list({ profile = '*', status = ['open', 'answered', 'bounced'], agentKey: key, includeClosed = false, project } = {}) {
    const statuses = includeClosed ? null : status
    const rows = this.#db.prepare('SELECT * FROM asks ORDER BY created_at ASC').all()
    const asks = rows
      .map((r) => this.#hydrate(r))
      .filter((a) => (statuses ? statuses.includes(a.status) : true))
      .filter((a) => (key ? a.origin && agentKey(a.origin) === key : true))
      .filter((a) => (project ? a.project === project : true))
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
  /**
   * Upsert the human's per-field notes. An empty or non-string note is a
   * deliberate erase; an unknown field name is dropped. Callers scrub the
   * text before it gets here (it arrives outside validateAsk).
   */
  #saveFieldContext(askId, known, fieldContext, at) {
    if (!fieldContext || typeof fieldContext !== 'object') return
    const upsert = this.#db.prepare(
      `INSERT INTO field_notes (ask_id, field_name, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ask_id, field_name) DO UPDATE SET note       = excluded.note,
                                                     updated_at = excluded.updated_at`,
    )
    const remove = this.#db.prepare('DELETE FROM field_notes WHERE ask_id = ? AND field_name = ?')
    for (const [name, note] of Object.entries(fieldContext)) {
      if (!known.has(name)) continue
      if (typeof note !== 'string' || note.trim() === '') remove.run(askId, name)
      else upsert.run(askId, name, note, at)
    }
  }

  answer(idOrTicket, values, { refs = {}, reply, fieldContext, fieldBounce, revision, answeredVia, assertion } = {}) {
    // SQLite serializes the status/revision check and the write together.
    this.#db.exec('BEGIN IMMEDIATE')
    try { return this.#answerInTransaction(idOrTicket, values, { refs, reply, fieldContext, fieldBounce, revision, answeredVia, assertion }) }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  #answerInTransaction(idOrTicket, values, { refs, reply, fieldContext, fieldBounce, revision, answeredVia, assertion }) {
    const ask = this.get(idOrTicket)
    if (!ask) throw new Error(`no such ask: ${idOrTicket}`)
    if (APPROVAL_PURPOSES.includes(ask.purpose)) {
      const error = (code, message, status) => { const err = new Error(message); err.code = code; err.status = status; throw err }
      if (revision === undefined || revision !== ask.revision) error('STALE_REVISION', 'The agent changed this ask. Check it again.', 409)
      if (!answeredVia || answeredVia === 'local' || answeredVia === 'share-link:local') error('HUMAN_ONLY', 'answer this on the page', 403)
      if (fieldBounce && Object.keys(fieldBounce).length) error('WHOLE_ASK_ONLY', 'send the entire ask back', 400)
      if (values.verdict === null ||
          !ask.fields[0].choices.some((choice) => choice.value === values.verdict)) error('INVALID_VERDICT', 'choose a verdict', 400)
      if (ask.purpose === 'consent' && values.verdict === 'approve' && (
        (typeof values.note === 'string' && values.note.trim()) ||
        (typeof reply === 'string' && reply.trim()) ||
        (fieldContext && Object.values(fieldContext).some((note) => typeof note === 'string' && note.trim()))
      )) error('NOTE_MEANS_CHANGE', 'change the plan before approval', 400)
      if (values.edited_text != null && typeof values.edited_text !== 'string') error('INVALID_VERDICT', 'edited text must be text', 400)
      // The passkey gate: consent approve, message approve and permission
      // allow_once need a WebAuthn assertion verified by the caller (crypto
      // work happens outside this transaction; see src/passkey.js), whose
      // challenge is consumed HERE, atomically with the write it gates, so a
      // replayed or reused challenge can never ride in on a second answer.
      // This runs BEFORE the open-ask check below on purpose: a reused
      // challenge is a distinct, more specific failure than "already
      // answered" — replaying the exact request that just succeeded must
      // read PASSKEY_INVALID, not the generic ASK_NOT_OPEN a retry would
      // otherwise get once the first attempt already closed the ask.
      if (PASSKEY_VERDICTS[ask.purpose] && PASSKEY_VERDICTS[ask.purpose] === values.verdict) {
        if (!this.countCredentials()) error('PASSKEY_REQUIRED', 'enroll a passkey to approve', 403)
        if (!assertion) error('PASSKEY_REQUIRED', 'a passkey assertion is required to approve', 403)
        if (!this.#consumeChallenge(assertion.challengeId, { kind: 'approve', askId: ask.id, revision }))
          error('PASSKEY_INVALID', 'the passkey assertion is invalid, expired, or already used', 403)
        this.#db.prepare('UPDATE webauthn_credentials SET sign_count = ? WHERE id = ?').run(assertion.newSignCount, assertion.credentialId)
        answeredVia = `passkey:${assertion.credentialId.slice(-8)}`
      }
      if (ask.status !== 'open') error('ASK_NOT_OPEN', `ask ${ask.ticket} is ${ask.status}`, 409)
    }
    if (CLOSED_TO_ANSWERS.includes(ask.status)) throw finished(ask)

    const known = new Set(ask.fields.map((f) => f.name))
    const secretFields = new Set(ask.fields.filter((f) => f.type === 'secret').map((f) => f.name))

    // Per-field send-back: the human rejected THIS question rather than the
    // whole ask. It records as an answer-shaped sentinel {$bounce: note|true}
    // so the ask can complete with a mix of real answers, skips and bounces —
    // one question being wrong no longer holds the other eight hostage.
    //
    // A bounce does NOT have to mean "unanswered". "This is right, but let me
    // revise it before you use it" is the common case, so when a value was
    // typed it rides along as {$bounce, value} rather than being thrown away.
    // Secrets are the exception: a rejected secret is never kept.
    const bounce = {}
    if (fieldBounce && typeof fieldBounce === 'object' && !Array.isArray(fieldBounce)) {
      for (const [name, note] of Object.entries(fieldBounce)) {
        if (!known.has(name)) continue
        bounce[name] = typeof note === 'string' && note.trim() !== '' ? note : true
      }
    }

    // The invariant lives HERE, not in the transport, because there is more
    // than one transport. The daemon swaps a secret for a reference only when
    // the value is a non-empty string; a caller sending an array, a number or a
    // boolean slipped straight past that check and landed in this table as
    // plaintext, then read back into a model's context. Any script, phone
    // shortcut or CLI coercion could do it. So the store refuses outright: a
    // field declared `secret` is written only as a reference, whatever the
    // caller claims.
    for (const name of Object.keys(values)) {
      if (name in bounce) continue // a bounced field stores its sentinel, never its value
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
      if (!known.has(name) || name in bounce) continue
      stmt.run(ask.id, name, JSON.stringify(value), refs[name] ? 1 : 0, at)
    }
    for (const [name, note] of Object.entries(bounce)) {
      const supplied = values[name]
      const isEmpty =
        supplied === undefined ||
        supplied === null ||
        (typeof supplied === 'string' && supplied.trim() === '') ||
        (Array.isArray(supplied) && supplied.length === 0)
      const record =
        isEmpty || secretFields.has(name) ? { $bounce: note } : { $bounce: note, value: supplied }
      stmt.run(ask.id, name, JSON.stringify(record), 0, at)
    }
    this.#saveFieldContext(ask.id, known, fieldContext, at)
    if (reply !== undefined) {
      // Free text on every ask, always optional. This is where "yes but also
      // check X" goes — the part a typed field cannot hold.
      this.#db.prepare('UPDATE asks SET reply = ? WHERE id = ?').run(reply || null, ask.id)
    }
    if (answeredVia) this.#db.prepare('UPDATE answers SET answered_via = ? WHERE ask_id = ?').run(answeredVia, ask.id)
    this.#db.prepare('DELETE FROM drafts WHERE ask_id = ?').run(ask.id)

    const updated = this.get(ask.id)
    if (updated.missing.length === 0 && updated.status === 'open') {
      this.#db.prepare(`UPDATE asks SET status = 'answered', answered_at = ? WHERE id = ?`).run(at, ask.id)
      const result = { ask: this.get(ask.id), complete: true }; this.#db.exec('COMMIT'); return result
    }
    this.#db.exec('COMMIT'); return { ask: updated, complete: false }
  }

  payClaim(ticket) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const ask = this.get(ticket)
      if (!ask || ask.purpose !== 'spend' || !['answered', 'collected', 'orphaned'].includes(ask.status) || ask.answers.verdict !== 'approve' || ask.receipt?.spend_request_id) {
        const err = new Error('payment not allowed'); err.code = 'PAY_NOT_ALLOWED'; throw err
      }
      const key = ask.receipt?.pay_key ?? `unblock-${ask.ticket}-r${ask.revision}`
      const is_new = !ask.receipt?.pay_key
      if (is_new) this.#db.prepare('UPDATE asks SET receipt_json = ? WHERE id = ?').run(JSON.stringify({ pay_key: key, at: nowMs() }), ask.id)
      this.#db.exec('COMMIT')
      return { pay_key: key, is_new }
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  receipt(ticket, data) {
    const ask = this.get(ticket)
    const approved = ask && ['answered', 'collected', 'orphaned'].includes(ask.status) && ask.answers.verdict === 'approve'
    const spend = data.spend_request_id !== undefined || data.spend_status !== undefined
    if (!approved || (spend ? ask.purpose !== 'spend' || !ask.receipt?.pay_key || Boolean(ask.receipt?.spend_request_id) : ask.purpose !== 'consent')) {
      const err = new Error('receipt not allowed'); err.code = 'RECEIPT_NOT_ALLOWED'; throw err
    }
    const receipt = { ...ask.receipt, ...data, at: nowMs() }
    this.#db.prepare('UPDATE asks SET receipt_json = ? WHERE id = ?').run(JSON.stringify(receipt), ask.id)
    return this.get(ask.id)
  }

  saveDraft(idOrTicket, values, fieldContext, reply) {
    const ask = this.get(idOrTicket)
    if (!ask) throw new Error(`no such ask: ${idOrTicket}`)
    const known = new Set(ask.fields.map((f) => f.name))
    const at = nowMs()
    this.#saveFieldContext(ask.id, known, fieldContext, at)
    const stmt = this.#db.prepare(
      `INSERT INTO drafts (ask_id, field_name, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ask_id, field_name) DO UPDATE SET value_json = excluded.value_json,
                                                     updated_at = excluded.updated_at`,
    )
    for (const [name, value] of Object.entries(values)) {
      if (!known.has(name)) continue
      // A draft never holds a secret. Half-typed keys stay in the browser.
      const field = ask.fields.find((f) => f.name === name)
      if (field.type === 'secret' || (APPROVAL_PURPOSES.includes(ask.purpose) && name === 'verdict')) continue
      stmt.run(ask.id, name, JSON.stringify(value), at)
    }
    // The whole-ask reply drafts too, under a reserved name no field can use
    // (field names are validated snake_case). Empty string is the erase signal.
    if (typeof reply === 'string') {
      if (reply.trim() === '') {
        this.#db.prepare(`DELETE FROM drafts WHERE ask_id = ? AND field_name = '__reply__'`).run(ask.id)
      } else {
        stmt.run(ask.id, '__reply__', JSON.stringify(reply), at)
      }
    }
    return this.get(ask.id)
  }

  /**
   * Send it back unanswered.
   *
   * Answering was the only exit before this, so a badly-formed ask could only
   * be satisfied or ignored — and ignoring it leaves an agent parked forever.
   * A bounce is a real response: it carries the human's note, releases the
   * agent, and tells it to ask again properly.
   */
  bounce(idOrTicket, reply) {
    const ask = this.get(idOrTicket)
    if (!ask) throw new Error(`no such ask: ${idOrTicket}`)
    if (ask.status !== 'open') throw finished(ask)
    const at = nowMs()
    this.#db
      .prepare(`UPDATE asks SET status = 'bounced', answered_at = ?, reply = ? WHERE id = ?`)
      .run(at, reply || null, ask.id)
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
    return this.list({ agentKey: agentKey(origin), status: ['answered', 'bounced'] })
  }

  /**
   * This agent's asks that are still open. Half-filled drafts live on these,
   * which is what lets an agent react while the human is still typing instead
   * of only after they submit.
   */
  openForAgent(origin) {
    return this.list({ profile: '*', agentKey: agentKey(origin), status: ['open'] })
  }

  /**
   * Withdraw an ask the agent no longer needs. Only an OPEN ask can be
   * cancelled: once a human has answered, bounced, or the answer sits
   * orphaned, the record holds their work, and an agent superseding its own
   * stale question must not be able to erase it. Collect it instead.
   */
  cancel(idOrTicket, note) {
    const ask = this.get(idOrTicket)
    if (!ask) return null
    if (ask.status !== 'open') {
      const err = new Error(
        `ask ${ask.ticket} is ${ask.status}, not open; a human response is never cancelled — collect it`,
      )
      err.code = 'ASK_NOT_OPEN'
      err.askStatus = ask.status
      throw err
    }
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

  /**
   * Expire anything past its TTL, and orphan answers nobody ever collected.
   *
   * The second half exists because a human answered an ask, the agent that
   * parked on it had already died, and the answer then sat in `answered`
   * forever with nothing alive to receive it. Marking it orphaned keeps the
   * answer claimable by ticket and stops the queue quietly lying about what is
   * still in flight.
   */
  sweep({ orphanAfterMs = 10 * 60 * 1000 } = {}) {
    const at = nowMs()
    // ONLY parked asks can be orphaned. A park means an agent is definitionally
    // sitting in a tool call waiting, so uncollected-for-ten-minutes really does
    // mean it died. A FILED ask has no waiting agent — it is collected whenever
    // that agent next checks in, which may be hours later or never. Sweeping
    // those marked real, answered decisions as abandoned.
    const stranded = this.#db
      .prepare(
        `SELECT id FROM asks
          WHERE status = 'answered' AND kind = 'park'
            AND answered_at IS NOT NULL AND answered_at < ?`,
      )
      .all(at - orphanAfterMs)
    for (const { id } of stranded) {
      this.#db
        .prepare(`UPDATE asks SET status = 'orphaned', note = ? WHERE id = ?`)
        .run('answered, but the agent that asked never collected it', id)
    }
    const stale = this.#db
      .prepare(`SELECT id FROM asks WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`)
      .all(at)
    for (const { id } of stale) {
      this.#db.prepare(`UPDATE asks SET status = 'expired', closed_at = ? WHERE id = ?`).run(at, id)
    }
    this.#db.prepare('DELETE FROM links WHERE expires_at < ?').run(at)
    // Prune long-closed rows so the queue file cannot grow without bound.
    // Everything closed keeps a 30-day window for `unblock_check` stragglers
    // and post-mortems; after that it is noise the hydrate loop pays for.
    const cutoff = at - 30 * 24 * 60 * 60 * 1000
    this.#db
      .prepare(
        `DELETE FROM asks
          WHERE status IN ('collected', 'cancelled', 'expired', 'orphaned')
            AND COALESCE(closed_at, collected_at, answered_at, created_at) < ?`,
      )
      .run(cutoff)
    return [...stale, ...stranded].map(({ id }) => this.get(id))
  }

  // --------------------------------------------------------------- links

  /**
   * An ephemeral URL token. Dies on use for a single ask, or on expiry for the
   * whole-queue link. Stolen from one-time-secret services: a stale tab in a
   * pocket should not still be live tomorrow.
   */
  mintLink({ askId = null, scope = 'queue', ttlSeconds = 900, mintedBy = 'local' } = {}) {
    // Clamp, because an unvalidated TTL from a request body minted links that
    // expire in the year 33715. A link is a capability; it must always die.
    const ttl = Math.min(Math.max(Math.round(Number(ttlSeconds) || 900), 30), 60 * 60 * 24)
    const token = randomBytes(24).toString('base64url')
    const at = nowMs()
    this.#db
      .prepare('INSERT INTO links (token, ask_id, scope, created_at, expires_at, minted_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, askId, scope, at, at + ttl * 1000, mintedBy)
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

  // ------------------------------------------------------------ webauthn

  /**
   * Mint a single-use challenge. `challenge` is 32 random bytes (a Buffer);
   * the caller base64url-encodes it for the client. `askId`/`revision` bind
   * an `approve` challenge to the exact answer it may gate.
   */
  saveChallenge({ kind, challenge, askId = null, revision = null, ttlMs = 120_000, authorized = false }) {
    const id = randomUUID()
    const at = nowMs()
    this.#db
      .prepare(
        `INSERT INTO webauthn_challenges (id, challenge, kind, ask_id, revision, created_at, expires_at, authorized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, challenge, kind, askId, revision, at, at + ttlMs, authorized ? 1 : 0)
    return id
  }

  getChallenge(id) {
    if (!id) return null
    const row = this.#db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(id)
    if (!row) return null
    return { ...row, challenge: Buffer.from(row.challenge) }
  }

  /**
   * Unused, unexpired, the right kind, and — for `approve` — bound to the
   * exact ask and revision it was minted for. The UPDATE's own WHERE clause
   * is the compare-and-swap: two callers racing to consume the same
   * challenge can never both succeed, even outside an explicit transaction.
   */
  #consumeChallenge(id, { kind, askId = null, revision = null }) {
    if (!id) return false
    const row = this.#db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(id)
    if (!row || row.kind !== kind || row.used_at != null || row.expires_at < nowMs()) return false
    if (kind === 'approve' && (row.ask_id !== askId || row.revision !== revision)) return false
    const result = this.#db.prepare('UPDATE webauthn_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(nowMs(), id)
    return result.changes === 1
  }

  /** Public entry point for `register` and `enroll_auth` challenges, which are consumed outside an `answer()` transaction. */
  consumeChallenge(id, opts) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const ok = this.#consumeChallenge(id, opts)
      this.#db.exec('COMMIT')
      return ok
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  countCredentials() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get().n
  }

  listCredentials() {
    return this.#db
      .prepare('SELECT id, public_key_jwk, alg, sign_count, label, created_at, created_via, user_agent FROM webauthn_credentials ORDER BY created_at ASC')
      .all()
      .map((row) => this.#hydrateCredential(row))
  }

  getCredential(id) {
    const row = this.#db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(id)
    return row ? this.#hydrateCredential(row) : null
  }

  #hydrateCredential(row) {
    return {
      id: row.id,
      publicKeyJwk: JSON.parse(row.public_key_jwk),
      alg: row.alg,
      signCount: row.sign_count,
      label: row.label ?? null,
      createdAt: row.created_at,
      createdVia: row.created_via ?? null,
      userAgent: row.user_agent ?? null,
    }
  }

  /** A sixth credential is refused (409 `PASSKEY_CAP`) by the caller before this ever runs; this is the floor. */
  addCredential({ id, publicKeyJwk, alg, signCount, label, createdVia, userAgent }) {
    if (this.countCredentials() >= PASSKEY_CREDENTIAL_CAP) {
      const err = new Error(`at most ${PASSKEY_CREDENTIAL_CAP} passkeys`)
      err.code = 'PASSKEY_CAP'
      err.status = 409
      throw err
    }
    this.#db
      .prepare(
        `INSERT INTO webauthn_credentials (id, public_key_jwk, alg, sign_count, label, created_at, created_via, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, JSON.stringify(publicKeyJwk), alg, signCount, label ?? null, nowMs(), createdVia ?? null, userAgent ?? null)
  }

  updateCredentialSignCount(id, signCount) {
    this.#db.prepare('UPDATE webauthn_credentials SET sign_count = ? WHERE id = ?').run(signCount, id)
  }

  removeCredential(id) {
    this.#db.prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id)
  }

  addPasskeyEvent({ kind, credentialId, label, via }) {
    const id = randomUUID()
    const at = nowMs()
    this.#db
      .prepare('INSERT INTO passkey_events (id, kind, credential_id, label, at, via) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, credentialId, label ?? null, at, via ?? null)
    return { id, kind, credential_id: credentialId, label: label ?? null, at, via: via ?? null }
  }

  /** Enrolment events nobody has dismissed yet — the "not you? remove it" banner. */
  listBannerEvents() {
    return this.#db
      .prepare(`SELECT id AS event_id, label, at FROM passkey_events WHERE kind = 'enrolled' AND dismissed_at IS NULL ORDER BY at ASC`)
      .all()
  }

  dismissBannerEvent(id) {
    this.#db.prepare('UPDATE passkey_events SET dismissed_at = ? WHERE id = ?').run(nowMs(), id)
  }
}

export { agentKey }
