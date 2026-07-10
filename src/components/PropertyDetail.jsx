import { useEffect, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseToDisplay, lakhsToPaise, paiseToLakhs } from '../money.js'
import { SlideOver, Sheet, Chip, Field, inputCls } from './ui.jsx'

const STATUS_STYLE = {
  available: 'bg-brand-wash text-brand-deep border-brand/30',
  token: 'bg-amber-wash text-gold border-amber/40',
  sold: 'bg-cream text-ink-faint border-line',
  rented: 'bg-cream text-ink-faint border-line',
}

export const STATUS_LABEL = { available: 'Available', token: 'Token', sold: 'Sold', rented: 'Rented' }

// Create/edit form, shared by PropertiesTab (add) and PropertyDetail (edit).
export function PropertyForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState(() => ({
    title: initial?.title || '',
    property_type: initial?.property_type || '',
    bhk: initial?.bhk || '',
    size_sqft: initial?.size_sqft ?? '',
    price_l: paiseToLakhs(initial?.price_paise) ?? '',
    locality: initial?.locality || '',
    city: initial?.city || '',
    status: initial?.status || 'available',
    rera_project_number: initial?.rera_project_number || '',
    builder_name: initial?.builder_name || '',
    owner_name: initial?.owner_name || '',
    photos: (initial?.photos || []).join('\n'),
    brochure_url: initial?.brochure_url || '',
    notes: initial?.notes || '',
  }))
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }))

  const submit = (e) => {
    e.preventDefault()
    onSave({
      title: form.title.trim(),
      property_type: form.property_type || null,
      bhk: form.bhk || null,
      size_sqft: form.size_sqft === '' ? null : Number(form.size_sqft),
      price_paise: lakhsToPaise(form.price_l),
      locality: form.locality.trim() || null,
      city: form.city.trim() || null,
      status: form.status,
      rera_project_number: form.rera_project_number.trim() || null,
      builder_name: form.builder_name.trim() || null,
      owner_name: form.owner_name.trim() || null,
      photos: form.photos.split('\n').map((s) => s.trim()).filter(Boolean),
      brochure_url: form.brochure_url.trim() || null,
      notes: form.notes.trim() || null,
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Title *">
        <input value={form.title} onChange={set('title')} placeholder="Kolte Patil 24K — 2BHK East" className={inputCls} required />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Type">
          <select value={form.property_type} onChange={set('property_type')} className={inputCls}>
            <option value="">—</option>
            <option value="apartment">Apartment</option>
            <option value="villa">Villa</option>
            <option value="plot">Plot</option>
            <option value="commercial">Commercial</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={set('status')} className={inputCls}>
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="BHK">
        <div className="flex gap-2">
          {['1', '2', '3', '4', '5+'].map((b) => (
            <Chip key={b} active={form.bhk === b} onClick={() => setForm((s) => ({ ...s, bhk: s.bhk === b ? '' : b }))}>
              {b}
            </Chip>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Size (sqft)">
          <input type="number" min="0" value={form.size_sqft} onChange={set('size_sqft')} className={inputCls} />
        </Field>
        <Field label="Price (₹ Lakhs)">
          <input type="number" min="0" step="0.5" value={form.price_l} onChange={set('price_l')} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Locality">
          <input value={form.locality} onChange={set('locality')} placeholder="Baner" className={inputCls} />
        </Field>
        <Field label="City">
          <input value={form.city} onChange={set('city')} placeholder="Pune" className={inputCls} />
        </Field>
      </div>
      <Field label="RERA project number">
        <input value={form.rera_project_number} onChange={set('rera_project_number')} placeholder="P52100012345" className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Builder">
          <input value={form.builder_name} onChange={set('builder_name')} className={inputCls} />
        </Field>
        <Field label="Owner">
          <input value={form.owner_name} onChange={set('owner_name')} className={inputCls} />
        </Field>
      </div>
      <Field label="Photo URLs (one per line)">
        <textarea value={form.photos} onChange={set('photos')} rows={2} className={inputCls} />
      </Field>
      <Field label="Brochure URL">
        <input value={form.brochure_url} onChange={set('brochure_url')} className={inputCls} />
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={set('notes')} rows={2} className={inputCls} />
      </Field>
      {error && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving} className="flex-1 bg-brand text-white font-bold text-[13.5px] rounded-full py-3 active:scale-[0.99] transition disabled:opacity-50">
          {saving ? 'Saving…' : 'Save property'}
        </button>
        <button type="button" onClick={onCancel} className="px-5 text-[13px] font-bold text-ink-soft rounded-full py-3 bg-ink/5 active:scale-[0.99] transition">
          Cancel
        </button>
      </div>
    </form>
  )
}

// Pick one of your leads to send the property card to (via WhatsApp).
function SendToChatSheet({ property, onClose }) {
  const [leads, setLeads] = useState(null)
  const [q, setQ] = useState('')
  const [state, setState] = useState({}) // leadId -> 'sending' | 'sent' | error message

  useEffect(() => {
    api.leads().then((all) => setLeads(all.filter((l) => !l.unassigned))).catch(() => setLeads([]))
  }, [])

  const send = async (lead) => {
    setState((s) => ({ ...s, [lead.id]: 'sending' }))
    try {
      await api.sendPropertyToChat(property.id, lead.id)
      setState((s) => ({ ...s, [lead.id]: 'sent' }))
    } catch (err) {
      setState((s) => ({ ...s, [lead.id]: err.message }))
    }
  }

  const filtered = (leads || []).filter((l) =>
    !q || String(l.contact_name || l.name || l.wa_id).toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Sheet onClose={onClose} title={`Send "${property.title}" to…`}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts…" className={inputCls} />
      <div className="mt-3 space-y-2 max-h-[50vh] overflow-y-auto no-scrollbar">
        {leads && filtered.length === 0 && <p className="text-[12.5px] text-ink-faint py-2">No matching leads.</p>}
        {filtered.map((l) => {
          const st = state[l.id]
          return (
            <div key={l.id} className="flex items-center gap-3 bg-card border border-line rounded-xl px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-ink truncate">{l.contact_name || l.name || l.wa_id}</p>
                {st && st !== 'sending' && st !== 'sent' && <p className="text-[11px] text-hot truncate">{st}</p>}
              </div>
              <button
                onClick={() => send(l)}
                disabled={st === 'sending' || st === 'sent'}
                className={`shrink-0 text-[12px] font-bold rounded-full px-3.5 py-1.5 transition active:scale-95 ${
                  st === 'sent' ? 'bg-brand-wash text-brand-deep' : 'bg-[#25D366] text-white'
                } disabled:opacity-70`}
              >
                {st === 'sending' ? 'Sending…' : st === 'sent' ? '✓ Sent' : 'Send'}
              </button>
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}

export default function PropertyDetail({ propertyId, onClose, onChanged }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: property } = usePoll(() => api.property(propertyId), 30000, [propertyId, refreshKey])
  const [editing, setEditing] = useState(false)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  if (!property)
    return (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-ink/50" onClick={onClose} />
      </div>
    )

  const save = async (fields) => {
    setSaving(true)
    setError(null)
    try {
      await api.updateProperty(property.id, fields)
      setEditing(false)
      setRefreshKey((k) => k + 1)
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete "${property.title}"?`)) return
    await api.deleteProperty(property.id)
    onChanged?.()
    onClose()
  }

  const specs = [
    ['Type', property.property_type],
    ['BHK', property.bhk && `${property.bhk} BHK`],
    ['Size', property.size_sqft && `${property.size_sqft} ${property.size_unit || 'sqft'}`],
    ['Locality', [property.locality, property.city].filter(Boolean).join(', ') || null],
    ['RERA', property.rera_project_number],
    ['Builder', property.builder_name],
    ['Owner', property.owner_name],
    ['Notes', property.notes],
  ].filter(([, v]) => v)

  return (
    <SlideOver onClose={onClose}>
      <div className="sticky top-0 bg-cream/95 backdrop-blur border-b border-line px-5 py-4 flex items-center gap-3 z-10">
        <button onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          ←
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-[18px] text-ink leading-tight truncate">{property.title}</p>
          <p className="text-[11.5px] text-ink-faint truncate">
            {paiseToDisplay(property.price_paise) || 'Price on request'} · added {fmtAgo(property.created_at)}
          </p>
        </div>
        <span className={`shrink-0 text-[10.5px] font-bold border rounded-full px-2.5 py-1 ${STATUS_STYLE[property.status] || STATUS_STYLE.available}`}>
          {STATUS_LABEL[property.status] || property.status}
        </span>
      </div>

      <div className="px-5 py-5 space-y-4 pb-10">
        {editing ? (
          <section className="bg-card rounded-2xl border border-line shadow-card p-4">
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-3">EDIT PROPERTY</p>
            <PropertyForm initial={property} onSave={save} onCancel={() => setEditing(false)} saving={saving} error={error} />
          </section>
        ) : (
          <>
            {(property.photos || []).length > 0 && (
              <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
                {property.photos.map((url) => (
                  <img key={url} src={url} alt="" className="h-36 rounded-2xl border border-line object-cover" />
                ))}
              </div>
            )}
            <section className="bg-card rounded-2xl border border-line shadow-card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand">DETAILS</p>
                <button onClick={() => setEditing(true)} className="text-[11.5px] font-bold text-brand underline underline-offset-2">
                  Edit
                </button>
              </div>
              <p className="font-display text-[24px] font-bold text-ink mb-3">
                {paiseToDisplay(property.price_paise) || 'Price on request'}
              </p>
              <dl className="space-y-2.5">
                {specs.map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="shrink-0 w-[80px] text-[12px] font-bold text-ink-soft">{k}</dt>
                    <dd className="text-[12.5px] text-ink leading-snug break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              {property.brochure_url && (
                <a href={property.brochure_url} target="_blank" rel="noopener noreferrer" className="inline-block mt-3 text-[12.5px] font-bold text-brand underline underline-offset-2">
                  📄 Open brochure
                </a>
              )}
            </section>

            <button
              onClick={() => setSending(true)}
              className="w-full bg-[#25D366] text-white font-bold text-[14.5px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition"
            >
              Send to chat 💬
            </button>
            <button onClick={remove} className="w-full text-[12.5px] font-bold text-hot py-2 active:scale-[0.98] transition">
              Delete property
            </button>
          </>
        )}
      </div>

      {sending && <SendToChatSheet property={property} onClose={() => setSending(false)} />}
    </SlideOver>
  )
}
