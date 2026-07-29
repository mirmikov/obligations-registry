import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

test('registry exposes row information in row actions and selected-row toolbar', () => {
  assert.match(registry, /Информация и история изменений/)
  assert.match(registry, /<Info size=\{15\}\/>Информация/)
  assert.match(registry, /onInfo=\{\(\) => setHistoryItem\(item\)\}/)
})

test('registry history loads employee attribution and field-level changes', () => {
  assert.match(registry, /\/api\/obligations\/\$\{item\.id\}\/history/)
  assert.match(registry, /Дата и время заведения/)
  assert.match(registry, /История работы сотрудников/)
  assert.match(registry, /historyValue\(change\.field, change\.before\)/)
  assert.match(registry, /historyValue\(change\.field, change\.after\)/)
})

test('registry history is read-only', () => {
  const historyStart = registry.indexOf('function ObligationHistoryModal')
  const historyEnd = registry.indexOf('function historyDateTime')
  const modal = registry.slice(historyStart, historyEnd)
  assert.doesNotMatch(modal, /method:\s*['"](?:POST|PATCH|PUT|DELETE)/)
})
