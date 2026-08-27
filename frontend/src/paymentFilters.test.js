import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { buildPaymentRegisterQuery, paymentColumns, paymentScreenColumns } from './paymentsView.js'

test('payment register exposes a filter for each unchanged screen column', () => {
  assert.deepEqual(paymentScreenColumns.map(column => [column.key, column.filter]), [
    ['account_type', 'select'],
    ['legal_entity', 'select'],
    ['counterparty', 'multi-select'],
    ['document_number', 'text'],
    ['document_date', 'date'],
    ['amount', 'amount'],
    ['actual_payment_date', 'date'],
    ['status', 'select'],
  ])
  assert.deepEqual(paymentScreenColumns.map(column => column.key), [
    'account_type', 'legal_entity', 'counterparty', 'document_number',
    'document_date', 'amount', 'actual_payment_date', 'status',
  ])
  assert.deepEqual(paymentColumns.map(column => column.key), [
    'account_type', 'legal_entity', 'counterparty', 'document_number',
    'planned_payment_date', 'amount',
  ])
})

test('payment query preserves multiple counterparties and every column filter', () => {
  const query = buildPaymentRegisterQuery({
    approval_date: '2026-08-27',
    account_type: 'ОМС',
    legal_entity: 'ООО МЦ МИРТ',
    counterparty: ['Альфа', 'Бета'],
    document_number: 'СЧ-42',
    document_date: '2026-08-20',
    amount: '17 986,25',
    actual_payment_date: '2026-08-26',
    status: 'Оплачено',
  })
  const params = new URLSearchParams(query)
  assert.deepEqual(params.getAll('counterparty'), ['Альфа', 'Бета'])
  for (const key of ['approval_date', 'account_type', 'legal_entity', 'document_number', 'document_date', 'amount', 'actual_payment_date', 'status']) {
    assert.ok(params.get(key), `${key} is missing from query`)
  }
})

test('payment column filters stay out of the print report', () => {
  const source = fs.readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
  const printReport = source.slice(source.indexOf('function PaymentPrintReport'))
  assert.match(source, /<PaymentColumnFilter/)
  assert.match(printReport, /paymentColumns\.map\(column => <th/)
  assert.match(printReport, /paymentColumns\.map\(column => <td/)
  assert.doesNotMatch(printReport, /PaymentColumnFilter/)
})
