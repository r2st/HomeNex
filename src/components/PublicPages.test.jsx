import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../test/render.jsx'
import { installBrowser } from '../test/browserEnv.js'
import { resolvePublicRoute, TOOLS, BLOG_POSTS, ToolsIndex, BlogIndex } from './PublicPages.jsx'

test('resolvePublicRoute — /tools returns tools-index', () => {
  assert.equal(resolvePublicRoute('/tools'), 'tools-index')
})

test('resolvePublicRoute — /tools/emi-calculator returns tool-page', () => {
  assert.equal(resolvePublicRoute('/tools/emi-calculator'), 'tool-page')
})

test('resolvePublicRoute — /blog returns blog-index', () => {
  assert.equal(resolvePublicRoute('/blog'), 'blog-index')
})

test('resolvePublicRoute — /blog/some-slug returns blog-post', () => {
  assert.equal(resolvePublicRoute('/blog/some-slug'), 'blog-post')
})

test('resolvePublicRoute — /embed returns embed', () => {
  assert.equal(resolvePublicRoute('/embed'), 'embed')
})

test('resolvePublicRoute — unknown path returns null', () => {
  assert.equal(resolvePublicRoute('/unknown'), null)
})

test('TOOLS has 3 entries', () => {
  assert.equal(TOOLS.length, 3)
})

test('BLOG_POSTS has 3 articles', () => {
  assert.equal(BLOG_POSTS.length, 3)
})

test('each blog post has required fields', () => {
  for (const post of BLOG_POSTS) {
    assert.ok(post.slug, 'slug')
    assert.ok(post.title, 'title')
    assert.ok(post.date, 'date')
    assert.ok(post.content, 'content')
    assert.ok(post.excerpt, 'excerpt')
  }
})

test('ToolsIndex renders all tool names', async (t) => {
  installBrowser()
  const ui = await render(<ToolsIndex />)
  const text = ui.text()
  for (const tool of TOOLS) {
    assert.ok(text.includes(tool.title), `should render ${tool.title}`)
  }
})
