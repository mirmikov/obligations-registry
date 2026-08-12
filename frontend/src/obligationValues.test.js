import test from 'node:test'
import assert from 'node:assert/strict'
import { PAYABLE_STATUS, withDerivedObligationValues } from './obligationValues.js'

test('approval date automatically marks obligation as payable', () => {
  const value = withDerivedObligationValues({
    approval_date: '2026-08-12',
    status: 'Зарегистрирован',
  }, 'approval_date')

  assert.equal(value.status, PAYABLE_STATUS)
})

test('clearing approval date does not silently change status', () => {
  const value = withDerivedObligationValues({
    approval_date: '',
    status: 'К оплате',
  }, 'approval_date')

  assert.equal(value.status, 'К оплате')
})

test('actual payment date keeps paid status when approval date changes', () => {
  const value = withDerivedObligationValues({
    approval_date: '2026-08-12',
    actual_payment_date: '2026-08-11',
    status: 'Оплачено',
  }, 'approval_date')

  assert.equal(value.status, 'Оплачено')
})

test('actual payment date automatically marks obligation as paid', () => {
  const value = withDerivedObligationValues({
    actual_payment_date: '2026-07-29',
    status: 'К оплате',
  }, 'actual_payment_date')

  assert.equal(value.status, 'Оплачено')
})

test('clearing actual payment date does not silently change status', () => {
  const value = withDerivedObligationValues({
    actual_payment_date: '',
    status: 'Оплачено',
  }, 'actual_payment_date')

  assert.equal(value.status, 'Оплачено')
})

test('document date and deferment still calculate planned payment date', () => {
  const value = withDerivedObligationValues({
    document_date: '2026-07-29',
    deferment_days: 10,
    planned_payment_date: '',
  }, 'deferment_days')

  assert.equal(value.planned_payment_date, '2026-08-08')
})
