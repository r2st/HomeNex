import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { Field, inputCls } from './ui.jsx'

const PORTALS = [
  { id: '99acres', label: '99acres' },
  { id: 'magicbricks', label: 'MagicBricks' },
  { id: 'housing', label: 'Housing.com' },
  { id: 'nobroker', label: 'NoBroker' },
]

const CHANNEL_META = {
  portal_email: { icon: '📧', label: 'Portal email' },
  portal_api: { icon: '🔌', label: 'Portal push' },
  meta_lead_ad: { icon: '📣', label: 'Lead Ad' },
  ctwa: { icon: '💬', label: 'Click-to-WhatsApp' },
  walk_in: { icon: '🚶', label: 'Walk-in' },
  phone: { icon: '📞', label: 'Phone' },
}

const STATUS_STYLE = {
  created: 'text-brand-deep',
  merged: 'text-ink-soft',
  duplicate: 'text-ink-faint',
  unmatched: 'text-gold',
  failed: 'text-hot',
}

// A single direct-portal API integration row (enable + API key).
function PortalRow({ portal, integration, onSaved }) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const enabled = integration?.enabled || false

  const toggle = async () => {
    setBusy(true)
    try {
      await api.updatePortalIntegration(portal.id, { enabled: !enabled })
      onSaved()
    } finally { setBusy(false) }
  }
  const saveKey = async () => {
    if (!apiKey.trim()) return
    setBusy(true)
    try {
      await api.updatePortalIntegration(portal.id, { api_key: apiKey.trim(), enabled: true })
      setApiKey('')
      onSaved()
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold text-[13.5px] text-ink">{portal.label}</p>
          <p className="text-[11px] text-ink-soft mt-0.5">
            {integration?.has_api_key ? '🔑 API key saved' : 'Direct lead push'}
            {integration?.last_status ? ` · ${integration.last_status}` : ''}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`w-12 h-7 rounded-full transition relative ${enabled ? 'bg-brand' : 'bg-line'}`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${enabled ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
      <div className="flex gap-2 mt-2.5">
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={integration?.has_api_key ? 'Replace API key…' : 'Paste partner API key…'}
          className={inputCls}
        />
        <button
          onClick={saveKey}
          disabled={busy || !apiKey.trim()}
          className="shrink-0 bg-ink text-cream font-bold text-[12.5px] rounded-xl px-3.5 active:scale-95 transition disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}

// Lead-source hub: the workspace ingest email, Meta Lead Ads form mapping, direct portal
// API integrations, and the live ingestion feed (§1.7, §3.1, §5.2).
export default function LeadSourcesScreen() {
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = () => setRefreshKey((k) => k + 1)
  const { data } = usePoll(() => api.leadSources(), 8000, [refreshKey])
  const { data: portals } = usePoll(() => api.portalIntegrations(), 15000, [refreshKey])
  const [copied, setCopied] = useState(false)
  const [formId, setFormId] = useState('')
  const [formMsg, setFormMsg] = useState(null)

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(data.ingest_email)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }
  const regenerate = async () => {
    await api.regenerateIngest()
    refresh()
  }
  const mapForm = async () => {
    if (!formId.trim()) return
    await api.mapLeadgenForm(formId.trim())
    setFormMsg(`Form ${formId.trim()} now routes to you`)
    setFormId('')
    setTimeout(() => setFormMsg(null), 2500)
  }

  const portalFor = (id) => (portals || []).find((p) => p.portal === id)

  return (
    <div className="mt-4 space-y-4 pb-8">
      {/* Portal ingest email */}
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2">PORTAL LEAD EMAIL</p>
        <p className="text-[12px] text-ink-soft leading-relaxed mb-2.5">
          Set this as your contact email on 99acres, MagicBricks &amp; Housing. Every lead
          notification becomes a lead here — with an instant WhatsApp reply.
        </p>
        <div className="flex items-center gap-2 bg-cream border border-line rounded-xl px-3 py-2.5">
          <code className="text-[12px] text-ink font-semibold truncate flex-1">{data?.ingest_email || '…'}</code>
          <button onClick={copyEmail} className="shrink-0 text-[12px] font-bold text-brand-deep active:scale-95 transition">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <button onClick={regenerate} className="mt-2 text-[11.5px] font-semibold text-ink-faint active:scale-95 transition">
          ↻ Regenerate address
        </button>
      </section>

      {/* Meta Lead Ads */}
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2">FACEBOOK / INSTAGRAM LEAD ADS</p>
        <p className="text-[12px] text-ink-soft leading-relaxed mb-2.5">
          Connect a Lead Ads form so leads flow straight into your pipeline with an instant
          templated WhatsApp message. Paste your form ID to route it to you.
        </p>
        <div className="flex gap-2">
          <input value={formId} onChange={(e) => setFormId(e.target.value)} placeholder="Lead form ID" className={inputCls} />
          <button
            onClick={mapForm}
            disabled={!formId.trim()}
            className="shrink-0 bg-ink text-cream font-bold text-[12.5px] rounded-xl px-3.5 active:scale-95 transition disabled:opacity-40"
          >
            Connect
          </button>
        </div>
        {formMsg && <p className="text-[11.5px] text-brand-deep mt-2">{formMsg}</p>}
      </section>

      {/* Direct portal API integrations */}
      <section>
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2 px-1">DIRECT PORTAL INTEGRATIONS</p>
        <div className="space-y-2.5">
          {PORTALS.map((p) => (
            <PortalRow key={p.id} portal={p} integration={portalFor(p.id)} onSaved={refresh} />
          ))}
        </div>
      </section>

      {/* Ingestion feed */}
      <section>
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2 px-1">RECENT LEAD CAPTURES</p>
        {data && data.events.length === 0 && (
          <p className="text-[12.5px] text-ink-faint px-1">No captured leads yet. Leads from portals, ads and walk-ins appear here.</p>
        )}
        <div className="bg-card rounded-2xl border border-line shadow-card divide-y divide-line">
          {(data?.events || []).map((e) => {
            const meta = CHANNEL_META[e.channel] || { icon: '•', label: e.channel }
            return (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-[17px]">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-bold text-ink truncate">
                    {e.lead_name || e.contact_name || e.contact_phone || 'Lead'}
                    {e.portal ? <span className="text-ink-soft font-semibold"> · {e.portal}</span> : null}
                  </p>
                  <p className="text-[11px] text-ink-soft">
                    {meta.label} · <span className={STATUS_STYLE[e.status] || 'text-ink-soft'}>{e.status}</span>
                    {e.auto_reply_status === 'sent' ? ' · replied' : ''}
                  </p>
                </div>
                <span className="shrink-0 text-[10.5px] text-ink-faint">{fmtAgo(e.created_at)}</span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
