import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultExecutiveFilters, EXECUTIVE_FILTER_STATUSES, executiveUpdatePayload } from './executiveView.js'

test('executive dashboard defaults to registered and offers payable status', () => {
  assert.deepEqual(EXECUTIVE_FILTER_STATUSES, ['Зарегистрирован', 'К оплате'])
  assert.equal(defaultExecutiveFilters('2026-07-29').status, 'Зарегистрирован')
})

test('executive status update changes only status', () => {
  assert.deepEqual(executiveUpdatePayload(42, 'status', 'К оплате'), {
    ids: [42],
    status: 'К оплате',
    approval_date: '',
    actual_payment_date: '',
  })
})

test('executive approval date can be set or explicitly cleared', () => {
  assert.equal(executiveUpdatePayload(42, 'approval_date', '2026-07-29').approval_date, '2026-07-29')
  assert.deepEqual(executiveUpdatePayload(42, 'approval_date', ''), {
    ids: [42],
    status: '',
    approval_date: '',
    actual_payment_date: '',
    approval_date_set: true,
  })
})
