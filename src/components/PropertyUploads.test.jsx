// Picking a photo or a brochure off the phone — the one part of adding a property
// that leaves the app and touches the device.
//
// None of it had ever run. PhotoPicker, BrochurePicker, downscalePhoto and
// fileToDataUrl were the largest uncovered block in src/, and not because they are
// trivial: between the picker and the server sits a resize whose arithmetic decides
// what an agent's listing photos actually look like, and an object URL that has to be
// released on both the success and the failure path.
//
// The failures worth catching here are the quiet ones. A photo that uploads at full
// 12-megapixel size still *works* — it just costs an agent on a patchy 4G connection
// thirty seconds and a chunk of their data plan, and nothing in the UI says so. An
// upload that fails and leaves the button stuck on "Adding…" reads as a frozen app.
// And a picker that swallows the error tells an agent their photo was saved when it
// was not, which they discover when a buyer opens the listing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, submit, selectFiles } from '../test/render.jsx'
import { installBrowser, installFileApis, mockFetch } from '../test/browserEnv.js'
import { PropertyForm } from './PropertyDetail.jsx'

function setup(t, { upload } = {}) {
  const env = installBrowser()
  const files = installFileApis()
  const net = mockFetch({
    'POST /api/uploads': upload ?? (({ body }) => ({ url: `https://cdn.homenex.in/${body.filename}` })),
  })
  t.after(() => {
    net.restore()
    files.restore()
    env.restore()
  })
  return { env, files, net }
}

const form = (props = {}) => <PropertyForm onSave={() => {}} onCancel={() => {}} {...props} />

// The hidden <input type="file"> the "Add photo" button forwards its click to.
const photoInput = (ui) => ui.get((f) => f.type === 'input' && f.props?.accept === 'image/*', 'photo input')
const brochureInput = (ui) =>
  ui.get((f) => f.type === 'input' && f.props?.accept === 'application/pdf,image/*', 'brochure input')

const openMore = (ui) => click(ui.byText(/More details/))
// "Save property" is a type=submit button, so the handler under test is the form's.
const save = (ui) => submit(ui.get((f) => f.type === 'form', 'the property form'))

// --- The downscale --------------------------------------------------------------

test('a phone-camera photo is resized to the long-edge cap before it is uploaded', async (t) => {
  const { env, net } = setup(t)
  const ui = await render(form())

  // 4000×3000 is an ordinary photo off a mid-range Android, and ~5 MB on the wire.
  await selectFiles(photoInput(ui), [
    { name: 'front.jpg', type: 'image/jpeg', size: 5_000_000, width: 4000, height: 3000 },
  ])

  const canvas = env.created.find((el) => el.tagName === 'CANVAS')
  assert.ok(canvas, 'no canvas was used, so nothing was resized')
  assert.equal(canvas.width, 1280, 'the long edge is capped at 1280')
  assert.equal(canvas.height, 960, 'the aspect ratio is kept — 4:3 in, 4:3 out')
  assert.deepEqual(canvas.drawn, [{ x: 0, y: 0, w: 1280, h: 960 }])
  assert.equal(canvas.encoded.type, 'image/jpeg', 'a PNG here would undo the saving')

  const [sent] = net.to('/api/uploads', 'POST')
  assert.equal(sent.body.filename, 'front.jpg')
  assert.equal(sent.body.mime, 'image/jpeg')
  assert.match(sent.body.data_base64, /scaled-1280x960/, 'the original was uploaded, not the resize')
})

test('a photo already under the cap is not scaled up', async (t) => {
  const { env } = setup(t)
  const ui = await render(form())

  await selectFiles(photoInput(ui), [{ name: 'small.jpg', type: 'image/jpeg', width: 800, height: 600 }])

  const canvas = env.created.find((el) => el.tagName === 'CANVAS')
  assert.equal(canvas.width, 800, 'an 800px photo was enlarged to the cap')
  assert.equal(canvas.height, 600)
})

test('a portrait photo is capped on its height, not blindly on its width', async (t) => {
  const { env } = setup(t)
  const ui = await render(form())

  await selectFiles(photoInput(ui), [{ name: 'tall.jpg', type: 'image/jpeg', width: 3000, height: 4000 }])

  const canvas = env.created.find((el) => el.tagName === 'CANVAS')
  assert.equal(canvas.height, 1280, 'the long edge of a portrait photo is its height')
  assert.equal(canvas.width, 960)
})

// --- Where the photos end up ----------------------------------------------------

test('picked photos are added to the form and posted with it', async (t) => {
  const saved = []
  const { net } = setup(t)
  const ui = await render(form({ onSave: (body) => saved.push(body) }))

  await selectFiles(photoInput(ui), [
    { name: 'a.jpg', type: 'image/jpeg', width: 2000, height: 1000 },
    { name: 'b.jpg', type: 'image/jpeg', width: 2000, height: 1000 },
  ])

  assert.equal(net.to('/api/uploads', 'POST').length, 2, 'both photos were uploaded')
  assert.equal(ui.all((f) => f.type === 'img').length, 2, 'the picked photos are not shown back')

  await save(ui)
  assert.deepEqual(saved[0].photos, ['https://cdn.homenex.in/a.jpg', 'https://cdn.homenex.in/b.jpg'])
})

test('a photo can be removed again before the property is saved', async (t) => {
  const saved = []
  setup(t)
  const ui = await render(form({ onSave: (body) => saved.push(body) }))

  await selectFiles(photoInput(ui), [
    { name: 'keep.jpg', type: 'image/jpeg', width: 900, height: 900 },
    { name: 'drop.jpg', type: 'image/jpeg', width: 900, height: 900 },
  ])
  const removes = ui.all((f) => f.props?.['aria-label'] === 'Remove photo')
  assert.equal(removes.length, 2)
  await click(removes[1])

  await save(ui)
  assert.deepEqual(saved[0].photos, ['https://cdn.homenex.in/keep.jpg'], 'the wrong photo was dropped')
})

test('photos an existing property already has are kept when the form opens to edit', async (t) => {
  const saved = []
  setup(t)
  const ui = await render(
    form({ initial: { title: 'Lakeside', photos: ['https://cdn.homenex.in/old.jpg'] }, onSave: (b) => saved.push(b) }),
  )

  await selectFiles(photoInput(ui), [{ name: 'new.jpg', type: 'image/jpeg', width: 900, height: 900 }])
  await save(ui)

  assert.deepEqual(saved[0].photos, ['https://cdn.homenex.in/old.jpg', 'https://cdn.homenex.in/new.jpg'],
    'editing a property replaced its photos instead of appending')
})

// --- When it goes wrong ----------------------------------------------------------

test('a file that is not a readable image is reported, not silently dropped', async (t) => {
  const { net } = setup(t)
  const ui = await render(form())

  await selectFiles(photoInput(ui), [{ name: 'notes.txt', type: 'image/jpeg', broken: true }])

  assert.match(ui.text(), /isn't an image we can read/)
  assert.equal(net.to('/api/uploads', 'POST').length, 0, 'an undecodable file was still uploaded')
})

test('an upload the server refuses leaves the button usable and says why', async (t) => {
  setup(t, { upload: { status: 413, body: { error: 'That image is too large' } } })
  const ui = await render(form())

  await selectFiles(photoInput(ui), [{ name: 'huge.jpg', type: 'image/jpeg', width: 4000, height: 3000 }])

  assert.match(ui.text(), /too large/, 'the agent is not told why the photo did not attach')
  const add = ui.byText(/Add photo/)
  assert.notEqual(add.props.disabled, true, 'the picker stayed disabled, so it reads as a frozen app')
})

test('the second photo failing still keeps the first, and does not claim both', async (t) => {
  const saved = []
  let n = 0
  setup(t, {
    upload: () =>
      ++n === 1 ? { url: 'https://cdn.homenex.in/one.jpg' } : { status: 413, body: { error: 'Second photo rejected' } },
  })
  const ui = await render(form({ onSave: (b) => saved.push(b) }))

  await selectFiles(photoInput(ui), [
    { name: 'one.jpg', type: 'image/jpeg', width: 900, height: 900 },
    { name: 'two.jpg', type: 'image/jpeg', width: 900, height: 900 },
  ])

  assert.match(ui.text(), /Second photo rejected/)
  await save(ui)
  assert.deepEqual(saved[0].photos, ['https://cdn.homenex.in/one.jpg'],
    'the photo that did upload was lost along with the one that did not')
})

test('every picked photo releases its object URL, on the good and the bad path', async (t) => {
  const { files } = setup(t)
  const ui = await render(form())

  await selectFiles(photoInput(ui), [
    { name: 'ok.jpg', type: 'image/jpeg', width: 2000, height: 1500 },
    { name: 'bad.jpg', type: 'image/jpeg', broken: true },
  ])

  assert.deepEqual(files.leakedObjectUrls, [],
    'a picked photo stayed pinned in memory — 40 of them is a tab the phone kills')
})

test('picking nothing — the cancel out of the gallery — does nothing at all', async (t) => {
  const { net } = setup(t)
  const ui = await render(form())

  await selectFiles(photoInput(ui), [])

  assert.equal(net.to('/api/uploads', 'POST').length, 0)
  assert.doesNotMatch(ui.text(), /Adding…/)
})

// --- The brochure ----------------------------------------------------------------

test('a brochure is read whole and uploaded under its own mime type', async (t) => {
  const saved = []
  const { net } = setup(t)
  const ui = await render(form({ onSave: (b) => saved.push(b) }))
  await openMore(ui)

  await selectFiles(brochureInput(ui), [{ name: 'plan.pdf', type: 'application/pdf' }])

  const [sent] = net.to('/api/uploads', 'POST')
  assert.equal(sent.body.filename, 'plan.pdf')
  assert.equal(sent.body.mime, 'application/pdf', 'a PDF sent as image/jpeg is a PDF nobody can open')
  // Unlike a photo, a brochure is not resized — a downscaled floor plan is unreadable.
  assert.doesNotMatch(sent.body.data_base64, /scaled-/)

  assert.match(ui.text(), /Brochure added — view/)
  await save(ui)
  assert.equal(saved[0].brochure_url, 'https://cdn.homenex.in/plan.pdf')
})

test('a brochure that cannot be read is reported', async (t) => {
  const { net } = setup(t)
  const ui = await render(form())
  await openMore(ui)

  await selectFiles(brochureInput(ui), [{ name: 'locked.pdf', type: 'application/pdf', unreadable: true }])

  assert.match(ui.text(), /Couldn't read that file/)
  assert.equal(net.to('/api/uploads', 'POST').length, 0)
})

test('removing a brochure clears it from what the form saves', async (t) => {
  const saved = []
  setup(t)
  const ui = await render(
    form({ initial: { title: 'Lakeside', brochure_url: 'https://cdn.homenex.in/old.pdf' }, onSave: (b) => saved.push(b) }),
  )

  // An existing brochure opens "More details" for you, so it is not hidden behind a tap.
  assert.match(ui.text(), /Brochure added — view/)
  await click(ui.byText('Remove'))

  assert.doesNotMatch(ui.text(), /Brochure added — view/)
  await save(ui)
  assert.equal(saved[0].brochure_url ?? null, null, 'the removed brochure was saved anyway')
})

test('a stored brochure link that is not http is shown as unopenable, and still removable', async (t) => {
  const saved = []
  setup(t)
  const ui = await render(
    form({ initial: { title: 'Lakeside', brochure_url: 'javascript:alert(1)' }, onSave: (b) => saved.push(b) }),
  )

  assert.match(ui.text(), /Brochure link can't be opened/)
  assert.equal(ui.query((f) => f.type === 'a'), null, 'a javascript: brochure was rendered as a link')

  await click(ui.byText('Remove'))
  await save(ui)
  assert.equal(saved[0].brochure_url ?? null, null)
})
