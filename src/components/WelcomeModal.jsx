const TRY_CARDS = [
  {
    n: '1',
    title: 'Play the buyer',
    body: 'Chat with HomeNex on WhatsApp — it qualifies you in 2 minutes',
    target: 'chat',
  },
  {
    n: '2',
    title: 'Watch the lead land',
    body: 'Scored, summarised and slotted into your pipeline, live',
    target: 'leads',
  },
  {
    n: '3',
    title: 'Close via the network',
    body: "Match it with another broker's exclusive inventory, 50:50",
    target: 'network',
  },
]

export default function WelcomeModal({ onStart, onSkip, onChoose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/60 backdrop-blur-sm">
      <div className="w-full max-w-[480px] sm:max-w-[420px] bg-cream rounded-t-3xl sm:rounded-3xl px-6 pt-8 pb-7 shadow-float rise">
        <p className="text-[11px] font-bold tracking-[0.22em] text-brand mb-4">
          HOMENEX · PRODUCT DEMO
        </p>
        <h1 className="font-display text-[32px] leading-[1.08] font-semibold text-ink mb-3">
          Every lead answered in 30&nbsp;seconds. Even at 2&nbsp;AM.
        </h1>
        <p className="text-[14px] leading-relaxed text-ink-soft mb-6">
          You're <strong className="text-ink">Rajesh Kumar</strong>, a broker in Pune. HomeNex AI
          works your WhatsApp while you're on site visits. Three things to try:
        </p>

        <div className="space-y-2.5 mb-7">
          {TRY_CARDS.map((c, i) => (
            <button
              key={c.n}
              onClick={() => onChoose(c.target)}
              className={`w-full text-left flex items-start gap-3.5 bg-card rounded-2xl border border-line px-4 py-3.5 shadow-card transition active:scale-[0.98] hover:border-brand/40 rise rise-${i + 1}`}
            >
              <span className="shrink-0 w-7 h-7 rounded-full bg-brand-wash text-brand font-display font-bold text-sm flex items-center justify-center mt-0.5">
                {c.n}
              </span>
              <div className="flex-1">
                <p className="font-bold text-[14px] text-ink">{c.title}</p>
                <p className="text-[12.5px] text-ink-soft leading-snug mt-0.5">{c.body}</p>
              </div>
              <span className="shrink-0 text-ink-faint mt-1">→</span>
            </button>
          ))}
        </div>

        <button
          onClick={onStart}
          className="w-full bg-brand hover:bg-brand-deep active:scale-[0.98] transition text-white font-bold text-[15px] rounded-2xl py-4 shadow-float"
        >
          Start as the buyer →
        </button>
        <button
          onClick={onSkip}
          className="w-full text-center text-[13px] text-ink-faint underline underline-offset-4 mt-4"
        >
          Skip — explore the broker app freely
        </button>
      </div>
    </div>
  )
}
