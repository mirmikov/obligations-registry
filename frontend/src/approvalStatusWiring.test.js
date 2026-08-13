import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

test('registry derives payable status for inline and bulk approval date edits', () => {
  assert.match(registry, /withReferenceDefaults\(\{ \.\.\.current, \[field\]: value \}, field,/)
  assert.match(registry, /withReferenceDefaults\(\{ \.\.\.item, \[field\]: value \}, field,/)
  assert.match(registry, /updateApprovalDate = value => setForm\(current => withDerivedObligationValues\(\{ \.\.\.current, approval_date: value \}, 'approval_date'\)\)/)
  assert.match(registry, /updateActualPaymentDate = value => setForm\(current => withDerivedObligationValues\(\{ \.\.\.current, actual_payment_date: value \}, 'actual_payment_date'\)\)/)
})

test('registry rolls back the derived status when an optimistic save fails', () => {
  assert.match(registry, /reverted\.status = current\.status/)
})
