const TABS = [
  {
    id: 'home',
    label: 'Home',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5" />
        <path d="M9 21v-6h6v6" />
      </svg>
    ),
  },
  {
    id: 'leads',
    label: 'Leads',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <rect x="3" y="4" width="5" height="16" rx="1.2" />
        <rect x="10" y="4" width="5" height="10" rx="1.2" />
        <rect x="17" y="4" width="4" height="13" rx="1.2" />
      </svg>
    ),
  },
  { id: 'inbox', label: 'Inbox', icon: null },
  {
    id: 'properties',
    label: 'Properties',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <path d="M3 21h18" />
        <path d="M5 21V7l7-4 7 4v14" />
        <path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" />
      </svg>
    ),
  },
  {
    id: 'more',
    label: 'More',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    ),
  },
]

export default function BottomNav({ tab, setTab, moreBadge }) {
  return (
    <nav aria-label="Main" className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-card/95 backdrop-blur border-t border-line z-40">
      <div className="grid grid-cols-5 items-end pb-[max(env(safe-area-inset-bottom),8px)] pt-2">
        {TABS.map((t) => {
          const active = tab === t.id
          if (t.id === 'inbox') {
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={active ? 'page' : undefined}
                className="flex flex-col items-center -mt-6"
              >
                <span
                  className={`w-14 h-14 rounded-full flex items-center justify-center shadow-float transition active:scale-95 ${
                    active ? 'bg-brand-deep' : 'bg-brand'
                  }`}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="#0A0A0B" className="w-7 h-7">
                    <path d="M12 2.2C6.6 2.2 2.2 6.4 2.2 11.6c0 1.9.6 3.7 1.6 5.2L2.4 21l4.4-1.3c1.5.9 3.3 1.4 5.2 1.4 5.4 0 9.8-4.2 9.8-9.4S17.4 2.2 12 2.2Zm0 3.1 1.1 2.9 3 .3-2.3 2 .7 3-2.5-1.7-2.5 1.7.7-3-2.3-2 3-.3L12 5.3Z" />
                  </svg>
                </span>
                <span className={`text-[10px] font-bold mt-1 ${active ? 'text-brand-deep' : 'text-brand'}`}>
                  {t.label}
                </span>
              </button>
            )
          }
          const badge = t.id === 'more' ? moreBadge : null
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center gap-1 py-1 transition ${
                active ? 'text-brand-deep' : 'text-ink-faint'
              }`}
            >
              {t.icon}
              {/* Ternary, not `&&`: a numeric 0 badge would render a bare "0" next
                  to the tab icon instead of nothing. */}
              {badge ? (
                <span className="absolute top-0 right-[22%] min-w-[16px] h-[16px] px-1 rounded-full bg-hot text-white text-[9.5px] font-bold flex items-center justify-center leading-none">
                  <span aria-hidden="true">{badge}</span>
                  {/* A bare number reads as "More 3". Say what the 3 is. */}
                  <span className="sr-only">{badge} follow-ups due</span>
                </span>
              ) : null}
              <span className={`text-[10px] ${active ? 'font-bold' : 'font-medium'}`}>{t.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
