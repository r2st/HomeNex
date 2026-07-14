// Startup environment validation. Pure function so it can be unit-tested; the
// process-exit wiring lives in index.js. In production a missing DATABASE_URL or
// SESSION_SECRET is fatal (the server would otherwise fall back to a dev DB or a
// session secret that changes on every restart, silently logging everyone out).
// Missing WhatsApp / AI / signature secret only downgrade features, so they warn.

// The connection string db.js falls back to when DATABASE_URL is unset — treated as
// "not really configured" in production.
const DEV_DB_FALLBACK = 'postgres://homenex:homenex@localhost:5432/homenex'

export function validateEnv(env = process.env) {
  const errors = []
  const warnings = []
  const isProd = env.NODE_ENV === 'production'

  if (isProd) {
    if (!env.DATABASE_URL || env.DATABASE_URL === DEV_DB_FALLBACK) {
      errors.push('DATABASE_URL must be set in production (refusing the local dev fallback).')
    }
    if (!env.SESSION_SECRET) {
      errors.push(
        'SESSION_SECRET must be set in production so sessions survive restarts and can\'t be forged.',
      )
    } else if (env.SESSION_SECRET.length < 16) {
      errors.push('SESSION_SECRET is too short — use at least 16 characters of random hex.')
    }
    if (!env.PUBLIC_BASE_URL) {
      warnings.push('PUBLIC_BASE_URL is not set — shared media links will be relative and may not open from WhatsApp.')
    }
  }

  // Feature-level: present anywhere, these only warn (the dashboard still works).
  const hasWhatsApp = env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
  if (!hasWhatsApp) warnings.push('WhatsApp credentials missing — the dashboard works but messages can\'t be sent.')
  if (!env.OPENROUTER_API_KEY) warnings.push('OPENROUTER_API_KEY missing — AI replies and lead extraction are disabled.')
  if (!env.WHATSAPP_APP_SECRET) warnings.push('WHATSAPP_APP_SECRET missing — inbound webhook signatures are not verified.')

  // A pool size that isn't a positive integer would make pg throw at connect time.
  if (env.PG_POOL_SIZE !== undefined && !(Number(env.PG_POOL_SIZE) > 0)) {
    errors.push('PG_POOL_SIZE must be a positive number.')
  }

  return { ok: errors.length === 0, errors, warnings }
}
