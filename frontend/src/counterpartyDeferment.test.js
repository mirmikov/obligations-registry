import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('counterparty directory exposes editable deferment and the protected API endpoint', () => {
  const references = fs.readFileSync(new URL('./References.jsx', import.meta.url), 'utf8')
  const backend = fs.readFileSync(new URL('../../backend/cmd/server/main.go', import.meta.url), 'utf8')
  assert.match(references, /Отсрочка, дней/)
  assert.match(references, /counterparties\/\$\{id\}\/deferment/)
  assert.match(backend, /PUT \/api\/references\/counterparties\/\{id\}\/deferment/)
  assert.match(backend, /references\.edit/)
})

test('registry and AI scan use the same counterparty default helper', () => {
  const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const aiScan = fs.readFileSync(new URL('./AIScanModal.jsx', import.meta.url), 'utf8')
  assert.match(registry, /buildCounterpartyDefermentMap/)
  assert.match(registry, /withReferenceDefaults/)
  assert.match(aiScan, /buildCounterpartyDefermentMap/)
  assert.match(aiScan, /withReferenceDefaults/)
})
