import assert from 'node:assert/strict'
import test from 'node:test'
import { BLANK_ACCOUNT_TYPE_FILTER, filterSelectOptions } from './filterValues.js'

test('blank account type filter uses the API sentinel', () => {
  assert.equal(BLANK_ACCOUNT_TYPE_FILTER, '__blank__')
  assert.equal(new URLSearchParams({ account_type: BLANK_ACCOUNT_TYPE_FILTER }).get('account_type'), '__blank__')
})

test('custom select search is case-insensitive and preserves option values', () => {
  const options = [
    { value: '1', label: 'Альфа' },
    { value: '2', label: 'Коммерция' },
  ]
  assert.deepEqual(filterSelectOptions(options, 'КОММ'), [{ value: '2', label: 'Коммерция' }])
  assert.equal(filterSelectOptions(options, '')[0], options[0])
})
