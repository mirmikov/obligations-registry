import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { request } from './api.js'

const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const aiScan = fs.readFileSync(new URL('./AIScanModal.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('API errors preserve structured duplicate information', async () => {
  const originalFetch = globalThis.fetch
  const originalStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null, removeItem: () => {} }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Найден дубль', code: 'duplicate_obligation', duplicates: [{ id: 17 }] }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  try {
    await assert.rejects(request('/api/obligations', { method: 'POST', body: '{}' }), error => error.status === 409 && error.code === 'duplicate_obligation' && error.details.duplicates[0].id === 17)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalStorage
  }
})

test('manual create and edit use duplicate confirmation with an explicit override', () => {
  assert.match(registry, /requestJSONWithDuplicateConfirmation/)
  assert.match(registry, /allow_duplicate:\s*true/)
  assert.match(registry, /Возможный дубликат счёта/)
  assert.match(registry, /Вернуться и исправить/)
  assert.match(registry, /Продолжить всё равно/)
})

test('Excel import and AI commit also require duplicate confirmation', () => {
  assert.match(registry, /body\.append\('allow_duplicate', 'true'\)/)
  assert.match(registry, /requestJSONWithDuplicateConfirmation\(`\/api\/obligations\/ai-scan\/\$\{aiScan\.batch\}\/commit`/)
  assert.match(aiScan, /duplicate_matches/)
})

test('duplicate dialog has responsive and dark theme styles', () => {
  assert.match(styles, /\.duplicate-obligation-backdrop/)
  assert.match(styles, /html\[data-theme="dark"\] \.duplicate-obligation-modal/)
  assert.match(styles, /@media\(max-width:720px\).*\.duplicate-obligation-modal/s)
  assert.match(registry, /className="danger duplicate-obligation-confirm"/)
  assert.match(styles, /\.duplicate-obligation-confirm:hover/)
  assert.match(styles, /\.duplicate-obligation-confirm:focus-visible/)
})
