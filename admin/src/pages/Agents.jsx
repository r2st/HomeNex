import { useEffect, useState } from 'react'
import { api, fmtDate, fmtAgo } from '../api.js'
import { StatusBadge, WabaFilter, Pager } from '../components.jsx'

const PAGE_SIZE = 20

export default function Agents() {
  const [data, setData] = useState(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [error, setError] = useState(null)

  // Debounce search so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .agents({ search, status, page, pageSize: PAGE_SIZE })
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e) => setError(e.message))
    }, search ? 250 : 0)
    return () => clearTimeout(t)
  }, [search, status, page])

  const changeFilter = (fn) => (v) => {
    setPage(1)
    fn(v)
  }

  return (
    <>
      <h1 className="page-title">Agents</h1>
      <p className="page-sub">All registered agents on the platform</p>

      <div className="toolbar">
        <input
          type="search"
          aria-label="Search agents by name, email or phone"
          placeholder="Search name, email or phone…"
          value={search}
          onChange={(e) => changeFilter(setSearch)(e.target.value)}
        />
        <WabaFilter value={status} onChange={changeFilter(setStatus)} />
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Signed up</th>
              <th>WABA status</th>
              <th>Leads</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {data?.agents.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => (window.location.hash = `#/agents/${a.id}`)}>
                <td>
                  {a.name} {a.is_admin === 1 && <span className="badge admin">admin</span>}
                </td>
                <td>{a.email || <span className="sub">—</span>}</td>
                <td className="mono">{a.phone}</td>
                <td>{fmtDate(a.created_at)}</td>
                <td>
                  <StatusBadge status={a.waba_status} />
                </td>
                <td>{a.lead_count}</td>
                <td>{fmtAgo(a.last_active)}</td>
              </tr>
            ))}
            {data && data.agents.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">No agents match this search.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && <Pager page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />}
    </>
  )
}
