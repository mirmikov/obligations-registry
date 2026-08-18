import assert from 'node:assert/strict'
import test from 'node:test'
import { localTodayISO, paymentColumns, paymentRowClassName, paymentScreenColumns } from './paymentsView.js'

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

test('editable screen keeps the original eight columns while print stays optimized', () => {
  assert.deepEqual(paymentScreenColumns.map(column => column.key), [
    'account_type', 'legal_entity', 'counterparty', 'document_number',
    'document_date', 'amount', 'actual_payment_date', 'status',
  ])
  assert.ok(paymentScreenColumns.every(column => column.interactive))
  assert.equal(paymentColumns.length, 6)
})

test('paid payments stay in the register and receive the green row state', () => {
  assert.equal(paymentRowClassName({ status: 'Оплачено', urgency: 'Критическая' }), 'payment-row paid')
  assert.equal(paymentRowClassName({ status: 'К оплате', actual_payment_date: '2026-08-18' }), 'payment-row paid')
  assert.equal(paymentRowClassName({ status: 'К оплате', urgency: 'Критическая' }), 'payment-row critical')
  assert.equal(paymentRowClassName({ status: 'К оплате' }), 'payment-row')
})
