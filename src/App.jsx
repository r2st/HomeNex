import { useEffect, useState } from 'react'
import TodayTab from './components/TodayTab.jsx'
import LeadsTab from './components/LeadsTab.jsx'
import InboxTab from './components/InboxTab.jsx'
import ClientsTab from './components/ClientsTab.jsx'
import InsightsTab from './components/InsightsTab.jsx'
import SettingsTab from './components/SettingsTab.jsx'
import AdminPanel from './components/AdminPanel.jsx'
import BottomNav from './components/BottomNav.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import { api, getToken, setToken } from './api.js'

export default function App() {
  const [tab, setTab] = useState('today')
  const [inboxLeadId, setInboxLeadId] = useState(null)
  const [agent, setAgent] = useState(undefined) // undefined = checking, null = logged out

  useEffect(() => {
    if (!getToken()) return setAgent(null)
    api.me().then(setAgent).catch(() => setAgent(null))
  }, [])

  useEffect(() => {
    const onLogout = () => setAgent(null)
    window.addEventListener('homenex-logout', onLogout)
    return () => window.removeEventListener('homenex-logout', onLogout)
  }, [])

  // Listen for internal navigation events (e.g. settings -> admin)
  useEffect(() => {
    const onNav = (e) => setTab(e.detail)
    window.addEventListener('homenex-navigate', onNav)
    return () => window.removeEventListener('homenex-navigate', onNav)
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
      <main className="pb-24">
        {tab === 'today' && (
          <TodayTab agent={agent} onGoTo={setTab} onOpenConversation={openConversation} onSignOut={signOut} />
        )}
        {tab === 'leads' && <LeadsTab onOpenConversation={openConversation} />}
        {tab === 'inbox' && <InboxTab leadId={inboxLeadId} onSelectLead={setInboxLeadId} />}
        {tab === 'clients' && <ClientsTab />}
        {tab === 'insights' && <InsightsTab />}
        {tab === 'settings' && <SettingsTab agent={agent} onAgentUpdate={setAgent} />}
        {tab === 'admin' && agent?.is_admin === 1 && <AdminPanel onBack={() => setTab('settings')} />}
      </main>

      {tab !== 'admin' && <BottomNav tab={tab} setTab={setTab} />}
    </div>
  )
}
