import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Chip, Field, inputCls, useConfirm } from './ui.jsx'

const KIND_ICON = { brochure: '📄', floor_plan: '📐', photo: '🖼️', video: '🎬', document: '📎' }
const varsHint = 'Use {{name}}, {{property}}, {{visit_time}} as fill-in variables.'

// --- Media library ---------------------------------------------------------
function MediaManager() {
  const [assets, setAssets] = useState(null)
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('brochure')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)
  const confirm = useConfirm()

  const load = () => api.media().then(setAssets).catch(() => setAssets([]))
  useEffect(() => {
    load()
  }, [])

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
        <input
          ref={fileRef}
          type="file"
          onChange={(e) => uploadFile(e.target.files?.[0])}
          disabled={busy}
          className="mt-2 block w-full text-[12px] text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-brand file:text-white file:px-4 file:py-2 file:text-[12px] file:font-bold"
        />
        {busy && <p className="text-[11.5px] text-brand font-bold mt-2">Uploading…</p>}
        {err && <p className="text-[11.5px] text-hot mt-2">{err}</p>}
        <p className="text-[11px] text-ink-faint mt-2">Upload once, then attach to any chat in two taps.</p>
      </div>

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
  const [templates, setTemplates] = useState(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('utility')
  const [body, setBody] = useState('')
  const [rera, setRera] = useState(false)
  const [err, setErr] = useState(null)
  const confirm = useConfirm()

  const load = () => api.templates().then(setTemplates).catch(() => setTemplates([]))
  useEffect(() => {
    load()
  }, [])

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
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. follow_up_week" />
        </Field>
        <div className="flex gap-2">
          {['utility', 'marketing', 'service'].map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
        <Field label="Body">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className={inputCls + ' resize-none'} placeholder="Hi {{name}}, …" />
        </Field>
        {category === 'marketing' && (
          <label className="flex items-center gap-2 text-[12px] text-ink-soft">
            <input type="checkbox" checked={rera} onChange={(e) => setRera(e.target.checked)} />
            Auto-append my RERA number (required for marketing)
          </label>
        )}
        <p className="text-[11px] text-ink-faint">{varsHint}</p>
        {err && <p className="text-[11.5px] text-hot">{err}</p>}
        <button
          onClick={create}
          disabled={!name.trim() || !body.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add template
        </button>
      </div>

      <div className="space-y-2 mt-4">
        {(templates || []).map((t) => {
          const locked = t.is_locked || t.meta_status === 'approved'
          return (
            <div key={t.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="font-bold text-[13.5px] text-ink flex-1">{t.name}</p>
                <span className="text-[9.5px] font-bold bg-cream border border-line rounded-full px-2 py-0.5 text-ink-soft">
                  {t.category}
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
  const [replies, setReplies] = useState(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const load = () => api.quickReplies().then(setReplies).catch(() => setReplies([]))
  useEffect(() => {
    load()
  }, [])

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
        <p className="text-[11px] text-ink-faint">{varsHint}</p>
        <button
          onClick={create}
          disabled={!title.trim() || !body.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add quick reply
        </button>
      </div>
      <div className="space-y-2 mt-4">
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
  const [labels, setLabels] = useState(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#64748b')

  const load = () => api.labels().then(setLabels).catch(() => setLabels([]))
  useEffect(() => {
    load()
  }, [])

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
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-11 h-11 rounded-xl border border-line bg-white" />
        </div>
        <button
          onClick={create}
          disabled={!name.trim()}
          className="w-full bg-brand text-white font-bold text-[13px] rounded-xl py-2.5 disabled:opacity-40 active:scale-[0.99] transition"
        >
          Add label
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
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
      {tab === 'media' && <MediaManager />}
      {tab === 'templates' && <TemplatesManager />}
      {tab === 'quick' && <QuickRepliesManager />}
      {tab === 'labels' && <LabelsManager />}
    </div>
  )
}
