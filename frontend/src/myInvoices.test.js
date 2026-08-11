import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filterMyInvoices, summarizeMyInvoices, uniqueInvoiceValues } from './myInvoicesView.js'

const items = [
  { id: 1, counterparty: 'Альфа', legal_entity: 'ООО Мирт', cost_category: 'Аренда', document_number: 'Счёт 1', amount: 100, planned_payment_date: '2026-08-01', status: 'Зарегистрирован', responsible: 'Иванов И.И.' },
  { id: 2, counterparty: 'Бета', legal_entity: 'ООО Мирт-МРТ', cost_category: 'Услуги', document_number: 'Счёт 2', amount: 200, planned_payment_date: '2026-08-20', approval_date: '2026-08-11', status: 'К оплате', responsible: 'Иванов И.И.' },
  { id: 3, counterparty: 'Гамма', legal_entity: 'ООО Мирт', cost_category: 'Услуги', document_number: 'Счёт 3', amount: 300, planned_payment_date: '2026-07-20', actual_payment_date: '2026-07-21', status: 'Оплачено', responsible: 'Петров П.П.' },
]

test('My invoices filters by status, entity, planned dates and text', () => {
  assert.deepEqual(filterMyInvoices(items, { status: 'К оплате' }).map(item => item.id), [2])
  assert.deepEqual(filterMyInvoices(items, { legalEntity: 'ООО Мирт' }).map(item => item.id), [1, 3])
  assert.deepEqual(filterMyInvoices(items, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }).map(item => item.id), [1, 2])
  assert.deepEqual(filterMyInvoices(items, { query: 'счёт 3' }).map(item => item.id), [3])
})

test('My invoices column filters support the registry table fields', () => {
  assert.deepEqual(filterMyInvoices(items, { counterparty: ['Альфа', 'Гамма'] }).map(item => item.id), [1, 3])
  assert.deepEqual(filterMyInvoices(items, { plannedDate: '2026-08-20' }).map(item => item.id), [2])
  assert.deepEqual(filterMyInvoices(items, { costCategory: 'Услуги', responsible: 'Петров П.П.' }).map(item => item.id), [3])
  assert.deepEqual(filterMyInvoices(items, { approvalDate: '2026-08-11' }).map(item => item.id), [2])
  assert.deepEqual(filterMyInvoices(items, { actualPaymentDate: '2026-07-21' }).map(item => item.id), [3])
})

test('My invoices summary counts statuses and overdue invoices', () => {
  const summary = summarizeMyInvoices(items, '2026-08-11')
  assert.equal(summary.count, 3)
  assert.equal(summary.amount, 600)
  assert.equal(summary.registeredCount, 1)
  assert.equal(summary.payableCount, 1)
  assert.equal(summary.paidCount, 1)
  assert.equal(summary.overdueCount, 1)
})

test('My invoices filter options are unique and sorted', () => {
  assert.deepEqual(uniqueInvoiceValues(items, 'legal_entity'), ['ООО Мирт', 'ООО Мирт-МРТ'])
})

test('My invoices and responsible-user assignment are connected to the UI and API', () => {
  const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./MyInvoices.jsx', import.meta.url), 'utf8')
  const references = readFileSync(new URL('./References.jsx', import.meta.url), 'utf8')
  assert.match(app, /id: 'my-invoices'/)
  assert.match(page, /request\('\/api\/my-invoices'\)/)
  assert.match(page, /Дата утверждения/)
  assert.match(page, /InvoiceColumnHead label="Контрагент"/)
  assert.match(page, /InvoiceColumnHead label="Плановая оплата"/)
  assert.match(page, /my-invoices-date-control/)
  assert.match(references, /api\/references\/responsibles\/\$\{responsibleID\}\/user/)
  assert.match(references, /api\/references\/assignable-users/)
})
