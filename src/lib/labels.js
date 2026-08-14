// One place that turns internal slugs/codes into the plain words an agent reads.
// Never show a raw slug (buy_primary, resale, expected, no_show, payer ?) in the
// UI — route it through a map here so the same code reads the same everywhere and
// the mapping is unit-tested. Pure — no React.

// A tiny Title-case helper for slugs we don't have an explicit label for, so an
// unknown value still reads as "Some Thing" instead of "some_thing".
export function titleCase(slug) {
  if (slug == null || slug === '') return ''
  return String(slug)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Generic lookup: return the mapped label, else a Title-cased fallback, else `dflt`.
function labelFrom(map, slug, dflt = '') {
  if (slug == null || slug === '') return dflt
  return map[String(slug)] || titleCase(slug)
}

// Lead pipeline (buyer journey). Shared with LeadDetail's header + contact leads.
export const PIPELINE_LABEL = {
  buy_primary: 'Buy (Primary)',
  buy_resale: 'Buy (Resale)',
  rental: 'Rental',
}
export const pipelineLabel = (slug) => labelFrom(PIPELINE_LABEL, slug, 'Buy (Primary)')

// Deal type badge on the Deals list.
const DEAL_TYPE_LABEL = {
  primary: 'New booking',
  resale: 'Resale',
  rental: 'Rental',
}
export const dealTypeLabel = (slug) => labelFrom(DEAL_TYPE_LABEL, slug)

// Deal lifecycle status.
const DEAL_STATUS_LABEL = {
  open: 'In progress',
  won: 'Won',
  lost: 'Lost',
}
export const dealStatusLabel = (slug) => labelFrom(DEAL_STATUS_LABEL, slug)

// Commission status — what stage the money is at.
const COMMISSION_STATUS_LABEL = {
  expected: 'Expected',
  invoiced: 'Invoiced',
  overdue: 'Overdue',
  received: 'Received',
}
export const commissionStatusLabel = (slug) => labelFrom(COMMISSION_STATUS_LABEL, slug)

// GST invoice status.
const INVOICE_STATUS_LABEL = {
  issued: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}
export const invoiceStatusLabel = (slug) => labelFrom(INVOICE_STATUS_LABEL, slug)

// Who pays the brokerage. `payer_type` is often empty on a fresh commission — never
// show the old "payer ?" debug placeholder; say it plainly instead.
const PAYER_LABEL = {
  builder: 'Paid by builder',
  buyer: 'Paid by buyer',
  seller: 'Paid by seller',
  owner: 'Paid by owner',
  tenant: 'Paid by tenant',
}
export const payerLabel = (slug) => labelFrom(PAYER_LABEL, slug, 'Payer not set')

// Site-visit status. We keep the full set for the picker but expose friendly words.
const VISIT_STATUS_LABEL = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  completed: 'Done',
  no_show: 'No-show',
  rescheduled: 'Rescheduled',
}
export const visitStatusLabel = (slug) => labelFrom(VISIT_STATUS_LABEL, slug)

// Support ticket category — friendlier than the raw enum in the picker/rows.
const TICKET_CATEGORY_LABEL = {
  general: 'General',
  billing: 'Billing',
  whatsapp: 'WhatsApp number',
  technical: "Something's not working",
  feature_request: 'Idea / request',
}
export const ticketCategoryLabel = (slug) => labelFrom(TICKET_CATEGORY_LABEL, slug)

// Support ticket status.
const TICKET_STATUS_LABEL = {
  open: 'Open',
  pending: 'Waiting on us',
  closed: 'Closed',
}
export const ticketStatusLabel = (slug) => labelFrom(TICKET_STATUS_LABEL, slug)

// Buyer "temperature" (interest level). The emoji already carries the heat; this
// gives the matching word so we can drop the raw n/100 score in list views.
const TEMP_LABEL = {
  Hot: { icon: '🔥', word: 'Hot' },
  Warm: { icon: '☀️', word: 'Warm' },
  Cold: { icon: '❄️', word: 'Cold' },
}
export function tempBadge(temp) {
  return TEMP_LABEL[temp] || TEMP_LABEL.Cold
}
