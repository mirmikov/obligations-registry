import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const payments = fs.readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

test('each payment row opens the source registry record details', () => {
  assert.match(payments, /aria-label={`Подробнее о платеже №\$\{item\.id\}`}/)
  assert.match(payments, /onOpenDetails=\{\(\) => setDetailItem\(item\)\}/)
  assert.match(payments, /detailItem && <ObligationHistoryModal item=\{detailItem\}/)
})

test('payment drilldown contains complete current registry values and history', () => {
  assert.match(registry, /export function ObligationHistoryModal/)
  assert.match(registry, /Подробная информация о платеже/)
  for (const field of ['legal_entity', 'counterparty', 'document_number', 'document_date', 'cost_category', 'amount', 'planned_payment_date', 'approval_date', 'actual_payment_date', 'status', 'responsible', 'comment', 'source_note']) {
    assert.match(registry, new RegExp(`\\['${field}'`))
  }
  assert.match(registry, /История работы сотрудников/)
})

test('payment drilldown does not change print report columns', () => {
  const printReport = payments.slice(payments.indexOf('function PaymentPrintReport'))
  assert.match(printReport, /paymentColumns\.map\(column => <th/)
  assert.doesNotMatch(printReport, /payment-details-button/)
})
