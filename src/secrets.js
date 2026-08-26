/**
 * Secret delivery.
 *
 * The rule: a secret typed into the answer form must never travel back through
 * the channel that lands in a model's context. So nothing here ever returns a
 * value to a caller — `put()` returns a REFERENCE, and the agent's shell
 * resolves it at the last moment.
 *
 * Backends, best first:
 *   op       1Password. The reference (op://vault/item/field) is inherently
 *            safe to hand a model, and `op run` masks the value if a
 *            subprocess prints it. The only option with that protection.
 *   keychain macOS login keychain. Safe at rest; leaks if the agent captures
 *            the retrieval command's stdout instead of piping it.
 *   env      A 0600 file the agent's shell sources. Always works, weakest.
 */

import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR =
  process.env.UNBLOCK_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'unblock')

const ENV_FILE = join(CONFIG_DIR, 'secrets.env')
const KEYCHAIN_ACCOUNT = 'unblock'

/** Run a command, optionally feeding stdin. Never logs argv or stdin. */
function run(cmd, args, { input, timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (cause) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(cause?.message ?? cause) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function opAvailable() {
  const which = await run('sh', ['-c', 'command -v op'])
  if (!which.ok) return false
  // Installed is not enough — it has to be signed in, or every put() hangs.
  const who = await run('op', ['whoami', '--format=json'], { timeout: 8000 })
  return who.ok
}

function keychainAvailable() {
  return process.platform === 'darwin'
}

export class SecretStore {
  #backend
  #vault

  constructor({ backend = 'auto', vault = process.env.UNBLOCK_OP_VAULT || 'Private' } = {}) {
    this.#backend = backend
    this.#vault = vault
  }

  /** Resolve `auto` once, at first use. */
  async backend() {
    if (this.#backend !== 'auto') return this.#backend
    if (await opAvailable()) this.#backend = 'op'
    else if (keychainAvailable()) this.#backend = 'keychain'
    else this.#backend = 'env'
    return this.#backend
  }

  /**
   * Store a secret and return only what is safe to show an agent.
   * @returns {{store: string, ref: string, resolve: string, env_name?: string}}
   *   ref     an opaque handle (op:// URI, keychain service, or $VAR)
   *   resolve a shell fragment that yields the value, for the agent to pipe
   */
  async put({ name, value, ticket, envName }) {
    if (typeof value !== 'string' || value === '') throw new Error('empty secret')
    const backend = await this.backend()
    const slug = `${ticket}-${name}`.replace(/[^A-Za-z0-9._-]/g, '-')
    const env_name = envName || `UNBLOCK_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

    if (backend === 'op') {
      const template = JSON.stringify({
        title: `unblock ${slug}`,
        category: 'API_CREDENTIAL',
        fields: [
          { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value },
        ],
      })
      const res = await run(
        'op',
        ['item', 'create', '--vault', this.#vault, '--format=json', '--template=-'],
        { input: template },
      )
      if (res.ok) {
        let itemId
        try {
          itemId = JSON.parse(res.stdout).id
        } catch {
          itemId = null
        }
        if (itemId) {
          const ref = `op://${this.#vault}/${itemId}/credential`
          return {
            store: 'op',
            ref,
            env_name,
            resolve: `op read ${JSON.stringify(ref)}`,
            hint: `Prefer: op run --env ${env_name}=${ref} -- <your command>  (masks the value if it is printed)`,
          }
        }
      }
      // Signed out mid-flight, wrong vault, whatever. Degrade rather than lose the answer.
    }

    if (backend === 'op' || backend === 'keychain') {
      if (keychainAvailable()) {
        // `security add-generic-password -w` with no argument prompts on the
        // TTY, and with no TTY it silently stores an EMPTY password — verified
        // the hard way. Passing -w <value> would put the secret in argv, where
        // any `ps` can read it. Interactive mode is the way out: security is
        // invoked as `security -i` and the whole command arrives on stdin, so
        // the value is in a pipe and never on a command line.
        //
        // The value is base64 before it is interpolated, and that is load
        // bearing rather than tidy. security's interactive parser is LINE
        // ORIENTED: a newline inside the value ends the command and the rest of
        // it runs as the NEXT security subcommand — delete-keychain among them.
        // Escaping quotes and backslashes did not close that, because a newline
        // is neither. Base64's alphabet contains no quote, no backslash and no
        // newline, so there is nothing left to break out with.
        const encoded = Buffer.from(value, 'utf8').toString('base64')
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
          throw new Error('refusing to store a secret that did not encode cleanly')
        }
        const res = await run('security', ['-i'], {
          input: `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${slug} -w "${encoded}"\n`,
        })
        // A write that reports success but stored a truncated or empty value is
        // worse than a failure, so prove the round trip before handing back a
        // reference the agent will rely on.
        if (res.ok && (await this.#keychainRoundTrips(slug, value))) {
          const resolve = `security find-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${slug} -w | base64 -d`
          return {
            store: 'keychain',
            ref: slug,
            env_name,
            resolve,
            hint: `Pipe it, do not capture it: ${resolve} | <your command>`,
          }
        }
      }
    }

    // env file, the universal fallback.
    //
    // Base64 here too, for a different reason: the file is line oriented, so a
    // PEM key or a JSON service account — exactly the payloads this tool exists
    // to move — used to be silently truncated to their first line while
    // reporting success. One line per secret, always.
    mkdirSync(dirname(ENV_FILE), { recursive: true })
    const encoded = Buffer.from(value, 'utf8').toString('base64')
    const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
    const lines = existing
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith(`${env_name}_B64=`) && !l.startsWith(`${env_name}=`))
    lines.push(`${env_name}_B64=${encoded}`)
    writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 })
    chmodSync(ENV_FILE, 0o600)

    // Resolve ONE variable rather than sourcing the whole file. Sourcing loads
    // every secret ever stored into the agent's environment, so a reference for
    // one ask would leak the secrets of every other.
    const resolve = `${env_name}=$(grep '^${env_name}_B64=' ${ENV_FILE} | cut -d= -f2- | base64 -d)`
    return {
      store: 'env',
      ref: `$${env_name}`,
      env_name,
      resolve,
      hint: `Load just this one: export ${resolve}  — then use $${env_name}. Never echo it, and never source the whole file.`,
    }
  }

  /** Prove the value survived the round trip before handing out a reference. */
  async #keychainRoundTrips(slug, expected) {
    const res = await run('security', [
      'find-generic-password',
      '-a',
      KEYCHAIN_ACCOUNT,
      '-s',
      slug,
      '-w',
    ])
    if (!res.ok) return false
    const stored = res.stdout.replace(/\n$/, '')
    if (stored === '') return false
    try {
      return Buffer.from(stored, 'base64').toString('utf8') === expected
    } catch {
      return false
    }
  }

  /**
   * Resolve a reference back to a value. Deliberately NOT exposed over the
   * HTTP API or any MCP tool — only the CLI, so the value can be piped into a
   * command without passing through a model.
   */
  async reveal(record) {
    if (!record?.store) throw new Error('not a secret reference')
    if (record.store === 'op') {
      const res = await run('op', ['read', record.ref])
      if (!res.ok) throw new Error('op read failed')
      return res.stdout.replace(/\n$/, '')
    }
    if (record.store === 'keychain') {
      const res = await run('security', [
        'find-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        record.ref,
        '-w',
      ])
      if (!res.ok) throw new Error('keychain read failed')
      return Buffer.from(res.stdout.replace(/\n$/, ''), 'base64').toString('utf8')
    }
    if (record.store === 'env') {
      const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
      const key = `${record.env_name}_B64=`
      const line = text.split('\n').find((l) => l.startsWith(key))
      if (!line) throw new Error('env entry missing')
      return Buffer.from(line.slice(key.length).trim(), 'base64').toString('utf8')
    }
    throw new Error(`unknown store: ${record.store}`)
  }
}

export { ENV_FILE, CONFIG_DIR }
