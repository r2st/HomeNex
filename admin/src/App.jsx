import { useEffect, useState } from 'react'
import { api, getToken, setToken } from './api.js'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Agents from './pages/Agents.jsx'
import AgentDetail from './pages/AgentDetail.jsx'
import Waba from './pages/Waba.jsx'
import Templates from './pages/Templates.jsx'

// Tiny hash router: '#/agents/12' -> ['agents', '12']. Keeps the site
// dependency-free and works when served statically at /admin.
function useHashRoute() {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const onChange = () => setRoute(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

const NAV = [
  { hash: '#/', label: 'Dashboard', match: (r) => r.length === 0 },
  { hash: '#/agents', label: 'Agents', match: (r) => r[0] === 'agents' },
  { hash: '#/waba', label: 'WABA Management', match: (r) => r[0] === 'waba' },
  { hash: '#/templates', label: 'Templates', match: (r) => r[0] === 'templates' },
]

export default function App() {
  const route = useHashRoute()
  const [me, setMe] = useState(null)
  const [checking, setChecking] = useState(Boolean(getToken()))

  useEffect(() => {
    const onLogout = () => setMe(null)
    window.addEventListener('admin-logout', onLogout)
    return () => window.removeEventListener('admin-logout', onLogout)
  }, [])

  useEffect(() => {
    if (!getToken()) return
    api
      .me()
      .then((agent) => {
        if (agent.is_admin === 1) setMe(agent)
        else setToken(null)
      })
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  const logout = () => {
    setToken(null)
    setMe(null)
  }

  if (checking) return null
  if (!me) return <Login onLogin={setMe} />

  let page
  if (route.length === 0) page = <Dashboard />
  else if (route[0] === 'agents' && route[1]) page = <AgentDetail id={route[1]} />
  else if (route[0] === 'agents') page = <Agents />
  else if (route[0] === 'waba') page = <Waba />
  else if (route[0] === 'templates') page = <Templates />
  else page = <Dashboard />

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          Home<span>Nex</span> Admin
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.hash} href={n.hash} className={n.match(route) ? 'active' : ''}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="user">
          <div className="name">{me.name}</div>
          <div>{me.email || me.phone}</div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  )
}
