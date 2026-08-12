import assert from 'node:assert/strict'
import test from 'node:test'
import { localTodayISO, paymentColumns, paymentEditableColumns } from './paymentsView.js'

test('payment register starts with the local current date', () => {
  assert.equal(localTodayISO(new Date(2026, 6, 23, 0, 1)), '2026-07-23')
  assert.equal(localTodayISO(new Date(2027, 0, 5, 23, 59)), '2027-01-05')
})

test('payment register contains only the optimized six business columns', () => {
  assert.deepEqual(paymentColumns.map(column => column.key), [
    'account_type',
    'legal_entity',
    'counterparty',
    'document_number',
    'planned_payment_date',
    'amount',
  ])
  assert.ok(!paymentColumns.some(column => ['cost_category', 'urgency'].includes(column.key)))
})

test('editable register includes all registry fields while print columns stay optimized', () => {
  assert.equal(paymentEditableColumns.length, 18)
  for (const field of ['counterparty', 'entry_date', 'account_type', 'legal_entity', 'amount', 'document_number', 'document_date', 'cost_category', 'deferment_days', 'planned_payment_date', 'approval_date', 'actual_payment_date', 'status', 'urgency', 'responsible', 'priority', 'comment', 'source_note']) {
    assert.ok(paymentEditableColumns.some(column => column.key === field), `missing ${field}`)
  }
  assert.equal(paymentColumns.length, 6)
})
