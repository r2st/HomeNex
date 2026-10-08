// One place for every plain-language explanation of a technical term, so the same
// jargon reads the same everywhere and the InfoTip (ⓘ) copy is written once. Each
// entry is one sentence a first-time agent understands — no acronyms left unexpanded.
// Use via the InfoTip primitive:  <InfoTip label="RERA" text={glossary.RERA} />

export const glossary = {
  RERA:
    'RERA is the government real-estate regulator. Marketing messages must carry your RERA registration number — DoAide Realty adds it for you.',
  WABA:
    'Your WhatsApp Business number is the number buyers message. Messages to it are saved as leads automatically and get instant replies.',
  WHATSAPP_BUSINESS:
    'Your WhatsApp Business number is the number buyers message. Messages to it are saved as leads automatically and get instant replies.',
  SERVICE_WINDOW:
    'WhatsApp only lets you send a free reply within 24 hours of the buyer\'s last message. After that, you send an approved template instead.',
  TEMPLATE:
    'A template is a pre-written message WhatsApp has approved. Use it to message a buyer after the 24-hour free-reply window closes.',
  CTWA:
    'This lead came from a "Click to WhatsApp" ad — they tapped your ad and it opened a chat. You can message them free for 72 hours.',
  LEAD_ADS:
    'A lead that came in from a Facebook or Instagram ad form, pulled into DoAide Realty automatically.',
  SYNDICATION:
    'Post the same property to portals like 99acres, MagicBricks and Housing without re-typing — DoAide Realty formats it for each one.',
  PORTAL:
    'A property website like 99acres, MagicBricks, Housing or NoBroker where buyers find listings.',
  OPT_IN:
    'Whether this contact has agreed to receive your WhatsApp messages. WhatsApp can limit sending to people who haven\'t opted in.',
  AUTO_REPLY:
    'DoAide Realty\'s AI answers new buyer messages for you, day and night. Take over any chat any time and it stops replying there.',
  MICRO_PAGE:
    'A ready-made web page for a property you can share in any chat or group. You see how many people open it.',
  PIPELINE:
    'The stages a buyer moves through — from a new enquiry to a closed deal. Drag a lead along as things progress.',
  GST:
    'GST is the tax added to your brokerage invoice. DoAide Realty works out the split (CGST/SGST or IGST) for you.',
  BLTC:
    'The four things a buyer needs pinned down before they can decide: budget, location, timeline and home type.',
  PORTAL_EMAIL:
    'A private email address just for you. Set it as your contact email on 99acres, MagicBricks and Housing, and every lead notification becomes a lead here automatically.',
  API_KEY:
    'A secret code a property portal gives you to connect your account directly. Most agents never need this — use the lead email instead.',
}

// Look up a term case-insensitively; returns undefined if we have no explanation.
export function explain(term) {
  if (!term) return undefined
  const key = String(term).toUpperCase().replace(/[^A-Z]/g, '_')
  return glossary[key]
}
