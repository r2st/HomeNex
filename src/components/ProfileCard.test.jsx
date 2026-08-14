// The agent's own profile card.
//
// Two things here are worth pinning. The first is the save itself: this is the only
// screen that writes name, email, business name, city, RERA id and bio, and the RERA
// id in particular ends up on every micro-page an agent shares with a buyer — a save
// that silently dropped a field would be visible to their clients before it was
// visible to them.
//
// The second is the avatar. It is downscaled in the browser before it is sent, which
// means a canvas, an Image and an object URL — three things that can each fail on a
// real phone with a real camera photo. The component has one error string for all of
// it, and the agent needs to see it rather than watch a photo quietly not attach.
import test from 'node:test'
import assert from 'node:assert/strict'
import { act, render, click, change, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ProfileCard from './ProfileCard.jsx'

const AGENT = {
  id: 1,
  name: 'Rohit Sharma',
  email: 'rohit@example.com',
  business_name: 'Sharma Realty',
  city: 'Pune',
  rera_id: 'A52100012345',
  bio: 'Ten years in Baner and Balewadi.',
  avatar_url: null,
}

// The browser bits the avatar downscaler reaches for. `decode` decides whether the
// image "loads" or fails, so both arms of toAvatarDataUrl are drivable.
function installImaging({ decode = true, dataUrl = 'data:image/jpeg;base64,SCALED' } = {}) {
  const revoked = []
  const saved = new Map()
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }

  // A subclass, not a plain object with the two statics on it: mockFetch parses every
  // request with `new URL(...)`, so a non-constructable stand-in would make every save
  // in this file fail for a reason that has nothing to do with the component.
  const RealURL = globalThis.URL
  define(
    'URL',
    class TestURL extends RealURL {
      static createObjectURL = () => 'blob:fake'
      static revokeObjectURL = (u) => revoked.push(u)
    },
  )
  define(
    'Image',
    class FakeImage {
      set src(_v) {
        // The real Image decodes asynchronously; a microtask is enough to keep the
        // component's await ordering honest.
        queueMicrotask(() => (decode ? this.onload?.() : this.onerror?.()))
      }
      width = 800
      height = 600
    },
  )
  globalThis.document.createElement = (tag) => ({
    tagName: tag.toUpperCase(),
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => dataUrl,
  })

  return {
    revoked,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

function setup(t, { agent = AGENT, routes = {} } = {}) {
  const env = installBrowser()
  const net = mockFetch({ 'PUT /api/agent/profile': (call) => ({ ...agent, ...call.body }), ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net, agent }
}

const saveButton = (ui) => ui.byText(/Save profile|Saving/, { selector: 'button' })
// The card IS the form, and the save button is type="submit" — so a save is fired at
// the form, the way the browser would.
const formOf = (ui) => ui.get((f) => f.type === 'form', 'profile form')

test('the card opens with the agent it was handed, not an empty form', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)

  assert.equal(ui.byLabel('Full name').props.value, 'Rohit Sharma')
  assert.equal(ui.byLabel('Email').props.value, 'rohit@example.com')
  assert.equal(ui.byLabel('Business name').props.value, 'Sharma Realty')
  assert.equal(ui.byLabel('City').props.value, 'Pune')
  assert.equal(ui.byLabel('RERA registration ID').props.value, 'A52100012345')
  assert.equal(ui.byLabel('About you').props.value, 'Ten years in Baner and Balewadi.')
})

test('an agent with nothing filled in yet gets empty strings, never "undefined"', async (t) => {
  setup(t, { agent: { id: 2, name: 'New Nikhil' } })
  const ui = await render(<ProfileCard agent={{ id: 2, name: 'New Nikhil' }} onSaved={() => {}} />)

  assert.doesNotMatch(ui.text(), /undefined|null/)
  assert.equal(ui.byLabel('Email').props.value, '')
  assert.equal(ui.byLabel('About you').props.value, '')
})

test('saving sends every field the form owns, in one request', async (t) => {
  const { net } = setup(t)
  const saved = []
  const ui = await render(<ProfileCard agent={AGENT} onSaved={(a) => saved.push(a)} />)

  await change(ui.byLabel('Full name'), 'Rohit S. Sharma')
  await change(ui.byLabel('City'), 'Mumbai')
  await submit(formOf(ui))

  const [put] = net.to('/api/agent/profile', 'PUT')
  assert.ok(put, 'the profile was never sent')
  assert.deepEqual(put.body, {
    name: 'Rohit S. Sharma',
    email: 'rohit@example.com',
    business_name: 'Sharma Realty',
    city: 'Mumbai',
    rera_id: 'A52100012345',
    bio: 'Ten years in Baner and Balewadi.',
    avatar_url: null,
  })
  assert.equal(saved.length, 1, 'the parent was not told about the save')
  assert.equal(saved[0].city, 'Mumbai')
})

test('a saved profile says so, and the confirmation clears the moment you edit again', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)

  await submit(formOf(ui))
  assert.match(ui.text(), /Profile saved/)

  // Leaving "Profile saved" on screen next to a changed field is a lie about what the
  // server holds.
  await change(ui.byLabel('City'), 'Nashik')
  assert.doesNotMatch(ui.text(), /Profile saved/)
})

test('a rejected save shows the server’s reason and keeps what was typed', async (t) => {
  setup(t, { routes: { 'PUT /api/agent/profile': { status: 400, body: { error: 'That email is already in use' } } } })
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)

  await change(ui.byLabel('Email'), 'taken@example.com')
  await submit(formOf(ui))

  assert.match(ui.text(), /That email is already in use/)
  assert.equal(ui.byLabel('Email').props.value, 'taken@example.com', 'the form was reset under the agent')
  assert.doesNotMatch(ui.text(), /Profile saved/)
})

test('saving is refused while the name is blank', async (t) => {
  const { net } = setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)

  await change(ui.byLabel('Full name'), '   ')
  assert.equal(saveButton(ui).props.disabled, true)

  await click(saveButton(ui))
  assert.equal(net.to('/api/agent/profile', 'PUT').length, 0, 'a nameless profile was sent anyway')
})

test('the bio counter tracks what is typed, against the same cap the input enforces', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={{ ...AGENT, bio: '' }} onSaved={() => {}} />)

  assert.match(ui.text(), /0\/500/)
  await change(ui.byLabel('About you'), 'Resale specialist.')
  assert.match(ui.text(), /18\/500/)
  assert.equal(ui.byLabel('About you').props.maxLength, 500, 'the counter and the cap disagree')
})

// --- Avatar -----------------------------------------------------------------

test('with no photo the agent sees their initials and an invitation to add one', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)

  assert.match(ui.byLabel('Change profile photo').text ?? ui.text(), /RS|Add photo/)
  assert.ok(ui.queryByText('Add photo'), 'no way to add a photo')
  assert.equal(ui.queryByText('Remove'), null, 'offered to remove a photo that does not exist')
})

test('a photo already on file is shown, and can be changed or removed', async (t) => {
  setup(t)
  const ui = await render(
    <ProfileCard agent={{ ...AGENT, avatar_url: 'data:image/jpeg;base64,OLD' }} onSaved={() => {}} />,
  )

  assert.ok(ui.query((f) => f.type === 'img' && f.props.src === 'data:image/jpeg;base64,OLD'))
  assert.ok(ui.queryByText('Change photo'))

  await click(ui.byText('Remove'))
  assert.equal(ui.query((f) => f.type === 'img'), null, 'the photo stayed on screen after Remove')
  assert.ok(ui.queryByText('Add photo'))
})

test('removing a photo is only real once it is saved as null', async (t) => {
  const { net } = setup(t)
  const ui = await render(
    <ProfileCard agent={{ ...AGENT, avatar_url: 'data:image/jpeg;base64,OLD' }} onSaved={() => {}} />,
  )

  await click(ui.byText('Remove'))
  await submit(formOf(ui))

  assert.equal(net.to('/api/agent/profile', 'PUT')[0].body.avatar_url, null)
})

test('a picked photo is downscaled in the browser, then sent as the downscaled one', async (t) => {
  // The whole point of the canvas dance is that a 5 MB camera photo never travels
  // over a patchy 4G connection. Sending the original would still "work" — slowly,
  // and then be rejected by the server's data-URI cap.
  const { net } = setup(t)
  const imaging = installImaging()
  t.after(imaging.restore)

  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)
  const picker = ui.get((f) => f.type === 'input' && f.props.type === 'file', 'file input')
  // change() only carries a value; the component reads target.files, so fire directly.
  await picker.props.onChange({ target: { files: [{ name: 'photo.jpg' }], value: '' } })
  await act(() => new Promise((r) => setImmediate(r)))

  assert.ok(
    ui.query((f) => f.type === 'img' && f.props.src === 'data:image/jpeg;base64,SCALED'),
    'the preview did not switch to the downscaled photo',
  )

  await submit(formOf(ui))
  assert.equal(net.to('/api/agent/profile', 'PUT')[0].body.avatar_url, 'data:image/jpeg;base64,SCALED')
  assert.deepEqual(imaging.revoked, ['blob:fake'], 'the object URL was leaked')
})

test('a file the browser cannot decode is reported, not silently ignored', async (t) => {
  setup(t)
  const imaging = installImaging({ decode: false })
  t.after(imaging.restore)

  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)
  const picker = ui.get((f) => f.type === 'input' && f.props.type === 'file', 'file input')
  await picker.props.onChange({ target: { files: [{ name: 'notes.pdf' }], value: '' } })
  await act(() => new Promise((r) => setImmediate(r)))

  assert.match(ui.text(), /isn't an image we can read/)
  assert.deepEqual(imaging.revoked, ['blob:fake'], 'the object URL was leaked on the failure path')
})

test('picking nothing (a cancelled file dialog) does nothing at all', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)
  const picker = ui.get((f) => f.type === 'input' && f.props.type === 'file', 'file input')

  await picker.props.onChange({ target: { files: [], value: '' } })

  assert.doesNotMatch(ui.text(), /isn't an image/)
})

test('the file input accepts only the formats the server stores', async (t) => {
  setup(t)
  const ui = await render(<ProfileCard agent={AGENT} onSaved={() => {}} />)
  const picker = ui.get((f) => f.type === 'input' && f.props.type === 'file', 'file input')

  assert.equal(picker.props.accept, 'image/png,image/jpeg,image/webp')
})
