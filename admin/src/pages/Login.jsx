import { useState } from 'react'
import { api, setToken } from '../api.js'

export default function Login({ onLogin }) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = identifier.trim()
      const body = id.includes('@') ? { email: id, password } : { phone: id, password }
      const { token, agent } = await api.login(body)
      if (agent.is_admin !== 1) {
        setError('This account does not have admin access.')
        return
      }
      setToken(token)
      onLogin(agent)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>HomeNex Admin</h1>
        <p className="sub">Internal staff sign-in</p>
        <label className="field">
          <span>Phone or email</span>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="+919812345678 or you@homenex.in"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
