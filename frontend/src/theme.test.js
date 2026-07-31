import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { applyTheme, resolveTheme, THEME_STORAGE_KEY } from './theme.js'

test('theme uses a saved choice and falls back to the operating system preference', () => {
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme(null, true), 'dark')
  assert.equal(resolveTheme('unsupported', false), 'light')
})

test('theme application updates the root and persists the choice', () => {
  const root = { dataset: {}, style: {} }
  const values = new Map()
  const storage = { setItem: (key, value) => values.set(key, value) }
  globalThis.document = { querySelector: () => null }
  assert.equal(applyTheme('dark', root, storage), 'dark')
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(values.get(THEME_STORAGE_KEY), 'dark')
  delete globalThis.document
})

test('chat launcher is icon-only and dark mode keeps print output light', () => {
  const app = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const launcher = app.slice(app.indexOf('className="chat-widget-launcher"'), app.indexOf('</button></div>}', app.indexOf('className="chat-widget-launcher"')))
  assert.doesNotMatch(launcher, /<span>Чат<\/span>/)
  assert.match(css, /html\[data-theme="dark"\]/)
  assert.match(css, /@media print[\s\S]*html\[data-theme="dark"\]/)
})
