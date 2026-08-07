import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const references = fs.readFileSync(new URL('./References.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('counterparty directory supports selecting and merging duplicate names', () => {
  assert.match(references, /selectedCounterparties/)
  assert.match(references, /\/api\/references\/counterparties\/merge/)
  assert.match(references, /Объединить\{selectedCounterparties\.length/)
  assert.match(references, /CounterpartyMergeModal/)
  assert.match(references, /Суммы, даты, статусы, документы и остальные поля не изменятся/)
})

test('counterparty merge controls are responsive and support dark mode', () => {
  assert.match(styles, /\.reference-merge-checkbox\.selected/)
  assert.match(styles, /\.counterparty-merge-modal/)
  assert.match(styles, /html\[data-theme="dark"\] \.counterparty-merge-body/)
  assert.match(styles, /@media\(max-width:760px\)\{\.reference-head-actions/)
})
