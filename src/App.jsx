import { useEffect, useState } from 'react'
import DashboardTab from './components/DashboardTab.jsx'
import LeadsTab from './components/LeadsTab.jsx'
import LeadDetail from './components/LeadDetail.jsx'
import InboxTab from './components/InboxTab.jsx'
import PropertiesTab from './components/PropertiesTab.jsx'
import MoreTab from './components/MoreTab.jsx'
import AdminPanel from './components/AdminPanel.jsx'
import BottomNav from './components/BottomNav.jsx'
import AuthScreen from './components/AuthScreen.jsx'
import { api, getToken, setToken, offlineQueueSize, flushOfflineQueue } from './api.js'

// Offline status strip: shows when the network is gone and how many actions
// are queued for sync. Queued follow-ups/stage moves replay automatically.
function OfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine)
  const [queued, setQueued] = useState(offlineQueueSize())

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine)
      setQueued(offlineQueueSize())
    }
    const events = ['online', 'offline', 'homenex-queued', 'homenex-queue-flushed']
    events.forEach((e) => window.addEventListener(e, update))
    if (navigator.onLine && offlineQueueSize()) flushOfflineQueue().catch(() => {})
    return () => events.forEach((e) => window.removeEventListener(e, update))
  }, [])

  if (online && !queued) return null
  return (
    <div className={`sticky top-0 z-40 text-center text-[11.5px] font-bold py-1.5 ${online ? 'bg-brand-wash text-brand-deep' : 'bg-amber-wash text-gold'}`}>
      {online ? `Syncing ${queued} offline action${queued === 1 ? '' : 's'}…` : `📴 Offline — viewing cached data${queued ? ` · ${queued} queued` : ''}`}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState('home')
  const [inboxLeadId, setInboxLeadId] = useState(null)
  const [detailLeadId, setDetailLeadId] = useState(null) // lead panel opened from Home
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

  // Listen for internal navigation events (e.g. more -> admin)
  useEffect(() => {
    const onNav = (e) => setTab(e.detail)
    window.addEventListener('homenex-navigate', onNav)
    return () => window.removeEventListener('homenex-navigate', onNav)
  }, [])

  const signOut = () => {
    setToken(null)
    setAgent(null)
    setTab('home')
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
    setDetailLeadId(null)
    setInboxLeadId(leadId)
    setTab('inbox')
  }

  return (
    <div className="phone">
      <OfflineBanner />
      <main className="pb-24">
        {tab === 'home' && (
          <DashboardTab
            agent={agent}
            onGoTo={setTab}
            onOpenConversation={openConversation}
            onOpenLead={setDetailLeadId}
            onSignOut={signOut}
          />
        )}
        {tab === 'leads' && <LeadsTab onOpenConversation={openConversation} />}
        {tab === 'inbox' && <InboxTab leadId={inboxLeadId} onSelectLead={setInboxLeadId} />}
        {tab === 'properties' && <PropertiesTab />}
        {tab === 'more' && (
          <MoreTab agent={agent} onAgentUpdate={setAgent} onOpenConversation={openConversation} />
        )}
        {tab === 'admin' && agent?.is_admin === 1 && (
          <AdminPanel agent={agent} onBack={() => setTab('more')} />
        )}
      </main>

      {detailLeadId && (
        <LeadDetail
          leadId={detailLeadId}
          onClose={() => setDetailLeadId(null)}
          onOpenConversation={openConversation}
        />
      )}

      {tab !== 'admin' && <BottomNav tab={tab} setTab={setTab} />}
    </div>
  )
}
