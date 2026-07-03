import { useState } from 'react'
import { api, usePoll, fmtAgo, fmtBudget } from '../api.js'

function PostForm({ onPosted }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ type: 'INVENTORY', broker: '', firm: '', text: '', config: '', locality: '', budget_min_l: '', budget_max_l: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.postNetwork({
        ...form,
        budget_min_l: form.budget_min_l ? Number(form.budget_min_l) : null,
        budget_max_l: form.budget_max_l ? Number(form.budget_max_l) : null,
      })
      setForm({ type: 'INVENTORY', broker: '', firm: '', text: '', config: '', locality: '', budget_min_l: '', budget_max_l: '' })
      setOpen(false)
      onPosted()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-brand text-white font-bold text-[13.5px] rounded-2xl py-3.5 shadow-card active:scale-[0.98] transition rise rise-1"
      >
        + Post inventory or a buyer requirement
      </button>
    )

  const input = 'w-full bg-white border border-line rounded-xl px-3 py-2.5 text-[13px] outline-none focus:border-brand/50'
  return (
    <div className="bg-card rounded-2xl border border-line shadow-card p-4 space-y-2.5 rise">
      <div className="flex gap-2">
        {['INVENTORY', 'REQUIREMENT'].map((t) => (
          <button
            key={t}
            onClick={() => setForm((f) => ({ ...f, type: t }))}
            className={`flex-1 text-[11.5px] font-bold rounded-full py-2 border transition ${
              form.type === t ? 'bg-ink text-cream border-ink' : 'bg-card text-ink-soft border-line'
            }`}
          >
            {t === 'INVENTORY' ? 'I have inventory' : 'I need inventory'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <input className={input} placeholder="Your name*" value={form.broker} onChange={set('broker')} />
        <input className={input} placeholder="Firm" value={form.firm} onChange={set('firm')} />
      </div>
      <textarea className={input} rows={2} placeholder="Details* — e.g. 2BHK Skyline Residency, east-facing, OC received" value={form.text} onChange={set('text')} />
      <div className="grid grid-cols-2 gap-2.5">
        <input className={input} placeholder="Config (e.g. 2 BHK)" value={form.config} onChange={set('config')} />
        <input className={input} placeholder="Locality (e.g. Wakad)" value={form.locality} onChange={set('locality')} />
        <input className={input} type="number" placeholder="Budget min (₹L)" value={form.budget_min_l} onChange={set('budget_min_l')} />
        <input className={input} type="number" placeholder="Budget max (₹L)" value={form.budget_max_l} onChange={set('budget_max_l')} />
      </div>
      {err && <p className="text-[11.5px] text-hot">{err}</p>}
      <div className="flex gap-2">
        <button onClick={() => setOpen(false)} className="flex-1 text-[13px] font-bold text-ink-soft bg-cream border border-line rounded-xl py-3">
          Cancel
        </button>
        <button onClick={submit} disabled={busy || !form.broker || !form.text} className="flex-1 text-[13px] font-bold text-white bg-brand rounded-xl py-3 disabled:opacity-40">
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  )
}

export default function NetworkTab() {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, error } = usePoll(api.network, 6000, [refreshKey])
  const posts = data?.posts || []
  const matches = data?.matches || []

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Network</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          Co-broking exchange · matches computed against your real leads
        </p>
      </header>

      {error && (
        <p className="mt-6 text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
          Can't reach the HomeNex server: {error.message}
        </p>
      )}

      <div className="mt-5">
        <PostForm onPosted={() => setRefreshKey((k) => k + 1)} />
      </div>

      <section className="mt-6">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand rise rise-1">
          MATCHES <span className="text-ink-faint font-semibold tracking-normal">— Your buyers ↔ posted inventory</span>
        </p>
        {matches.length === 0 && (
          <p className="text-[12.5px] text-ink-soft bg-card border border-line rounded-2xl shadow-card px-4 py-4 mt-3">
            No matches yet. A match appears when posted inventory overlaps a qualified lead's
            locality, configuration and budget.
          </p>
        )}
        <div className="space-y-3 mt-3">
          {matches.map((m, i) => (
            <div key={`${m.lead.id}-${m.inventory.id}`} className={`bg-card rounded-2xl border border-line shadow-card overflow-hidden rise rise-${Math.min(i + 2, 5)}`}>
              <div className="flex items-center justify-between px-4 pt-3.5">
                <span className="text-[10.5px] font-bold tracking-[0.12em] text-gold bg-amber-wash rounded-full px-2.5 py-1">
                  {m.matchPct}% MATCH
                </span>
                <span className="text-[11px] text-ink-faint font-medium">via HomeNex Network</span>
              </div>
              <div className="px-4 py-3.5">
                <div className="rounded-xl bg-cream border border-line p-3">
                  <p className="text-[10px] font-bold tracking-[0.15em] text-ink-faint">YOUR BUYER</p>
                  <p className="font-bold text-[13.5px] text-ink mt-0.5">{m.lead.name || m.lead.wa_id}</p>
                  <p className="text-[12px] text-ink-soft">
                    {[m.lead.config, m.lead.locality, fmtBudget(m.lead.budget_min_l, m.lead.budget_max_l)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex justify-center -my-2 relative z-10">
                  <span className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center text-[15px] shadow-card border-2 border-card">↕</span>
                </div>
                <div className="rounded-xl bg-brand-wash border border-brand/20 p-3">
                  <p className="text-[10px] font-bold tracking-[0.15em] text-brand-deep">THEIR INVENTORY</p>
                  <p className="font-bold text-[13.5px] text-ink mt-0.5">{m.inventory.text}</p>
                  <p className="text-[12px] text-ink-soft">
                    {m.inventory.broker}
                    {m.inventory.firm ? ` · ${m.inventory.firm}` : ''}
                  </p>
                </div>
                <button className="mt-3 w-full font-bold text-[13.5px] rounded-xl py-3 transition active:scale-[0.98] bg-brand text-white shadow-card">
                  Propose co-broke · 50:50 split
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-7 rise rise-4">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-60 pulse-dot" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
          </span>
          <p className="text-[11px] font-bold tracking-[0.18em] text-ink">
            FEED <span className="text-ink-faint font-semibold tracking-normal">— Inventory & requirements</span>
          </p>
        </div>
        {posts.length === 0 && (
          <p className="text-[12.5px] text-ink-soft bg-card border border-line rounded-2xl shadow-card px-4 py-4 mt-3 mb-4">
            Nothing posted yet — be the first.
          </p>
        )}
        <div className="space-y-2.5 mt-3 pb-4">
          {posts.map((f) => (
            <div key={f.id} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-cream border border-line flex items-center justify-center font-display font-bold text-[12px] text-ink-soft">
                  {f.broker.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[13px] text-ink truncate">
                    {f.broker}
                    {f.firm && <span className="font-medium text-ink-faint"> · {f.firm}</span>}
                  </p>
                  <p className="text-[11px] text-ink-faint">{fmtAgo(f.created_at)}</p>
                </div>
                <span
                  className={`shrink-0 text-[9.5px] font-bold rounded-full px-2 py-0.5 ${
                    f.type === 'INVENTORY' ? 'bg-brand-wash text-brand-deep' : 'bg-amber-wash text-gold'
                  }`}
                >
                  {f.type}
                </span>
              </div>
              <p className="text-[12.5px] text-ink leading-snug mt-2.5">{f.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
