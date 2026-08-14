import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Chip, ErrorBanner, Field, inputCls, useConfirm } from './ui.jsx'

// All four lists on this screen load the same way, and all four used to catch a
// failed request into an empty array — `.catch(() => setAssets([]))`. That turns "we
// could not reach the server" into "you have nothing", which is the one reading an
// agent must never be given: on the Templates tab it means someone whose approved
// templates appear to have vanished will write them again and put them back through
// Meta review. Keep the failure a failure, and let the caller show it.
function useList(fetcher) {
  const [items, setItems] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const load = () =>
    fetcher()
      .then((next) => {
        setLoadErr(null)
        setItems(next)
      })
      .catch(setLoadErr)
  useEffect(() => {
    load()
  }, [])
  // `loading` is not `!items`: a first request that failed leaves items null for ever.
  return { items, loadErr, load, loading: items === null && !loadErr }
}

const KIND_ICON = { brochure: '📄', floor_plan: '📐', photo: '🖼️', video: '🎬', document: '📎' }

// Tap-to-insert variables so nobody has to type the {{double-brace}} syntax by hand.
const INSERT_VARS = [
  { token: '{{name}}', label: 'Name' },
  { token: '{{property}}', label: 'Property' },
  { token: '{{visit_time}}', label: 'Visit time' },
]

// A row of chips that append the correct fill-in token to a textarea's value.
function VarChips({ onInsert }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      <span className="text-[11px] text-ink-faint self-center">Insert:</span>
      {INSERT_VARS.map((v) => (
        <button
          key={v.token}
          type="button"
          onClick={() => onInsert(v.token)}
          className="text-[11px] font-bold text-brand-deep bg-brand-wash rounded-full px-2.5 py-1 active:scale-95 transition"
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

// --- Media library ---------------------------------------------------------
function MediaManager() {
  const { items: assets, loadErr, load } = useList(() => api.media())
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('brochure')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)
  const confirm = useConfirm()

  const uploadFile = async (file) => {
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      const data_base64 = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result)
        r.onerror = reject
        r.readAsDataURL(file)
      })
      await api.createMedia({
        title: title.trim() || file.name,
        kind,
        data_base64,
        filename: file.name,
        mime: file.type,
      })
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = (a) =>
    confirm({
      title: `Delete "${a.title || 'this file'}"?`,
      message: 'It will be removed from your media library.',
      onConfirm: async () => {
        await api.deleteMedia(a.id)
        await load()
      },
    })

  return (
    <div className="mt-4">
      <div className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="font-bold text-[13.5px] text-ink mb-2">Add to library</p>
        <div className="flex gap-2 mb-2 flex-wrap">
          {['brochure', 'floor_plan', 'photo', 'video', 'document'].map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
              {KIND_ICON[k]} {k.replace('_', ' ')}
            </Chip>
          ))}
        </div>
        <Field label="Title (optional)">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="e.g. Green Acres brochure" />
        </Field>
        {/* A file input takes no placeholder, so without an explicit name a screen
            reader announces it as a bare "choose file" button — the one control on
            this card that says nothing about what it uploads. */}
        <input
          ref={fileRef}
          type="file"
          aria-label="Choose a file to upload to the library"
          onChange={(e) => uploadFile(e.target.files?.[0])}
          disabled={busy}
          className="mt-2 block w-full text-[12px] text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-brand file:text-white file:px-4 file:py-2 file:text-[12px] file:font-bold"
        />
        {busy && <p className="text-[11.5px] text-brand font-bold mt-2">Uploading…</p>}
        {err && <p className="text-[11.5px] text-hot mt-2">{err}</p>}
        <p className="text-[11px] text-ink-faint mt-2">Upload once, then attach to any chat in two taps.</p>
      </div>

      <ErrorBanner error={loadErr} className="mt-4" />

      <div className="space-y-2 mt-4">
        {assets?.length === 0 && <p className="text-[12.5px] text-ink-faint px-1">Nothing in the library yet.</p>}
        {(assets || []).map((a) => (
          <div key={a.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3 flex items-center gap-3">
            <span className="text-[22px]">{KIND_ICON[a.kind] || '📎'}</span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[13.5px] text-ink truncate">{a.title}</p>
              <p className="text-[11px] text-ink-faint truncate">
                {a.kind.replace('_', ' ')} · sent to {a.sent_count} {a.sent_count === 1 ? 'contact' : 'contacts'}
              </p>
            </div>
            <button onClick={() => remove(a)} className="shrink-0 text-[11px] text-hot font-bold">
              delete
            </button>
          </div>
        ))}
      </div>
      {confirm.dialog}
    </div>
  )
}

// --- Templates -------------------------------------------------------------
function TemplatesManager() {
  const { items: templates, loadErr, load } = useList(() => api.templates())
  const [name, setName] = useState('')
  const [category, setCategory] = useState('utility')
  const [body, setBody] = useState('')
  const [rera, setRera] = useState(false)
  const [err, setErr] = useState(null)
  const confirm = useConfirm()

  const create = async () => {
    setErr(null)
    try {
      await api.createTemplate({ name: name.trim(), category, body, rera_auto_append: rera })
      setName('')
      setBody('')
      await load()
    } catch (e) {
      setErr(e.message)
    }
  }
  const remove = (t) =>
    confirm({
      title: `Delete template "${t.name}"?`,
      message: 'You\'ll need to create and get it approved again if you want it back.',
      onConfirm: async () => {
        setErr(null)
        try {
          await api.deleteTemplate(t.id)
          await load()
        } catch (e) {
          setErr(e.message)
        }
      },
    })

  return (
    <div className="mt-4">
      <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2">
        <p className="font-bold text-[13.5px] text-ink">New template</p>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Weekly follow-up" />
        </Field>
        <div>
          <div className="flex gap-2">
            {['utility', 'marketing', 'service'].map((c) => (
              <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                {c === 'utility' ? 'Reminder' : c === 'marketing' ? 'Promotion' : 'Reply'}
              </Chip>
            ))}
          </div>
          <p className="text-[11px] text-ink-faint mt-1.5">
            WhatsApp needs to know the message type. Reminder = updates &amp; nudges · Promotion =
            offers &amp; new listings · Reply = answering a question.
          </p>
        </div>
        <Field label="Body">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className={inputCls + ' resize-none'} placeholder="Hi {{name}}, …" />
        </Field>
        <VarChips onInsert={(t) => setBody((b) => (b ? `${b} ${t}` : t))} />
        {category === 'marketing' && (
          <label className="flex items-center gap-2 text-[12px] text-ink-soft">
            <input type="checkbox" checked={rera} onChange={(e) => setRera(e.target.checked)} />
            Auto-append my RERA number (required for promotions)
          </label>
        )}
        <p className="text-[11px] text-ink-faint">Tap a chip above to drop in a fill-in — the name fills in automatically when you send.</p>
        {err && <p className="text-[11.5px] text-hot">{err}</p>}
        <button
          onClick={create}
          disabled={!name.trim() || !body.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add template
        </button>
      </div>

      <ErrorBanner error={loadErr} className="mt-4" />

      <div className="space-y-2 mt-4">
        {templates?.length === 0 && (
          <p className="text-[12.5px] text-ink-faint px-1">No templates yet.</p>
        )}
        {(templates || []).map((t) => {
          const locked = t.is_locked || t.meta_status === 'approved'
          return (
            <div key={t.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="font-bold text-[13.5px] text-ink flex-1">{t.name}</p>
                <span className="text-[9.5px] font-bold bg-cream border border-line rounded-full px-2 py-0.5 text-ink-soft">
                  {t.category === 'utility' ? 'Reminder' : t.category === 'marketing' ? 'Promotion' : t.category === 'service' ? 'Reply' : t.category}
                </span>
                {t.is_system && <span className="text-[9.5px] font-bold bg-brand-wash text-brand-deep rounded-full px-2 py-0.5">pack</span>}
                {locked && <span className="text-[11px]" title="Locked — fill variables, can't edit wording">🔒</span>}
              </div>
              <p className="text-[12px] text-ink-soft mt-1 whitespace-pre-line">{t.body}</p>
              {t.rera_auto_append && <p className="text-[10.5px] text-brand-deep font-bold mt-1">+ RERA auto-appended</p>}
              {!t.is_system && (
                <button onClick={() => remove(t)} className="text-[11px] text-hot font-bold mt-1.5">
                  delete
                </button>
              )}
            </div>
          )
        })}
      </div>
      {confirm.dialog}
    </div>
  )
}

// --- Quick replies ---------------------------------------------------------
function QuickRepliesManager() {
  const { items: replies, loadErr, load } = useList(() => api.quickReplies())
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const create = async () => {
    await api.createQuickReply({ title: title.trim(), body })
    setTitle('')
    setBody('')
    await load()
  }
  const remove = async (r) => {
    await api.deleteQuickReply(r.id)
    await load()
  }

  return (
    <div className="mt-4">
      <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2">
        <p className="font-bold text-[13.5px] text-ink">New quick reply</p>
        <Field label="Shortcut / title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="e.g. Ask budget" />
        </Field>
        <Field label="Body">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} className={inputCls + ' resize-none'} placeholder="Hi {{name}}, …" />
        </Field>
        <VarChips onInsert={(t) => setBody((b) => (b ? `${b} ${t}` : t))} />
        <button
          onClick={create}
          disabled={!title.trim() || !body.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add quick reply
        </button>
      </div>
      <ErrorBanner error={loadErr} className="mt-4" />

      <div className="space-y-2 mt-4">
        {replies?.length === 0 && (
          <p className="text-[12.5px] text-ink-faint px-1">No quick replies yet.</p>
        )}
        {(replies || []).map((r) => (
          <div key={r.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="font-bold text-[13px] text-ink flex-1">{r.title}</p>
              {r.is_system && <span className="text-[9.5px] font-bold bg-brand-wash text-brand-deep rounded-full px-2 py-0.5">default</span>}
              <button onClick={() => remove(r)} className="text-[11px] text-hot font-bold">
                delete
              </button>
            </div>
            <p className="text-[12px] text-ink-soft mt-1">{r.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Labels ----------------------------------------------------------------
function LabelsManager() {
  const { items: labels, loadErr, load } = useList(() => api.labels())
  const [name, setName] = useState('')
  const [color, setColor] = useState('#64748b')

  const create = async () => {
    await api.createLabel({ name: name.trim(), color })
    setName('')
    await load()
  }
  const remove = async (l) => {
    await api.deleteLabel(l.id).catch(() => {})
    await load()
  }

  return (
    <div className="mt-4">
      <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2">
        <p className="font-bold text-[13.5px] text-ink">New label</p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. NRI buyer" />
            </Field>
          </div>
          {/* The swatch sits outside the Field wrapper (it is its own square next to
              the name box), so it needs to carry its own name. */}
          <input
            type="color"
            aria-label="Label colour"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-11 h-11 rounded-xl border border-line bg-white"
          />
        </div>
        <button
          onClick={create}
          disabled={!name.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add label
        </button>
      </div>
      <ErrorBanner error={loadErr} className="mt-4" />

      <div className="flex flex-wrap gap-2 mt-4">
        {labels?.length === 0 && <p className="text-[12.5px] text-ink-faint px-1">No labels yet.</p>}
        {(labels || []).map((l) => (
          <span
            key={l.id}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold rounded-full px-3 py-1.5 text-white"
            style={{ backgroundColor: l.color }}
          >
            {l.name}
            {!l.is_system && (
              <button onClick={() => remove(l)} className="opacity-80">
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-ink-faint mt-3 px-1">
        The six lifecycle labels are applied automatically (New, Hot, Site Visit Scheduled, Token
        Paid, Lost, Broker) and can't be deleted.
      </p>
    </div>
  )
}

export default function SnippetsMediaScreen() {
  const [tab, setTab] = useState('media')
  return (
    <div>
      <div className="flex gap-2 mt-4 overflow-x-auto no-scrollbar">
        <Chip active={tab === 'media'} onClick={() => setTab('media')}>
          Media library
        </Chip>
        <Chip active={tab === 'templates'} onClick={() => setTab('templates')}>
          Templates
        </Chip>
        <Chip active={tab === 'quick'} onClick={() => setTab('quick')}>
          Quick replies
        </Chip>
        <Chip active={tab === 'labels'} onClick={() => setTab('labels')}>
          Labels
        </Chip>
      </div>
      {tab === 'templates' && (
        <p className="text-[11.5px] text-ink-soft mt-3 px-1 leading-snug">
          Approved messages for buyers who haven't replied in 24 hours.
        </p>
      )}
      {tab === 'quick' && (
        <p className="text-[11.5px] text-ink-soft mt-3 px-1 leading-snug">
          Shortcuts you drop into a live chat.
        </p>
      )}
      {tab === 'media' && <MediaManager />}
      {tab === 'templates' && <TemplatesManager />}
      {tab === 'quick' && <QuickRepliesManager />}
      {tab === 'labels' && <LabelsManager />}
    </div>
  )
}
