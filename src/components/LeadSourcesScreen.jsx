import { useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { inputCls, InfoTip, useConfirm } from './ui.jsx'
import { glossary } from '../lib/glossary.js'
import { ingestStatusLabel, ingestStatusTone } from '../lib/ingestStatus.js'

const PORTALS = [
  { id: '99acres', label: '99acres' },
  { id: 'magicbricks', label: 'MagicBricks' },
  { id: 'housing', label: 'Housing.com' },
  { id: 'nobroker', label: 'NoBroker' },
]

const CHANNEL_META = {
  portal_email: { icon: '📧', label: 'Portal email' },
  portal_api: { icon: '🔌', label: 'Portal connection' },
  meta_lead_ad: { icon: '📣', label: 'Facebook / Instagram ad' },
  ctwa: { icon: '💬', label: 'WhatsApp ad' },
  walk_in: { icon: '🚶', label: 'Walk-in' },
  phone: { icon: '📞', label: 'Phone' },
}

// Ingest status → the colour class for its plain-language label.
const TONE_CLASS = {
  good: 'text-brand-deep',
  muted: 'text-ink-soft',
  faint: 'text-ink-faint',
  warn: 'text-gold',
  bad: 'text-hot',
}

// A single direct-portal API integration row (enable + API key). Power-user only —
// lives inside the "Advanced" section, since a normal agent has no API key.
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
            {integration?.has_api_key ? '🔑 Connection key saved' : 'Leads sent straight to you'}
          </p>
        </div>
        {/* role="switch" + aria-checked, because on/off is conveyed only by the
            knob's position and the track colour — neither of which a screen reader
            or a colour-blind agent can read. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Receive leads from ${portal.label}`}
          onClick={toggle}
          disabled={busy}
          className={`w-12 h-7 rounded-full transition relative ${enabled ? 'bg-brand' : 'bg-line'}`}
        >
          <span aria-hidden="true" className={`absolute top-1 w-5 h-5 rounded-full bg-ink shadow transition-all ${enabled ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
      <div className="flex gap-2 mt-2.5">
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-label={`Connection key for ${portal.label}`}
          placeholder={integration?.has_api_key ? 'Replace connection key…' : 'Paste connection key…'}
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

// Lead-source hub. Leads with the zero-tech copy-the-email flow; the developer-grade
// bits (portal connection keys, ad form id, regenerating the address) live under a
// collapsed "Advanced" section so the default screen stays layman-simple.
export default function LeadSourcesScreen() {
  const { data, error, loading, refresh: refreshSources } = usePoll(() => api.leadSources(), 8000, [])
  const { data: portals, refresh: refreshPortals } = usePoll(() => api.portalIntegrations(), 15000, [])
  const refresh = () => {
    refreshSources()
    refreshPortals()
  }
  const [copied, setCopied] = useState(false)
  const [formId, setFormId] = useState('')
  const [formMsg, setFormMsg] = useState(null)
  const [advanced, setAdvanced] = useState(false)
  const confirm = useConfirm()

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(data.ingest_email)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }
  const regenerate = () =>
    confirm({
      title: 'Make a new lead email?',
      message:
        'This creates a new email address and stops the old one working. You will need to update it on every portal where you pasted the old one.',
      confirmLabel: 'Make new email',
      danger: true,
      onConfirm: async () => {
        await api.regenerateIngest()
        refresh()
      },
    })
  const mapForm = async () => {
    if (!formId.trim()) return
    await api.mapLeadgenForm(formId.trim())
    setFormMsg('Your Facebook / Instagram ad now sends leads to you')
    setFormId('')
    setTimeout(() => setFormMsg(null), 2500)
  }

  const portalFor = (id) => (portals || []).find((p) => p.portal === id)

  return (
    <div className="mt-4 space-y-4 pb-8">
      {/* Portal ingest email — the zero-tech way to get portal leads. */}
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2 flex items-center gap-1.5">
          YOUR LEAD EMAIL <InfoTip label="" text={glossary.PORTAL_EMAIL} align="left" />
        </p>
        <p className="text-[12px] text-ink-soft mb-2.5">
          Paste on 99acres, MagicBricks &amp; Housing — leads auto-capture with instant WhatsApp replies.
        </p>
        <div className="flex items-center gap-2 bg-cream border border-line rounded-xl px-3 py-2.5">
          <code className="text-[12px] text-ink font-semibold truncate flex-1">{data?.ingest_email || '…'}</code>
          <button onClick={copyEmail} className="shrink-0 text-[12px] font-bold text-brand-deep active:scale-95 transition">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </section>

      {/* Facebook / Instagram ads — friendly explanation; the technical form id is in Advanced. */}
      <section className="bg-card rounded-2xl border border-line shadow-card p-4">
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2 flex items-center gap-1.5">
          FACEBOOK / INSTAGRAM ADS <InfoTip label="" text={glossary.LEAD_ADS} align="left" />
        </p>
        <p className="text-[12px] text-ink-soft">
          Connect your ad account to auto-capture every enquiry. Set up in Advanced below.
        </p>
      </section>

      {/* Ingestion feed */}
      <section>
        <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft mb-2 px-1">RECENT LEADS CAPTURED</p>
        {/* "No captured leads yet" is a claim about the agent's portal setup — it must
            not be what a failed or in-flight request looks like. */}
        {error && !data && (
          <p className="text-[12.5px] text-hot bg-amber-wash rounded-xl px-4 py-3">
            Can't load your captured leads: {error.message}
          </p>
        )}
        {loading && !data && !error && (
          <p className="text-[12.5px] text-ink-faint px-1" aria-busy="true">
            Loading captured leads…
          </p>
        )}
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
                    {meta.label} · <span className={TONE_CLASS[ingestStatusTone(e.status)] || 'text-ink-soft'}>{ingestStatusLabel(e.status)}</span>
                    {e.auto_reply_status === 'sent' ? ' · replied' : ''}
                  </p>
                </div>
                <span className="shrink-0 text-[10.5px] text-ink-faint">{fmtAgo(e.created_at)}</span>
              </div>
            )
          })}
        </div>
      </section>

      {/* Advanced — power-user connections most agents never touch. */}
      <section className="bg-card rounded-2xl border border-line shadow-card overflow-hidden">
        <button onClick={() => setAdvanced((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 active:scale-[0.99] transition">
          <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft">ADVANCED SETTINGS</span>
          <span className="text-ink-faint text-[13px]">{advanced ? '▲' : '▼'}</span>
        </button>
        {advanced && (
          <div className="px-4 pb-4 space-y-4">
            {/* Facebook / Instagram ad form mapping */}
            <div>
              <p className="text-[11.5px] font-bold text-ink mb-1.5">Connect a Facebook / Instagram ad form</p>
              <p className="text-[11px] text-ink-soft mb-2">
                Paste the form ID from Meta Ads Manager.
              </p>
              <div className="flex gap-2">
                <input value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="Facebook or Instagram ad form id" placeholder="Ad form id" className={inputCls} />
                <button
                  onClick={mapForm}
                  disabled={!formId.trim()}
                  className="shrink-0 bg-ink text-cream font-bold text-[12.5px] rounded-xl px-3.5 active:scale-95 transition disabled:opacity-40"
                >
                  Connect
                </button>
              </div>
              {formMsg && <p className="text-[11.5px] text-brand-deep mt-2">{formMsg}</p>}
            </div>

            {/* Direct portal API integrations */}
            <div>
              <p className="text-[11.5px] font-bold text-ink mb-1.5 flex items-center gap-1.5">
                Connect a portal account directly <InfoTip label="" text={glossary.API_KEY} align="left" />
              </p>
              <div className="space-y-2.5">
                {PORTALS.map((p) => (
                  <PortalRow key={p.id} portal={p} integration={portalFor(p.id)} onSaved={refresh} />
                ))}
              </div>
            </div>

            {/* Regenerate ingest address — destructive, gated by a Confirm. */}
            <div className="border-t border-line pt-3">
              <button onClick={regenerate} className="text-[11.5px] font-semibold text-ink-faint active:scale-95 transition">
                ↻ Make a new lead email
              </button>
              <p className="text-[10.5px] text-ink-faint mt-1 leading-snug">
                Only if your current address is being spammed — you'll have to update it on every portal.
              </p>
            </div>
          </div>
        )}
      </section>
      {confirm.dialog}
    </div>
  )
}
