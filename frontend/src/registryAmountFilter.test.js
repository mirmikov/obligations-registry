import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

test('registry has a separate amount search beside the general search', () => {
  assert.match(registry, /placeholder="Контрагент, счёт, комментарий…"/)
  assert.match(registry, /className="search-box amount-search-box"/)
  assert.match(registry, /placeholder="Поиск по сумме"/)
  assert.match(registry, /setFilter\('amount', e\.target\.value\)/)
  assert.match(registry, /const emptyFilters = \{ q: '', amount: ''/)
})
