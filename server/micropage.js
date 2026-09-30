// Public property micro-page: a shareable, no-auth HTML page per property.
// Agents drop the /p/:slug link into WhatsApp broker groups; buyers land here
// and tap straight into a WhatsApp chat with the agent.
import { paiseToDisplay } from './money.js'

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

// Only http(s) URLs may be emitted into src/href attributes.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : null)

export function renderMicroPage(p) {
  const spec = [p.bhk && `${p.bhk} BHK`, p.property_type, p.size_sqft && `${p.size_sqft} ${p.size_unit || 'sqft'}`]
    .filter(Boolean)
    .join(' · ')
  const place = [p.locality, p.city].filter(Boolean).join(', ')
  const price = p.price_paise != null ? paiseToDisplay(p.price_paise) : null
  const photos = (Array.isArray(p.photos) ? p.photos : []).map(safeUrl).filter(Boolean).slice(0, 8)
  const waDigits = String(p.agent_wa_number || p.agent_phone || '').replace(/\D/g, '')
  const waText = encodeURIComponent(`Hi ${p.agent_name || ''}, I saw "${p.title}" on HomeNex and I'm interested.`)
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${waText}` : null

  const rows = [
    spec && ['Configuration', spec],
    place && ['Location', place],
    p.facing && ['Facing', p.facing],
    p.floor != null && ['Floor', `${p.floor}${p.total_floors ? ` of ${p.total_floors}` : ''}`],
    p.builder_name && ['Builder', p.builder_name],
    p.status && ['Status', p.status],
  ].filter(Boolean)
  const amenities = (Array.isArray(p.amenities) ? p.amenities : []).filter((a) => typeof a === 'string')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}${place ? ` — ${esc(place)}` : ''} | HomeNex</title>
<meta name="description" content="${esc([spec, place, price].filter(Boolean).join(' · '))}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc([spec, place, price].filter(Boolean).join(' · '))}">
${photos[0] ? `<meta property="og:image" content="${photos[0]}">` : ''}
<style>
  :root { --brand:#0f766e; --ink:#1c1917; --soft:#57534e; --line:#e7e5e4; --bg:#faf9f7; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  .wrap { max-width:520px; margin:0 auto; padding-bottom:110px; }
  .photos { display:flex; overflow-x:auto; gap:6px; scroll-snap-type:x mandatory; background:#111; }
  .photos img { height:290px; min-width:100%; object-fit:cover; scroll-snap-align:center; }
  .body { padding:20px; }
  h1 { font-size:24px; line-height:1.2; }
  .price { font-size:26px; font-weight:800; color:var(--brand); margin-top:8px; }
  .spec { color:var(--soft); margin-top:6px; font-size:15px; }
  .rera { display:inline-block; margin-top:12px; background:#ecfdf5; color:#065f46; font-size:12.5px; font-weight:700; border-radius:999px; padding:5px 12px; }
  table { width:100%; margin-top:18px; border-collapse:collapse; font-size:14.5px; }
  td { padding:9px 0; border-bottom:1px solid var(--line); }
  td:first-child { color:var(--soft); width:42%; }
  .amenities { margin-top:16px; display:flex; flex-wrap:wrap; gap:7px; }
  .amenities span { background:#fff; border:1px solid var(--line); border-radius:999px; padding:5px 12px; font-size:13px; }
  .notes { margin-top:16px; font-size:14.5px; color:var(--soft); white-space:pre-line; }
  .cta { position:fixed; bottom:0; left:0; right:0; padding:14px 20px calc(14px + env(safe-area-inset-bottom)); background:rgba(250,249,247,.95); backdrop-filter:blur(8px); border-top:1px solid var(--line); }
  .cta-inner { max-width:520px; margin:0 auto; }
  .wa { display:flex; align-items:center; justify-content:center; gap:9px; background:#25D366; color:#fff; font-weight:800; font-size:16px; text-decoration:none; border-radius:14px; padding:15px; }
  .agent { text-align:center; font-size:12.5px; color:var(--soft); margin-top:7px; }
  .brand { text-align:center; font-size:11.5px; color:#a8a29e; padding:22px 0 8px; }
  .placeholder { height:180px; display:flex; align-items:center; justify-content:center; font-size:56px; background:#e7e5e4; }
</style>
</head>
<body>
<div class="wrap">
  ${photos.length
    ? `<div class="photos">${photos.map((u) => `<img src="${u}" alt="${esc(p.title)}">`).join('')}</div>`
    : `<div class="placeholder">🏠</div>`}
  <div class="body">
    <h1>${esc(p.title)}</h1>
    ${price ? `<div class="price">${esc(price)}</div>` : ''}
    ${spec || place ? `<div class="spec">${esc([spec, place].filter(Boolean).join(' · '))}</div>` : ''}
    ${p.rera_project_number ? `<div class="rera">✅ RERA: ${esc(p.rera_project_number)}</div>` : ''}
    ${rows.length ? `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
    ${amenities.length ? `<div class="amenities">${amenities.slice(0, 20).map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
    ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
  </div>
  <div class="brand">Powered by HomeNex · A <a href="https://doaide.com" style="color:inherit">DoAide</a> product</div>
</div>
${waLink
    ? `<div class="cta"><div class="cta-inner">
  <a class="wa" href="${waLink}">💬 Chat on WhatsApp</a>
  <div class="agent">${esc(p.agent_name || 'Agent')} · replies fast on WhatsApp</div>
</div></div>`
    : ''}
</body>
</html>`
}
