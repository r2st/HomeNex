import { useState } from 'react'
import { api } from '../api.js'
import { Sheet, Chip, Field, inputCls } from './ui.jsx'

// One-tap tags for the 10-second walk-in / phone capture (§4.4). These land on the
// lead as contact labels so the pipeline is instantly filterable.
const QUICK_TAGS = ['Hot', 'Buyer', 'Seller', 'Rental', 'Investor', '2 BHK', '3 BHK', 'Site visit']

// The 10-second "Add lead" form for walk-ins and phone enquiries. On save it creates the
// lead + contact and immediately opens a WhatsApp thread with the buyer via a wa.me link.
export default function QuickAddLead({ onClose, onAdded }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [channel, setChannel] = useState('walk_in')
  const [tags, setTags] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const toggleTag = (t) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  const save = async ({ openThread }) => {
    if (!phone.trim()) return setError('Enter the buyer’s phone number')
    setSaving(true)
    setError(null)
    try {
      const res = await api.quickAddLead({ phone: phone.trim(), name: name.trim() || null, channel, tags })
      // Opening the thread must happen synchronously in this click for the popup to survive.
      if (openThread && res.wa_deeplink) window.open(res.wa_deeplink, '_blank', 'noopener')
      onAdded?.(res.lead)
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <Sheet onClose={onClose} title="Add lead">
      <div className="space-y-3.5">
        <div className="flex gap-2">
          <Chip active={channel === 'walk_in'} onClick={() => setChannel('walk_in')}>🚶 Walk-in</Chip>
          <Chip active={channel === 'phone'} onClick={() => setChannel('phone')}>📞 Phone</Chip>
        </div>

        <Field label="Phone number">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="98765 43210"
            inputMode="tel"
            autoFocus
            className={inputCls}
          />
        </Field>

        <Field label="Name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Buyer name" className={inputCls} />
        </Field>

        <div>
          <span className="block text-[11.5px] font-bold text-ink-soft mb-1.5">Quick tags</span>
          <div className="flex gap-1.5 flex-wrap">
            {QUICK_TAGS.map((t) => (
              <Chip key={t} active={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</Chip>
            ))}
          </div>
        </div>

        {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => save({ openThread: false })}
            disabled={saving}
            className="flex-1 bg-card border border-line text-ink font-bold text-[13.5px] rounded-xl py-3 active:scale-[0.99] transition disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => save({ openThread: true })}
            disabled={saving}
            className="flex-[1.4] bg-brand text-white font-bold text-[13.5px] rounded-xl py-3 active:scale-[0.99] transition disabled:opacity-50"
          >
            {saving ? 'Saving…' : '💬 Save & open WhatsApp'}
          </button>
        </div>
      </div>
    </Sheet>
  )
}
