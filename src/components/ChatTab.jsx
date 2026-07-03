import { useEffect, useRef, useState } from 'react'
import { CHAT_SCRIPT } from '../data.js'

function Tick() {
  return (
    <svg viewBox="0 0 18 12" className="w-[15px] h-[10px] inline-block ml-1" fill="none">
      <path d="M1 6.5 4 9.5 10 2" stroke="#53BDEB" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 6.5 10 9.5 16 2" stroke="#53BDEB" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Bubble({ from, text, time }) {
  const buyer = from === 'buyer'
  return (
    <div className={`flex ${buyer ? 'justify-end' : 'justify-start'} bubble`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 shadow-sm text-[13.5px] leading-snug whitespace-pre-line ${
          buyer ? 'bg-buyer rounded-tr-sm' : 'bg-white rounded-tl-sm'
        }`}
      >
        {text}
        <span className="block text-right text-[10px] text-ink-faint mt-1">
          {time}
          {buyer && <Tick />}
        </span>
      </div>
    </div>
  )
}

export default function ChatTab({ onGoTo }) {
  const [started, setStarted] = useState(false)
  const [messages, setMessages] = useState([])
  const [step, setStep] = useState(0)
  const [aiTyping, setAiTyping] = useState(false)
  const [done, setDone] = useState(false)
  const scrollRef = useRef(null)

  const times = ['6:42 PM', '6:42 PM', '6:43 PM', '6:43 PM', '6:44 PM', '6:44 PM', '6:45 PM', '6:45 PM', '6:46 PM', '6:46 PM']

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, aiTyping, done])

  const sendBuyer = () => {
    if (step >= CHAT_SCRIPT.length || aiTyping) return
    const s = CHAT_SCRIPT[step]
    setMessages((m) => [...m, { from: 'buyer', text: s.buyer, time: times[step * 2] || '6:46 PM' }])
    setAiTyping(true)
    setTimeout(() => {
      setMessages((m) => [...m, { from: 'ai', text: s.ai, time: times[step * 2 + 1] || '6:46 PM' }])
      setAiTyping(false)
      if (step + 1 >= CHAT_SCRIPT.length) setDone(true)
      setStep(step + 1)
    }, 1400 + Math.min(s.ai.length * 4, 1400))
  }

  if (!started) {
    return (
      <div className="px-5 pt-7 pb-4 min-h-[calc(100dvh-96px)] flex flex-col">
        <p className="text-[11px] font-bold tracking-[0.22em] text-brand rise">STEP 1 · PLAY THE BUYER</p>
        <h1 className="font-display text-[30px] font-semibold text-ink leading-[1.12] mt-2 rise rise-1">
          You're Amit — a buyer who just clicked Rajesh's 99acres listing at 6:42 PM on a Sunday.
        </h1>
        <p className="text-[14px] text-ink-soft leading-relaxed mt-3 rise rise-2">
          Rajesh is at dinner with his family. Normally this lead would sit unanswered till morning —
          and call three other brokers meanwhile. Watch what HomeNex does instead.
        </p>

        <div className="mt-6 bg-card rounded-2xl border border-line shadow-card p-4 rise rise-3">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-full bg-brand flex items-center justify-center text-white text-[19px]">🏢</span>
            <div>
              <p className="font-bold text-[14px] text-ink">Kumar Realty <span className="text-[10px] align-middle bg-brand-wash text-brand-deep font-bold rounded px-1 py-0.5 ml-1">✓ Business</span></p>
              <p className="text-[12px] text-ink-soft">Typically replies within 30 seconds ⚡</p>
            </div>
          </div>
        </div>

        <div className="flex-1" />
        <button
          onClick={() => setStarted(true)}
          className="w-full bg-brand hover:bg-brand-deep text-white font-bold text-[15px] rounded-2xl py-4 shadow-float active:scale-[0.98] transition rise rise-4"
        >
          Start the conversation 💬
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-88px)]">
      {/* WhatsApp header */}
      <div className="bg-brand-deep px-4 py-3 flex items-center gap-3 shrink-0">
        <span className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center text-[17px]">🏢</span>
        <div className="flex-1 min-w-0">
          <p className="text-white font-bold text-[14.5px] leading-tight">Kumar Realty</p>
          <p className="text-white/75 text-[11px]">
            {aiTyping ? 'typing…' : 'online · HomeNex AI answering'}
          </p>
        </div>
        <span className="text-[10px] font-bold text-white/90 bg-white/15 rounded-full px-2 py-1">
          BUYER'S VIEW
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar chat-texture px-3 py-3 space-y-2">
        <div className="flex justify-center">
          <span className="text-[10.5px] font-semibold text-ink-soft bg-white/80 rounded-lg px-2.5 py-1 shadow-sm">
            Sunday · 6:42 PM
          </span>
        </div>
        <div className="flex justify-center">
          <span className="text-[10.5px] text-center text-ink-soft bg-amber-wash rounded-lg px-3 py-1.5 shadow-sm max-w-[85%]">
            🔒 Messages are end-to-end encrypted · Rajesh is offline — HomeNex AI is on duty
          </span>
        </div>

        {messages.map((m, i) => (
          <Bubble key={i} {...m} />
        ))}

        {aiTyping && (
          <div className="flex justify-start bubble">
            <div className="bg-white rounded-xl rounded-tl-sm px-4 py-3 shadow-sm flex gap-1.5">
              <span className="typing-dot w-2 h-2 rounded-full bg-ink-faint" />
              <span className="typing-dot w-2 h-2 rounded-full bg-ink-faint" />
              <span className="typing-dot w-2 h-2 rounded-full bg-ink-faint" />
            </div>
          </div>
        )}

        {done && !aiTyping && (
          <div className="bubble pt-2">
            <div className="bg-card border border-brand/25 rounded-2xl shadow-float p-4 text-center">
              <p className="text-[20px]">🎉</p>
              <p className="font-display font-semibold text-[17px] text-ink mt-1">
                Lead qualified in under 3 minutes
              </p>
              <p className="text-[12.5px] text-ink-soft leading-snug mt-1.5">
                While Rajesh was at dinner, HomeNex captured budget, location, timeline and config —
                scored Amit <strong className="text-hot">84/100</strong> and booked a Saturday site visit.
              </p>
              <button
                onClick={() => onGoTo('leads')}
                className="mt-3 w-full bg-brand text-white font-bold text-[13.5px] rounded-xl py-3 active:scale-[0.98] transition"
              >
                See it land in Rajesh's pipeline →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      {!done && (
        <div className="shrink-0 bg-cream border-t border-line px-3 pt-2.5 pb-3">
          {!aiTyping && step < CHAT_SCRIPT.length && (
            <button
              onClick={sendBuyer}
              className="w-full text-left bg-white border-2 border-brand/50 rounded-2xl px-4 py-3 shadow-card active:scale-[0.99] transition"
            >
              <p className="text-[10px] font-bold tracking-[0.15em] text-brand mb-0.5">TAP TO SEND AS AMIT</p>
              <p className="text-[13px] text-ink leading-snug">{CHAT_SCRIPT[step].buyer}</p>
            </button>
          )}
          {aiTyping && (
            <p className="text-center text-[12px] text-ink-faint py-3">HomeNex AI is replying…</p>
          )}
        </div>
      )}
    </div>
  )
}
