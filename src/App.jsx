import { useEffect, useState } from 'react'
import TodayTab from './components/TodayTab.jsx'
import LeadsTab from './components/LeadsTab.jsx'
import InboxTab from './components/InboxTab.jsx'
import NetworkTab from './components/NetworkTab.jsx'
import InsightsTab from './components/InsightsTab.jsx'
import BottomNav from './components/BottomNav.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import { api, usePoll, getToken, setToken } from './api.js'

export default function App() {
  const [tab, setTab] = useState('today')
  const [inboxLeadId, setInboxLeadId] = useState(null)
  const [agent, setAgent] = useState(undefined) // undefined = checking, null = logged out
  const { data: health } = usePoll(api.health, 15000)

  useEffect(() => {
    if (!getToken()) return setAgent(null)
    api.me().then(setAgent).catch(() => setAgent(null))
  }, [])

  useEffect(() => {
    const onLogout = () => setAgent(null)
    window.addEventListener('homenex-logout', onLogout)
    return () => window.removeEventListener('homenex-logout', onLogout)
  }, [])

  const signOut = () => {
    setToken(null)
    setAgent(null)
    setTab('today')
    setInboxLeadId(null)
  }

  if (agent === undefined) {
    return (
      <div className="phone flex items-center justify-center">
        <p className="text-[13px] text-ink-faint">Loading…</p>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="phone">
        <AuthScreen onAuthed={setAgent} />
      </div>
    )
  }

  const openConversation = (leadId) => {
    setInboxLeadId(leadId)
    setTab('inbox')
  }

  return (
    <div className="phone">
      {health && (!health.whatsapp || !health.ai) && (
        <div className="bg-amber-wash border-b border-amber/30 px-5 py-2.5">
          <p className="text-[12px] text-gold leading-snug">
            <strong>Setup needed:</strong>{' '}
            {!health.whatsapp && 'WhatsApp credentials'}
            {!health.whatsapp && !health.ai && ' and '}
            {!health.ai && 'OpenRouter API key'} missing in <code>server/.env</code> —{' '}
            {!health.whatsapp ? 'sends are disabled' : 'AI replies are disabled'}.
          </p>
        </div>
      )}

      <main className="pb-24">
        {tab === 'today' && (
          <TodayTab agent={agent} onGoTo={setTab} onOpenConversation={openConversation} onSignOut={signOut} />
        )}
        {tab === 'leads' && <LeadsTab onOpenConversation={openConversation} />}
        {tab === 'inbox' && <InboxTab leadId={inboxLeadId} onSelectLead={setInboxLeadId} />}
        {tab === 'network' && <NetworkTab />}
        {tab === 'insights' && <InsightsTab />}
      </main>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  )
}
