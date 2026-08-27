import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const modal = readFileSync(new URL('./SystemAnnouncementModal.jsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('system announcement is controlled only by the protected developer', () => {
  assert.match(registry, /user\?\.is_developer\s*&&\s*<button className=\{`system-announcement-toggle/)
  assert.match(modal, /request\('\/api\/system\/announcement'/)
  assert.doesNotMatch(registry, /can\(user,\s*['"]system\.announcement/)
})

test('announcement is polled for everyone and rendered independently from maintenance', () => {
  assert.match(app, /setAnnouncement\(result\.announcement/)
  assert.match(app, /announcement\.active\s*&&\s*<div className="system-announcement-banner"/)
  assert.match(app, /maintenance\.active\s*\?\s*'has-maintenance'/)
  assert.match(app, /announcement\.active\s*\?\s*'has-announcement'/)
})

test('announcement editor enforces the message limit and supports disabling', () => {
  assert.match(modal, /maxLength="500"/)
  assert.match(modal, /save\(false\)/)
  assert.match(modal, /JSON\.stringify\(\{ active, message: prepared \}\)/)
})

test('blue banner has white text and stacks below maintenance', () => {
  assert.match(styles, /\.system-announcement-banner\{[^}]*background:#1769b0;[^}]*color:#fff/)
  assert.match(styles, /\.has-maintenance \.system-announcement-banner\{top:38px\}/)
  assert.match(styles, /\.has-maintenance\.has-announcement \.main\{padding-top:76px\}/)
  assert.match(styles, /\.has-maintenance\.has-announcement \.chat-page[^}]*76px/)
})
