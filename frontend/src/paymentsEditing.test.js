import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { paymentColumns, paymentEditableColumns, paymentUpdatePayload } from './paymentsView.js'

test('payment register exposes every business field from the main registry for editing', () => {
  assert.deepEqual(paymentEditableColumns.map(column => column.key), [
    'counterparty', 'entry_date', 'account_type', 'legal_entity', 'amount', 'document_number', 'document_date',
    'cost_category', 'deferment_days', 'planned_payment_date', 'approval_date', 'actual_payment_date', 'status',
    'urgency', 'responsible', 'priority', 'comment', 'source_note',
  ])
  assert.ok(paymentEditableColumns.findIndex(column => column.key === 'actual_payment_date') < paymentEditableColumns.findIndex(column => column.key === 'status'))
  assert.equal(paymentColumns.some(column => ['status', 'actual_payment_date', 'approval_date'].includes(column.key)), false)
})

test('screen includes document and planned dates without changing print columns', () => {
  assert.equal(paymentEditableColumns.find(column => column.key === 'document_date')?.label, 'Дата документа')
  assert.equal(paymentEditableColumns.find(column => column.key === 'planned_payment_date')?.label, 'Плановая оплата')
  assert.equal(paymentColumns.some(column => column.key === 'document_date'), false)
  assert.equal(paymentColumns.find(column => column.key === 'planned_payment_date')?.label, 'Срок оплаты')
})

test('payment update payload preserves obligation fields and excludes read-only metadata', () => {
  const item = {
    id: 42,
    counterparty: 'Контрагент',
    status: 'К оплате',
    actual_payment_date: '',
    split_group_id: 'split-1',
    installment_number: 2,
    created_at: '2026-07-20 10:00',
    updated_at: '2026-07-29 12:00',
    overdue: false,
    due_soon: true,
  }
  const payload = paymentUpdatePayload(item, 'actual_payment_date', '2026-07-29')
  assert.equal(payload.actual_payment_date, '2026-07-29')
  assert.equal(payload.status, 'Оплачено')
  assert.equal(payload.split_group_id, 'split-1')
  assert.equal(payload.installment_number, 2)
  assert.equal('id' in payload, false)
  assert.equal('created_at' in payload, false)
  assert.equal('overdue' in payload, false)
})

test('setting actual payment date explicitly marks payment as paid', () => {
  const payload = paymentUpdatePayload({ id: 7, status: 'К оплате', actual_payment_date: '' }, 'actual_payment_date', '2026-07-30')
  assert.equal(payload.actual_payment_date, '2026-07-30')
  assert.equal(payload.status, 'Оплачено')
})

test('print report remains bound only to original paymentColumns', () => {
  const source = fs.readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
  const printReport = source.slice(source.indexOf('function PaymentPrintReport'))
  assert.match(printReport, /paymentColumns\.map\(column => <th/)
  assert.match(printReport, /paymentColumns\.map\(column => <td/)
  assert.doesNotMatch(printReport, /paymentScreenColumns/)
})

test('payment screen uses the shared editable registry row and submits a complete obligation', () => {
  const source = fs.readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
  assert.match(source, /<RegistryRow[^>]+editable=\{can\(user, 'payments\.edit'\)\}/)
  assert.match(source, /stripObligation\(rowsRef\.current\.get\(item\.id\)\)/)
  assert.match(source, /saveWithDuplicateConfirmation/)
  assert.match(source, /withDerivedObligationValues/)
})
