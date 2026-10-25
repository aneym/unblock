import { useState, type FormEvent } from 'react'
import { ApiError, login, type SessionInfo } from './lib/api'

/**
 * The full login wall: the queue page renders nothing until a session exists.
 * No capability link, no Tailscale — the local passphrase is the proof that a
 * person, not the agent holding the daemon bearer, is at the keyboard.
 */
export function LoginWall({ session, onLogin }: { session: SessionInfo; onLogin: (next: SessionInfo) => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !passphrase) return
    setBusy(true)
    setError('')
    login(passphrase)
      .then((info) => { setPassphrase(''); onLogin(info) })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'Cannot reach the daemon.')
      })
      .finally(() => setBusy(false))
  }

  if (!session.configured) {
    return (
      <main className="login-wall">
        <section className="login-card" aria-label="Set up local sign-in">
          <span className="wordmark">unblock</span>
          <h1>Set up local sign-in</h1>
          <p>No passphrase is configured on this machine yet. In a terminal, run:</p>
          <pre className="login-command">unblock auth setup</pre>
          <p>
            The passphrase stays here, hashed — never in a URL. Tailscale and
            share links are optional extras, not how you get in.
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="login-wall">
      <form className="login-card" aria-label="Sign in" onSubmit={submit}>
        <span className="wordmark">unblock</span>
        <h1>Sign in</h1>
        <label htmlFor="passphrase">Passphrase</label>
        <input
          id="passphrase" type="password" autoFocus autoComplete="current-password"
          value={passphrase} onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Your local passphrase"
        />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy || !passphrase}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}