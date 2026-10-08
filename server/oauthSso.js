/**
 * OAuth SSO login: Google, GitHub, Microsoft.
 *
 * Uses native fetch (Node 24) — no extra dependencies. The OAuth state is a
 * signed HMAC so no server-side session storage is needed.
 */
import crypto from 'node:crypto'
import { createAgent, findAgentByEmail, getAgent } from './db.js'
import { issueToken } from './auth.js'

const {
  SSO_GOOGLE_CLIENT_ID,
  SSO_GOOGLE_CLIENT_SECRET,
  SSO_GITHUB_CLIENT_ID,
  SSO_GITHUB_CLIENT_SECRET,
  SSO_MICROSOFT_CLIENT_ID,
  SSO_MICROSOFT_CLIENT_SECRET,
  PUBLIC_BASE_URL = 'http://localhost:5173',
  SESSION_SECRET = 'dev-secret',
} = process.env

const API_BASE = process.env.API_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3001'

function signState(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, ts: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyState(state) {
  if (!state) return null
  const [payload, sig] = state.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch { return null }
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
  if (Date.now() - data.ts > 600_000) return null // 10 min expiry
  return data
}

async function findOrCreateOAuthAgent(provider, oauthId, email, name) {
  // Try to find by email first
  let agent = email ? await findAgentByEmail(email) : null
  if (agent) {
    if (agent.is_active !== 1) return null
    return agent
  }
  // Create new agent with empty password (OAuth-only)
  const { agent: newAgent } = await createAgent(
    name || email.split('@')[0],
    '', // no phone for OAuth accounts
    email,
    '', // empty password hash for OAuth-only accounts
  )
  return newAgent || await findAgentByEmail(email)
}

function redirectWithToken(res, agent) {
  if (!agent) return res.redirect(`${PUBLIC_BASE_URL}/?error=account_deactivated`)
  issueToken(agent.id, agent.token_version).then(token => {
    res.redirect(`${PUBLIC_BASE_URL}/?sso_token=${encodeURIComponent(token)}`)
  }).catch(() => {
    res.redirect(`${PUBLIC_BASE_URL}/?error=token_failed`)
  })
}

export function mountSsoRoutes(app) {
  // ── Google ──────────────────────────────────────────
  if (SSO_GOOGLE_CLIENT_ID) {
    app.get('/api/auth/sso/google', (_req, res) => {
      const state = signState({ provider: 'google' })
      const params = new URLSearchParams({
        client_id: SSO_GOOGLE_CLIENT_ID,
        redirect_uri: `${API_BASE}/api/auth/sso/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      })
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
    })

    app.get('/api/auth/sso/google/callback', async (req, res) => {
      try {
        const { code, state } = req.query
        if (!verifyState(state)) return res.redirect(`${PUBLIC_BASE_URL}/?error=invalid_state`)
        if (!code) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_code`)

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: SSO_GOOGLE_CLIENT_ID,
            client_secret: SSO_GOOGLE_CLIENT_SECRET,
            redirect_uri: `${API_BASE}/api/auth/sso/google/callback`,
            grant_type: 'authorization_code',
          }),
        })
        const tokens = await tokenRes.json()
        if (!tokens.access_token) return res.redirect(`${PUBLIC_BASE_URL}/?error=google_auth_failed`)

        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        const profile = await userRes.json()
        if (!profile.email) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_email`)

        const agent = await findOrCreateOAuthAgent('google', profile.id, profile.email, profile.name)
        redirectWithToken(res, agent)
      } catch (err) {
        console.error('Google SSO callback error:', err)
        res.redirect(`${PUBLIC_BASE_URL}/?error=google_auth_failed`)
      }
    })
  }

  // ── GitHub ──────────────────────────────────────────
  if (SSO_GITHUB_CLIENT_ID) {
    app.get('/api/auth/sso/github', (_req, res) => {
      const state = signState({ provider: 'github' })
      const params = new URLSearchParams({
        client_id: SSO_GITHUB_CLIENT_ID,
        redirect_uri: `${API_BASE}/api/auth/sso/github/callback`,
        scope: 'user:email',
        state,
      })
      res.redirect(`https://github.com/login/oauth/authorize?${params}`)
    })

    app.get('/api/auth/sso/github/callback', async (req, res) => {
      try {
        const { code, state } = req.query
        if (!verifyState(state)) return res.redirect(`${PUBLIC_BASE_URL}/?error=invalid_state`)
        if (!code) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_code`)

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: SSO_GITHUB_CLIENT_ID,
            client_secret: SSO_GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${API_BASE}/api/auth/sso/github/callback`,
          }),
        })
        const tokens = await tokenRes.json()
        if (!tokens.access_token) return res.redirect(`${PUBLIC_BASE_URL}/?error=github_auth_failed`)

        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'DoAide-Realty' },
        })
        const profile = await userRes.json()

        let email = profile.email
        if (!email) {
          const emailsRes = await fetch('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'DoAide-Realty' },
          })
          const emails = await emailsRes.json()
          const primary = emails.find(e => e.primary && e.verified)
          email = primary?.email
        }
        if (!email) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_email`)

        const agent = await findOrCreateOAuthAgent('github', String(profile.id), email, profile.name || profile.login)
        redirectWithToken(res, agent)
      } catch (err) {
        console.error('GitHub SSO callback error:', err)
        res.redirect(`${PUBLIC_BASE_URL}/?error=github_auth_failed`)
      }
    })
  }

  // ── Microsoft ───────────────────────────────────────
  if (SSO_MICROSOFT_CLIENT_ID) {
    app.get('/api/auth/sso/microsoft', (_req, res) => {
      const state = signState({ provider: 'microsoft' })
      const params = new URLSearchParams({
        client_id: SSO_MICROSOFT_CLIENT_ID,
        redirect_uri: `${API_BASE}/api/auth/sso/microsoft/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        response_mode: 'query',
      })
      res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`)
    })

    app.get('/api/auth/sso/microsoft/callback', async (req, res) => {
      try {
        const { code, state } = req.query
        if (!verifyState(state)) return res.redirect(`${PUBLIC_BASE_URL}/?error=invalid_state`)
        if (!code) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_code`)

        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: SSO_MICROSOFT_CLIENT_ID,
            client_secret: SSO_MICROSOFT_CLIENT_SECRET,
            redirect_uri: `${API_BASE}/api/auth/sso/microsoft/callback`,
            grant_type: 'authorization_code',
          }),
        })
        const tokens = await tokenRes.json()
        if (!tokens.access_token) return res.redirect(`${PUBLIC_BASE_URL}/?error=microsoft_auth_failed`)

        const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        const profile = await userRes.json()
        const email = profile.mail || profile.userPrincipalName
        if (!email) return res.redirect(`${PUBLIC_BASE_URL}/?error=no_email`)

        const agent = await findOrCreateOAuthAgent('microsoft', profile.id, email, profile.displayName)
        redirectWithToken(res, agent)
      } catch (err) {
        console.error('Microsoft SSO callback error:', err)
        res.redirect(`${PUBLIC_BASE_URL}/?error=microsoft_auth_failed`)
      }
    })
  }
}
