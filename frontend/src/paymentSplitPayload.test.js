import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAdvancedSplitPreview, createAdvancedSplitFields, createWeightParts } from './advancedPaymentSplit.js'
import { buildPaymentSplitPayload } from './paymentSplitPayload.js'

const advancedFields = createAdvancedSplitFields('2026-08-12', 'ОМС')

test('equal-parts payload contains only fields accepted by the split API', () => {
  const payload = buildPaymentSplitPayload({
    ...advancedFields,
    mode: 'count',
    count: '2',
    payment_dates: ['2026-08-12', '2026-09-12'],
    amount_parts: [],
    percentage_parts: [],
  }, { items: [{}, {}], error: '' })

  assert.deepEqual(payload, {
    mode: 'count',
    count: 2,
    payment_dates: ['2026-08-12', '2026-09-12'],
  })
})

test('manual-amount payload contains only normalized payment rows', () => {
  const payload = buildPaymentSplitPayload({
    ...advancedFields,
    mode: 'amount',
    count: '99',
    payment_dates: ['not-sent'],
    amount_parts: [
      { amount: '40.01', account_type: 'ОМС', planned_date: '2026-08-12', ui_only: true },
      { amount: '60', account_type: 'Коммерция', planned_date: '2026-09-12', ui_only: true },
    ],
    percentage_parts: [],
  }, { items: [{}, {}], error: '' })

  assert.deepEqual(payload, {
    mode: 'amount',
    amount_parts: [
      { amount: 40.01, account_type: 'ОМС', planned_date: '2026-08-12' },
      { amount: 60, account_type: 'Коммерция', planned_date: '2026-09-12' },
    ],
  })
})

test('percentage payload contains only normalized percentage rows', () => {
  const payload = buildPaymentSplitPayload({
    ...advancedFields,
    mode: 'percentage',
    count: '99',
    payment_dates: ['not-sent'],
    amount_parts: [],
    percentage_parts: [
      { percent: '25', account_type: 'ОМС', planned_date: '2026-08-12', ui_only: true },
      { percent: '75', account_type: 'Коммерция', planned_date: '2026-09-12', ui_only: true },
    ],
  }, { items: [{}, {}], error: '' })

  assert.deepEqual(payload, {
    mode: 'percentage',
    percentage_parts: [
      { percent: 25, account_type: 'ОМС', planned_date: '2026-08-12' },
      { percent: 75, account_type: 'Коммерция', planned_date: '2026-09-12' },
    ],
  })
})

test('all four advanced modes are projected to the strict API contract', () => {
  const forms = [
    {
      ...advancedFields,
      mode: 'advance',
      advance_percent: '30',
      advance_date: '2026-08-12',
      balance_date: '2026-09-12',
      advance_account_type: 'ОМС',
      balance_account_type: 'Коммерция',
    },
    { ...advancedFields, mode: 'calendar', calendar_count: '2', calendar_start_date: '2026-08-12', calendar_interval: '1', calendar_unit: 'month' },
    { ...advancedFields, mode: 'recurring', recurring_amount: '60', recurring_start_date: '2026-08-12', recurring_interval: '1', recurring_unit: 'month', recurring_account_type: 'ОМС' },
    { ...advancedFields, mode: 'weights', weight_parts: createWeightParts([1, 1], '2026-08-12', 'ОМС') },
  ]
  const acceptedKeys = new Set(['mode', 'count', 'start_date', 'payment_dates', 'amount_parts', 'percentage_parts'])

  for (const form of forms) {
    const preview = buildAdvancedSplitPreview(100, form)
    assert.equal(preview.error, '', `${form.mode} preview must be valid`)
    const payload = buildPaymentSplitPayload(form, preview)
    assert.ok(payload, `${form.mode} must produce a payload`)
    assert.ok(Object.keys(payload).every(key => acceptedKeys.has(key)), `${form.mode} sent an unknown field`)
    assert.equal('advance_percent' in payload, false)
  }
})
