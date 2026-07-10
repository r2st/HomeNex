import { StatusBadge } from '../components.jsx'

// Placeholder: message-template management will talk to Meta's template APIs.
const SAMPLE_TEMPLATES = [
  { id: 1, name: 'welcome_new_lead', category: 'UTILITY', language: 'en', status: 'active', body: 'Hi {{1}}, thanks for your interest! I\'m {{2}} from HomeNex. What kind of property are you looking for?' },
  { id: 2, name: 'site_visit_reminder', category: 'UTILITY', language: 'en', status: 'pending', body: 'Reminder: your site visit for {{1}} is scheduled on {{2}} at {{3}}.' },
  { id: 3, name: 'new_listing_alert', category: 'MARKETING', language: 'en', status: 'none', body: 'New listing in {{1}}: {{2}} at {{3}}. Reply YES for details.' },
]

export default function Templates() {
  return (
    <>
      <h1 className="page-title">Template Management</h1>
      <p className="page-sub">WhatsApp message templates and Meta approval workflow</p>

      <div className="placeholder-note" style={{ marginBottom: 16 }}>
        Placeholder — template CRUD and the Meta approval workflow are not wired up yet.
        The list below is sample data showing the planned layout.
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Template</th>
              <th>Category</th>
              <th>Language</th>
              <th>Approval</th>
              <th>Body</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_TEMPLATES.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.name}</td>
                <td>{t.category}</td>
                <td>{t.language}</td>
                <td><StatusBadge status={t.status} /></td>
                <td style={{ whiteSpace: 'normal', maxWidth: 380 }}><span className="sub">{t.body}</span></td>
                <td>
                  <button className="btn secondary sm" disabled title="Coming soon">Submit for approval</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 14 }}>
        <button className="btn" disabled title="Coming soon">+ New template</button>
      </p>
    </>
  )
}
