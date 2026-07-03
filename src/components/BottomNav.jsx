const TABS = [
  {
    id: 'today',
    label: 'Today',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
        <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
        <path d="M17.5 15.3c2 .7 3.5 2.3 4 4.7" />
      </svg>
    ),
  },
  { id: 'chat', label: 'HomeNex AI', icon: null },
  {
    id: 'network',
    label: 'Network',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <circle cx="5.5" cy="12" r="2.5" />
        <circle cx="18.5" cy="5.5" r="2.5" />
        <circle cx="18.5" cy="18.5" r="2.5" />
        <path d="M7.8 10.8 16.2 6.6M7.8 13.2l8.4 4.2" />
      </svg>
    ),
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
        <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
      </svg>
    ),
  },
]

export default function BottomNav({ tab, setTab }) {
  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-card/95 backdrop-blur border-t border-line z-40">
      <div className="grid grid-cols-5 items-end pb-[max(env(safe-area-inset-bottom),8px)] pt-2">
        {TABS.map((t) => {
          const active = tab === t.id
          if (t.id === 'chat') {
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className="flex flex-col items-center -mt-6">
                <span
                  className={`w-14 h-14 rounded-full flex items-center justify-center shadow-float transition active:scale-95 ${
                    active ? 'bg-brand-deep' : 'bg-brand'
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill="white" className="w-7 h-7">
                    <path d="M12 2.2C6.6 2.2 2.2 6.4 2.2 11.6c0 1.9.6 3.7 1.6 5.2L2.4 21l4.4-1.3c1.5.9 3.3 1.4 5.2 1.4 5.4 0 9.8-4.2 9.8-9.4S17.4 2.2 12 2.2Zm0 3.1 1.1 2.9 3 .3-2.3 2 .7 3-2.5-1.7-2.5 1.7.7-3-2.3-2 3-.3L12 5.3Z" />
                  </svg>
                </span>
                <span className={`text-[10px] font-bold mt-1 ${active ? 'text-brand-deep' : 'text-brand'}`}>
                  {t.label}
                </span>
              </button>
            )
          }
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-col items-center gap-1 py-1 transition ${
                active ? 'text-brand-deep' : 'text-ink-faint'
              }`}
            >
              {t.icon}
              <span className={`text-[10px] ${active ? 'font-bold' : 'font-medium'}`}>{t.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
