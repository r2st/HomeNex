import { useState } from 'react'
import TodayTab from './components/TodayTab.jsx'
import LeadsTab from './components/LeadsTab.jsx'
import InboxTab from './components/InboxTab.jsx'
import NetworkTab from './components/NetworkTab.jsx'
import InsightsTab from './components/InsightsTab.jsx'
import BottomNav from './components/BottomNav.jsx'
import { api, usePoll } from './api.js'

export default function App() {
  const [tab, setTab] = useState('today')
  const [inboxLeadId, setInboxLeadId] = useState(null)
  const { data: health } = usePoll(api.health, 15000)

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
        {tab === 'today' && <TodayTab onGoTo={setTab} onOpenConversation={openConversation} />}
        {tab === 'leads' && <LeadsTab onOpenConversation={openConversation} />}
        {tab === 'inbox' && <InboxTab leadId={inboxLeadId} onSelectLead={setInboxLeadId} />}
        {tab === 'network' && <NetworkTab />}
        {tab === 'insights' && <InsightsTab />}
      </main>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  )
}
