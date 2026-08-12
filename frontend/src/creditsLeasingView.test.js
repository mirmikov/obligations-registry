import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CREDIT_APPROVAL_STATUSES, creditApprovalUpdatePayload, groupCreditSchedule, summarizeCreditDetails } from './creditsLeasingView.js'

const payments = [
  { date: '2026-08-15', counterparty: 'Банк А', count: 2, total_amount: 300, outstanding_amount: 300, overdue: false },
  { date: '2026-08-15', counterparty: 'Лизинг Б', count: 1, total_amount: 400, outstanding_amount: 0, overdue: false },
  { date: '2026-07-10', counterparty: 'Банк А', count: 1, total_amount: 500, outstanding_amount: 500, overdue: true },
]

test('calendar groups every creditor payment for a day and exposes the real row count', () => {
  const schedule = groupCreditSchedule(payments, { asOf: '2026-08-11', scheduleMode: 'all', creditor: '' })
  const day = schedule.find(period => period.month === '2026-08').days[0]
  assert.equal(day.date, '2026-08-15')
  assert.equal(day.count, 3)
  assert.equal(day.total, 700)
  assert.equal(day.outstanding, 300)
})

test('calendar day follows the active creditor and schedule filters', () => {
  const upcoming = groupCreditSchedule(payments, { asOf: '2026-08-11', scheduleMode: 'upcoming', creditor: 'Банк А' })
  assert.equal(upcoming.length, 1)
  assert.equal(upcoming[0].days[0].count, 2)
  assert.equal(upcoming[0].days[0].total, 300)

  const overdue = groupCreditSchedule(payments, { asOf: '2026-08-11', scheduleMode: 'overdue', creditor: 'Банк А' })
  assert.equal(overdue[0].days[0].date, '2026-07-10')
})

test('detail totals treat actual payment date as paid and exclude cancelled debt', () => {
  assert.deepEqual(summarizeCreditDetails([
    { amount: 100, status: 'К оплате', actual_payment_date: '' },
    { amount: 200, status: 'К оплате', actual_payment_date: '2026-08-10' },
    { amount: 300, status: 'Отменено', actual_payment_date: '' },
  ]), { count: 3, total: 600, paid: 200, outstanding: 100 })
})

test('clicking the whole calendar day loads payment details', () => {
  const source = fs.readFileSync(new URL('./CreditsLeasing.jsx', import.meta.url), 'utf8')
  assert.match(source, /className={`schedule-day/)
  assert.match(source, /onClick=\{\(\) => onOpenDay\(day\)\}/)
  assert.match(source, /\/api\/reports\/credits-leasing\/details\?/)
  assert.match(source, /detailsRequest\.current === requestID/)
})

test('credits approval exposes only registered and payable statuses', () => {
  assert.deepEqual(CREDIT_APPROVAL_STATUSES, ['К оплате', 'Зарегистрирован'])
})

test('credits status update changes only the approval status', () => {
  assert.deepEqual(creditApprovalUpdatePayload(17, 'status', 'К оплате'), {
    ids: [17],
    status: 'К оплате',
    approval_date: '',
    actual_payment_date: '',
  })
})

test('credits approval date can be set or explicitly cleared', () => {
  assert.deepEqual(creditApprovalUpdatePayload(17, 'approval_date', '2026-08-12'), {
    ids: [17],
    status: 'К оплате',
    approval_date: '2026-08-12',
    actual_payment_date: '',
    approval_date_set: true,
  })
  assert.deepEqual(creditApprovalUpdatePayload(17, 'approval_date', ''), {
    ids: [17],
    status: '',
    approval_date: '',
    actual_payment_date: '',
    approval_date_set: true,
  })
})

test('credit day details wire editable status and approval date to the scoped endpoint', () => {
  const source = fs.readFileSync(new URL('./CreditsLeasing.jsx', import.meta.url), 'utf8')
  assert.match(source, /credits\.approve/)
  assert.match(source, /\/api\/reports\/credits-leasing\/obligations\/bulk/)
  assert.match(source, /optimisticItem = withDerivedObligationValues\(\{ \.\.\.item, \[field\]: value \}, field\)/)
  assert.match(source, /row\.id === item\.id \? optimisticItem : row/)
  assert.match(source, /CreditStatusCell/)
  assert.match(source, /CreditApprovalDateCell/)
})
