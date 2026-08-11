import { useEffect, useRef, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { paiseToDisplay, lakhsToPaise, paiseToLakhs } from '../money.js'
import { SlideOver, Sheet, Chip, Field, inputCls, useConfirm, InfoTip, DetailOverlay } from './ui.jsx'
import { glossary } from '../lib/glossary.js'

// Downscale a phone-camera photo to a reasonable listing size in the browser, so a
// 5 MB image never travels over a patchy 4G connection. Returns a JPEG data URL.
const PHOTO_MAX_PX = 1280
function downscalePhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file isn't an image we can read"))
    }
    img.src = url
  })
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error("Couldn't read that file"))
    r.readAsDataURL(file)
  })
}

// Pick property photos from the phone gallery/camera. Uploads each to the server and
// keeps a list of hosted URLs — the broker never has to host or paste a link.
function PhotoPicker({ photos, onChange, onError }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)

  const pick = async (files) => {
    if (!files?.length) return
    setBusy(true)
    onError(null)
    try {
      for (const file of files) {
        const dataUrl = await downscalePhoto(file)
        const { url } = await api.uploadFile(dataUrl, file.name, 'image/jpeg')
        onChange((prev) => [...prev, url])
      }
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex gap-2 flex-wrap">
        {photos.map((url, i) => (
          <div key={url} className="relative">
            <img src={url} alt="" className="w-20 h-20 rounded-xl border border-line object-cover" />
            <button
              type="button"
              onClick={() => onChange((prev) => prev.filter((_, j) => j !== i))}
              aria-label="Remove photo"
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ink text-white text-[12px] leading-none flex items-center justify-center shadow active:scale-90 transition"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="w-20 h-20 rounded-xl border-2 border-dashed border-line text-ink-faint text-[11px] font-bold flex flex-col items-center justify-center gap-1 active:scale-95 transition disabled:opacity-50"
        >
          <span className="text-[20px] leading-none">＋</span>
          {busy ? 'Adding…' : 'Add photo'}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          pick(files)
        }}
      />
    </div>
  )
}

// Pick a brochure (PDF or image) from the phone and upload it.
function BrochurePicker({ url, onChange, onError }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)

  const pick = async (file) => {
    if (!file) return
    setBusy(true)
    onError(null)
    try {
      const dataUrl = await fileToDataUrl(file)
      const saved = await api.uploadFile(dataUrl, file.name, file.type)
      onChange(saved.url)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (url) {
    return (
      <div className="flex items-center gap-2 bg-cream border border-line rounded-xl px-3 py-2.5">
        <span className="text-[16px]">📄</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="flex-1 text-[12px] font-bold text-brand underline underline-offset-2 truncate">
          Brochure added — view
        </a>
        <button type="button" onClick={() => onChange(null)} className="shrink-0 text-[11.5px] font-bold text-hot active:scale-95 transition">
          Remove
        </button>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="w-full rounded-xl border-2 border-dashed border-line text-ink-soft text-[12.5px] font-bold py-3 active:scale-[0.99] transition disabled:opacity-50"
      >
        {busy ? 'Uploading…' : '📄 Add brochure (PDF)'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          pick(file)
        }}
      />
    </div>
  )
}

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
    notes: initial?.notes || '',
  }))
  const [photos, setPhotos] = useState(() => initial?.photos || [])
  const [brochureUrl, setBrochureUrl] = useState(() => initial?.brochure_url || '')
  const [uploadError, setUploadError] = useState(null)
  // "More details" (RERA/builder/owner/brochure/notes) starts open when editing an
  // existing property that already has any of them, else collapsed to keep add simple.
  const [showMore, setShowMore] = useState(() =>
    Boolean(initial?.rera_project_number || initial?.builder_name || initial?.owner_name || initial?.brochure_url || initial?.notes),
  )
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
      photos,
      brochure_url: brochureUrl || null,
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

      <Field label="Photos">
        <PhotoPicker photos={photos} onChange={setPhotos} onError={setUploadError} />
        <span className="block text-[11px] text-ink-faint mt-1.5">Pick straight from your phone — no links needed.</span>
      </Field>
      {uploadError && <p className="text-[12px] text-hot bg-amber-wash rounded-xl px-3.5 py-2.5">{uploadError}</p>}

      {/* Rarely-changed extras stay out of the way so "add a flat" feels light. */}
      <button
        type="button"
        onClick={() => setShowMore((v) => !v)}
        className="w-full flex items-center justify-between text-[12px] font-bold text-ink-soft bg-cream rounded-xl px-3.5 py-2.5 active:scale-[0.99] transition"
      >
        More details (optional)
        <span className="text-ink-faint">{showMore ? '▲' : '▼'}</span>
      </button>

      {showMore && (
        <div className="space-y-3">
          <Field label={<span className="inline-flex items-center gap-1.5">RERA project number <InfoTip label="RERA" text={glossary.RERA} /></span>}>
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
          <Field label="Brochure">
            <BrochurePicker url={brochureUrl} onChange={setBrochureUrl} onError={setUploadError} />
          </Field>
          <Field label="Notes">
            <textarea value={form.notes} onChange={set('notes')} rows={2} className={inputCls} />
          </Field>
        </div>
      )}

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

  // The search runs on the server. Filtering client-side stopped being correct the
  // moment the list took a LIMIT: an agent with 400 leads would have been searching
  // the 50 most recent and told the other 350 don't exist.
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      api
        .leads({ q, limit: 50 })
        .then((page) => alive && setLeads(page.filter((l) => !l.unassigned)))
        .catch(() => alive && setLeads([]))
    }, q ? 250 : 0) // debounce typing; the first load shouldn't wait
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [q])

  const send = async (lead) => {
    setState((s) => ({ ...s, [lead.id]: 'sending' }))
    try {
      await api.sendPropertyToChat(property.id, lead.id)
      setState((s) => ({ ...s, [lead.id]: 'sent' }))
    } catch (err) {
      setState((s) => ({ ...s, [lead.id]: err.message }))
    }
  }

  const filtered = leads || []

  return (
    <Sheet onClose={onClose} title={`Send "${property.title}" to…`}>
      <input
        type="search"
        aria-label="Search contacts to share with"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search contacts…"
        className={inputCls}
      />
      <div className="mt-3 space-y-2 max-h-[50vh] overflow-y-auto no-scrollbar">
        {!leads && <p className="text-[12.5px] text-ink-faint py-2">Loading your leads…</p>}
        {leads && filtered.length === 0 && (
          <p className="text-[12.5px] text-ink-faint py-2">
            {q ? `No leads matching "${q}".` : 'No leads to send this to yet.'}
          </p>
        )}
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

// Public micro-page share card: link + view counter (the engagement signal).
function MicroPageCard({ propertyId }) {
  const [page, setPage] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.microPage(propertyId).then(setPage).catch(() => {})
  }, [propertyId])

  if (!page) return null

  const share = async () => {
    if (navigator.share) {
      await navigator.share({ url: page.url }).catch(() => {})
      return
    }
    await navigator.clipboard?.writeText(page.url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand">PUBLIC PAGE</p>
        <span className="text-[11px] font-bold text-ink-soft tabular-nums">
          👁 {page.stats?.total ?? page.page_views} views
          {page.stats?.last_7d ? ` · ${page.stats.last_7d} this week` : ''}
        </span>
      </div>
      <a href={page.url} target="_blank" rel="noopener noreferrer" className="block text-[12px] text-brand underline underline-offset-2 break-all">
        {page.url}
      </a>
      <button
        onClick={share}
        className="mt-3 w-full bg-brand-wash text-brand-deep font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition"
      >
        {copied ? '✓ Link copied' : '🔗 Share micro-page'}
      </button>
      <p className="text-[10.5px] text-ink-faint mt-2">
        Anyone with the link can view — perfect for broker groups. Every time someone opens it is counted here.
      </p>
    </section>
  )
}

// View analytics: totals, a 14-day sparkline-ish bar row, and who's actually
// looking — a lead re-opening the page is the strongest buying signal HomeNex has.
function AnalyticsCard({ propertyId, onOpenLead }) {
  const [a, setA] = useState(null)
  useEffect(() => {
    api.propertyAnalytics(propertyId).then(setA).catch(() => {})
  }, [propertyId])
  if (!a || a.total === 0) return null
  const days = a.daily.slice(-14)
  const max = Math.max(1, ...days.map((d) => d.views))
  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-3">WHO'S LOOKING AT THIS PROPERTY</p>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[['Total', a.total], ['Last 24h', a.last_24h], ['Viewers', a.distinct_leads]].map(([label, v]) => (
          <div key={label} className="bg-cream rounded-xl px-3 py-2 text-center">
            <p className="font-display text-[20px] font-bold text-ink leading-none">{v}</p>
            <p className="text-[10px] font-semibold text-ink-soft mt-1">{label}</p>
          </div>
        ))}
      </div>
      {days.length > 0 && (
        <div className="flex items-end gap-1 h-12 mb-1">
          {days.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.views}`} className="flex-1 bg-brand/70 rounded-t" style={{ height: `${Math.max(6, (d.views / max) * 100)}%` }} />
          ))}
        </div>
      )}
      {a.viewers.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-soft">WHO'S LOOKING</p>
          {a.viewers.slice(0, 5).map((v) => (
            <button
              key={v.lead_id}
              onClick={() => onOpenLead?.(v.lead_id)}
              className="w-full flex items-center justify-between text-left active:scale-[0.99] transition"
            >
              <span className="text-[12.5px] font-bold text-ink truncate">{v.lead_name || v.wa_id}</span>
              <span className={`text-[11px] font-bold tabular-nums shrink-0 ${v.views >= 3 ? 'text-hot' : 'text-ink-soft'}`}>
                👁 {v.views}{v.views >= 3 ? ' 🔥' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

const PORTAL_LABELS = { '99acres': '99acres', magicbricks: 'MagicBricks', housing: 'Housing.com', nobroker: 'NoBroker' }

// Listing syndication (§5.2): compose the property once, preview and export the
// portal-formatted content for each portal, then copy it into the portal's listing form.
function SyndicateCard({ property }) {
  const [data, setData] = useState(null)
  const [portal, setPortal] = useState('99acres')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')

  const load = () => api.propertySyndications(property.id).then(setData).catch(() => {})
  useEffect(() => { load() }, [property.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null

  const preview = data.preview.find((p) => p.portal === portal)
  const exported = data.saved.find((s) => s.portal === portal)

  const doExport = async () => {
    setBusy(true)
    try { await api.syndicate(property.id, portal); await load() } finally { setBusy(false) }
  }
  const copy = async (text, which) => {
    await navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(which)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <section className="bg-card rounded-2xl border border-line shadow-card p-4">
      <p className="text-[10.5px] font-bold tracking-[0.18em] text-brand mb-1 flex items-center gap-1.5">
        POST TO PORTALS <InfoTip label="" text={glossary.SYNDICATION} align="left" />
      </p>
      <p className="text-[11.5px] text-ink-faint mb-3">Write it once — get ready-to-paste content for 99acres, MagicBricks, Housing and more.</p>
      <div className="flex gap-1.5 flex-wrap mb-3">
        {data.portals.map((p) => (
          <Chip key={p} active={portal === p} onClick={() => setPortal(p)}>{PORTAL_LABELS[p] || p}</Chip>
        ))}
      </div>

      {preview && (
        <div className="space-y-2.5">
          <p className="text-[12.5px] font-bold text-ink">
            {preview.price_display || 'Price on request'}
            {preview.spec ? <span className="text-ink-soft font-semibold"> · {preview.spec}</span> : null}
          </p>

          <div className="bg-cream border border-line rounded-xl p-3">
            <p className="text-[10px] font-bold tracking-[0.14em] text-ink-soft mb-1">WHATSAPP TEXT</p>
            <p className="text-[12px] text-ink whitespace-pre-wrap leading-snug">{preview.whatsapp_text}</p>
            <button onClick={() => copy(preview.whatsapp_text, 'wa')} className="mt-1.5 text-[11px] font-bold text-brand-deep active:scale-95 transition">
              {copied === 'wa' ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          <div className="bg-cream border border-line rounded-xl p-3">
            <p className="text-[10px] font-bold tracking-[0.14em] text-ink-soft mb-1">PORTAL DESCRIPTION</p>
            <p className="text-[12px] text-ink leading-snug">{preview.description}</p>
            <button onClick={() => copy(preview.description, 'desc')} className="mt-1.5 text-[11px] font-bold text-brand-deep active:scale-95 transition">
              {copied === 'desc' ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          <button
            onClick={doExport}
            disabled={busy}
            className="w-full bg-brand-wash text-brand-deep font-bold text-[13px] rounded-full py-2.5 active:scale-[0.99] transition disabled:opacity-50"
          >
            {busy ? 'Exporting…' : exported ? `✓ Exported to ${PORTAL_LABELS[portal]} · re-export` : `Export to ${PORTAL_LABELS[portal]}`}
          </button>
          {exported?.exported_at && (
            <p className="text-[10.5px] text-ink-faint text-center">Last exported {fmtAgo(exported.exported_at)}</p>
          )}
        </div>
      )}
    </section>
  )
}

export default function PropertyDetail({ propertyId, onClose, onChanged, onOpenLead }) {
  const { data: property, error: loadError, refresh } = usePoll(() => api.property(propertyId), 30000, [propertyId])
  const [editing, setEditing] = useState(false)
  const [sending, setSending] = useState(false)
  const [showPromote, setShowPromote] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const confirm = useConfirm()

  if (!property) return <DetailOverlay error={loadError} onClose={onClose} onRetry={refresh} />

  const save = async (fields) => {
    setSaving(true)
    setError(null)
    try {
      await api.updateProperty(property.id, fields)
      setEditing(false)
      refresh()
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = () =>
    confirm({
      title: `Delete "${property.title}"?`,
      message: 'This removes the property from your inventory. This cannot be undone.',
      confirmLabel: 'Delete property',
      onConfirm: async () => {
        await api.deleteProperty(property.id)
        onChanged?.()
        onClose()
      },
    })

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
        <button aria-label="Close property details" onClick={onClose} className="w-9 h-9 rounded-full bg-card border border-line flex items-center justify-center text-ink shadow-card active:scale-95 transition">
          <span aria-hidden="true">←</span>
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

            <div>
              <button
                onClick={() => setShowPromote((v) => !v)}
                className="w-full flex items-center justify-between bg-card rounded-2xl border border-line shadow-card px-4 py-3.5 active:scale-[0.99] transition"
              >
                <span className="text-[10.5px] font-bold tracking-[0.18em] text-brand">SHARE &amp; PROMOTE</span>
                <span className="text-ink-faint text-[13px]">{showPromote ? '▲' : '▼'}</span>
              </button>
              {showPromote && (
                <div className="space-y-4 mt-4">
                  <MicroPageCard propertyId={property.id} />
                  <SyndicateCard property={property} />
                  <AnalyticsCard propertyId={property.id} onOpenLead={onOpenLead} />
                </div>
              )}
            </div>

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
      {confirm.dialog}
    </SlideOver>
  )
}
