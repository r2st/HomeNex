import { useState } from 'react'
import WelcomeModal from './components/WelcomeModal.jsx'
import TodayTab from './components/TodayTab.jsx'
import LeadsTab from './components/LeadsTab.jsx'
import ChatTab from './components/ChatTab.jsx'
import NetworkTab from './components/NetworkTab.jsx'
import InsightsTab from './components/InsightsTab.jsx'
import BottomNav from './components/BottomNav.jsx'

export default function App() {
  const [tab, setTab] = useState('today')
  const [showWelcome, setShowWelcome] = useState(true)

  const startAsBuyer = () => {
    setShowWelcome(false)
    setTab('chat')
  }

  const chooseWelcome = (target) => {
    setShowWelcome(false)
    setTab(target)
  }

  return (
    <div className="phone">
      {showWelcome && (
        <WelcomeModal
          onStart={startAsBuyer}
          onSkip={() => setShowWelcome(false)}
          onChoose={chooseWelcome}
        />
      )}

      <main className="pb-24">
        {tab === 'today' && <TodayTab onGoTo={setTab} />}
        {tab === 'leads' && <LeadsTab />}
        {tab === 'chat' && <ChatTab onGoTo={setTab} />}
        {tab === 'network' && <NetworkTab />}
        {tab === 'insights' && <InsightsTab />}
      </main>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  )
}
