import { useState } from 'react'
import { NETWORK_MATCHES, NETWORK_FEED } from '../data.js'

export default function NetworkTab() {
  const [proposed, setProposed] = useState({})

  return (
    <div className="px-5 pt-7">
      <header className="rise">
        <h1 className="font-display text-[28px] font-semibold text-ink">Network</h1>
        <p className="text-[13px] text-ink-soft mt-0.5">
          Pune's co-broking exchange · 214 verified brokers
        </p>
      </header>

      <section className="mt-5">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand rise rise-1">
          MATCHES <span className="text-ink-faint font-semibold tracking-normal">— Your buyers ↔ their inventory</span>
        </p>
        <div className="space-y-3 mt-3">
          {NETWORK_MATCHES.map((m, i) => (
            <div key={m.id} className={`bg-card rounded-2xl border border-line shadow-card overflow-hidden rise rise-${i + 2}`}>
              <div className="flex items-center justify-between px-4 pt-3.5">
                <span className="text-[10.5px] font-bold tracking-[0.12em] text-gold bg-amber-wash rounded-full px-2.5 py-1">
                  {m.matchPct}% MATCH
                </span>
                <span className="text-[11px] text-ink-faint font-medium">via HomeNex Network</span>
              </div>

              <div className="px-4 py-3.5">
                <div className="rounded-xl bg-cream border border-line p-3">
                  <p className="text-[10px] font-bold tracking-[0.15em] text-ink-faint">YOUR BUYER</p>
                  <p className="font-bold text-[13.5px] text-ink mt-0.5">{m.yourBuyer}</p>
                  <p className="text-[12px] text-ink-soft">{m.yourNeed}</p>
                </div>
                <div className="flex justify-center -my-2 relative z-10">
                  <span className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center text-[15px] shadow-card border-2 border-card">
                    ↕
                  </span>
                </div>
                <div className="rounded-xl bg-brand-wash border border-brand/20 p-3">
                  <p className="text-[10px] font-bold tracking-[0.15em] text-brand-deep">THEIR INVENTORY</p>
                  <p className="font-bold text-[13.5px] text-ink mt-0.5">{m.theirInventory}</p>
                  <p className="text-[12px] text-ink-soft">
                    {m.theirBroker} · {m.theirFirm}
                  </p>
                </div>
                <p className="text-[11.5px] text-ink-soft leading-snug mt-2.5">{m.note}</p>

                <button
                  onClick={() => setProposed((p) => ({ ...p, [m.id]: true }))}
                  disabled={proposed[m.id]}
                  className={`mt-3 w-full font-bold text-[13.5px] rounded-xl py-3 transition active:scale-[0.98] ${
                    proposed[m.id]
                      ? 'bg-brand-wash text-brand-deep'
                      : 'bg-brand text-white shadow-card'
                  }`}
                >
                  {proposed[m.id] ? '✓ Proposal sent — awaiting ' + m.theirBroker.split(' ')[0] : 'Propose co-broke · 50:50 split'}
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
            LIVE FEED <span className="text-ink-faint font-semibold tracking-normal">— Inventory & requirements</span>
          </p>
        </div>
        <div className="space-y-2.5 mt-3 pb-4">
          {NETWORK_FEED.map((f, i) => (
            <div key={i} className="bg-card rounded-2xl border border-line shadow-card px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-cream border border-line flex items-center justify-center font-display font-bold text-[12px] text-ink-soft">
                  {f.broker.split(' ').map((w) => w[0]).join('')}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[13px] text-ink truncate">
                    {f.broker} <span className="font-medium text-ink-faint">· {f.firm}</span>
                  </p>
                  <p className="text-[11px] text-ink-faint">{f.time}</p>
                </div>
                <span
                  className={`shrink-0 text-[9.5px] font-bold rounded-full px-2 py-0.5 ${
                    f.type === 'INVENTORY'
                      ? 'bg-brand-wash text-brand-deep'
                      : 'bg-amber-wash text-gold'
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
