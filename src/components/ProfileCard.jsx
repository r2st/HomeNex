import { useRef, useState } from 'react'
import { api } from '../api.js'
import { inputCls, Field } from './ui.jsx'

// Downscale whatever the agent picked to a square avatar the server will accept
// (it caps the stored data URI). Done in the browser so a 5 MB camera photo never
// travels over a patchy 4G connection.
const AVATAR_PX = 256
function toAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const side = Math.min(img.width, img.height) // centre-crop to a square
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = AVATAR_PX
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file isn't an image we can read"))
    }
    img.src = url
  })
}

const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

function AvatarPicker({ value, name, onPick, onClear, disabled }) {
  const fileRef = useRef(null)
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={disabled}
        className="relative w-16 h-16 rounded-full overflow-hidden bg-brand-wash text-brand-deep font-display font-bold text-[19px] flex items-center justify-center shrink-0 active:scale-95 transition disabled:opacity-50"
        aria-label="Change profile photo"
      >
        {value ? (
          <img src={value} alt="" className="w-full h-full object-cover" />
        ) : (
          initials(name)
        )}
      </button>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          className="text-[12.5px] font-bold text-brand hover:text-brand-deep disabled:opacity-50"
        >
          {value ? 'Change photo' : 'Add photo'}
        </button>
        {value && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="ml-3 text-[12.5px] font-bold text-ink-faint hover:text-hot disabled:opacity-50"
          >
            Remove
          </button>
        )}
        <p className="text-[11px] text-ink-faint mt-0.5">JPG, PNG or WebP</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // let the agent re-pick the same file after an error
          if (file) onPick(file)
        }}
      />
    </div>
  )
}

// The agent's own profile. The WhatsApp (login) number is not here — it lives in
// SecurityCard, behind a password check.
export default function ProfileCard({ agent, onSaved }) {
  const [form, setForm] = useState({
    name: agent?.name || '',
    email: agent?.email || '',
    business_name: agent?.business_name || '',
    city: agent?.city || '',
    rera_id: agent?.rera_id || '',
    bio: agent?.bio || '',
  })
  const [avatar, setAvatar] = useState(agent?.avatar_url || null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const field = (key) => ({
    value: form[key],
    onChange: (e) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      setMsg(null)
    },
  })

  const pickAvatar = async (file) => {
    setError(null)
    setMsg(null)
    try {
      setAvatar(await toAvatarDataUrl(file))
    } catch (err) {
      setError(err.message)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const updated = await api.updateProfile({ ...form, avatar_url: avatar })
      onSaved(updated)
      setMsg('Profile saved')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-line rounded-2xl p-4 space-y-3.5">
      <h3 className="text-[13px] font-bold text-ink-soft">Profile</h3>

      <AvatarPicker
        value={avatar}
        name={form.name}
        onPick={pickAvatar}
        onClear={() => setAvatar(null)}
        disabled={busy}
      />

      <Field label="Full name">
        <input type="text" autoComplete="name" maxLength={80} className={inputCls} {...field('name')} />
      </Field>

      <Field label="Email">
        <input
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className={inputCls}
          {...field('email')}
        />
      </Field>

      <Field label="Business name">
        <input
          type="text"
          maxLength={120}
          placeholder="e.g. Sharma Realty"
          className={inputCls}
          {...field('business_name')}
        />
      </Field>

      <Field label="City">
        <input type="text" maxLength={80} placeholder="e.g. Pune" className={inputCls} {...field('city')} />
      </Field>

      <Field label="RERA registration ID">
        <input
          type="text"
          maxLength={64}
          placeholder="e.g. A52100012345"
          className={`${inputCls} tracking-wide`}
          {...field('rera_id')}
        />
      </Field>

      <Field label="About you">
        <textarea
          rows={3}
          maxLength={500}
          placeholder="Shown on the property pages you share with buyers."
          className={`${inputCls} resize-none`}
          {...field('bio')}
        />
        <span className="block text-[10.5px] text-ink-faint mt-1 text-right tabular-nums">
          {form.bio.length}/500
        </span>
      </Field>

      {error && <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-3 py-2">{error}</p>}
      {msg && <p className="text-[12.5px] text-green-700 bg-green-50 rounded-xl px-3 py-2">{msg}</p>}

      <button
        type="submit"
        disabled={busy || !form.name.trim()}
        className="w-full bg-brand hover:bg-brand-deep disabled:opacity-50 text-white font-bold text-[13px] rounded-2xl py-3 active:scale-[0.98] transition"
      >
        {busy ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  )
}
