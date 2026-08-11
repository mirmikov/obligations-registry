import test from 'node:test'
import assert from 'node:assert/strict'
import { addSchedulePeriod, buildAdvancedSplitPayload, buildAdvancedSplitPreview, createAdvancedSplitFields, createWeightParts, isAdvancedSplitMode } from './advancedPaymentSplit.js'

test('advanced modes are separate from the three existing split modes', () => {
  assert.equal(isAdvancedSplitMode('count'), false)
  assert.equal(isAdvancedSplitMode('amount'), false)
  assert.equal(isAdvancedSplitMode('percentage'), false)
  assert.equal(isAdvancedSplitMode('advance'), true)
  assert.equal(isAdvancedSplitMode('calendar'), true)
  assert.equal(isAdvancedSplitMode('recurring'), true)
  assert.equal(isAdvancedSplitMode('weights'), true)
})

test('advance and balance preserve every kopeck and use the proven percentage contract', () => {
  const form = {
    mode: 'advance',
    advance_percent: '33.33',
    advance_date: '2026-08-11',
    advance_account_type: 'ОМС',
    balance_date: '2026-09-30',
    balance_account_type: 'Коммерция',
  }
  const preview = buildAdvancedSplitPreview(100.01, form)
  assert.equal(preview.error, '')
  assert.deepEqual(preview.items.map(item => item.amount), [33.33, 66.68])
  assert.equal(preview.total, 100.01)
  assert.deepEqual(buildAdvancedSplitPayload(form, preview), {
    mode: 'percentage',
    percentage_parts: [
      { percent: 33.33, account_type: 'ОМС', planned_date: '2026-08-11' },
      { percent: 66.67, account_type: 'Коммерция', planned_date: '2026-09-30' },
    ],
  })
})

test('calendar schedules handle month end and convert to the unchanged count contract', () => {
  const form = { mode: 'calendar', calendar_count: '4', calendar_start_date: '2027-01-31', calendar_interval: '1', calendar_unit: 'month' }
  const preview = buildAdvancedSplitPreview(100, form)
  assert.deepEqual(preview.items.map(item => item.date), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'])
  assert.deepEqual(preview.items.map(item => item.amount), [25, 25, 25, 25])
  assert.deepEqual(buildAdvancedSplitPayload(form, preview), { mode: 'count', count: 4, payment_dates: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'] })
})

test('business day schedule skips weekends without pretending to know holidays', () => {
  assert.equal(addSchedulePeriod('2026-08-14', 'business_day', 1), '2026-08-17')
  assert.equal(addSchedulePeriod('2026-08-14', 'business_day', 3), '2026-08-19')
})

test('regular amount produces a precise final remainder and manual amount payload', () => {
  const form = {
    mode: 'recurring',
    recurring_amount: '300.00',
    recurring_start_date: '2026-08-11',
    recurring_interval: '2',
    recurring_unit: 'week',
    recurring_account_type: 'ОМС',
  }
  const preview = buildAdvancedSplitPreview(1000.01, form)
  assert.deepEqual(preview.items.map(item => item.amount), [300, 300, 300, 100.01])
  assert.deepEqual(preview.items.map(item => item.date), ['2026-08-11', '2026-08-25', '2026-09-08', '2026-09-22'])
  const payload = buildAdvancedSplitPayload(form, preview)
  assert.equal(payload.mode, 'amount')
  assert.equal(payload.amount_parts.reduce((sum, item) => sum + item.amount, 0), 1000.01)
  assert.ok(payload.amount_parts.every(item => item.account_type === 'ОМС'))
})

test('weights are normalized to 100 percent and keep the total exact', () => {
  const form = { mode: 'weights', weight_parts: createWeightParts([1, 2, 3], '2026-08-11', 'Коммерция') }
  const preview = buildAdvancedSplitPreview(100.01, form)
  assert.equal(preview.error, '')
  assert.equal(preview.items.reduce((sum, item) => sum + item.percent, 0), 100)
  assert.equal(Math.round(preview.items.reduce((sum, item) => sum + item.amount, 0) * 100), 10001)
  assert.deepEqual(preview.items.map(item => item.percent), [16.67, 33.33, 50])
  assert.equal(buildAdvancedSplitPayload(form, preview).mode, 'percentage')
})

test('advanced validation rejects incomplete schedules before saving', () => {
  const form = { ...createAdvancedSplitFields('2026-08-11'), mode: 'recurring', recurring_amount: '1', recurring_account_type: 'ОМС' }
  assert.match(buildAdvancedSplitPreview(1000, form).error, /больше 60/)
  assert.match(buildAdvancedSplitPreview(0, form).error, /положительная сумма/)
})
