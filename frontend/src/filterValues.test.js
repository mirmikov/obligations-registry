import assert from 'node:assert/strict'
import test from 'node:test'
import { BLANK_ACCOUNT_TYPE_FILTER } from './filterValues.js'

test('blank account type filter uses the API sentinel', () => {
  assert.equal(BLANK_ACCOUNT_TYPE_FILTER, '__blank__')
  assert.equal(new URLSearchParams({ account_type: BLANK_ACCOUNT_TYPE_FILTER }).get('account_type'), '__blank__')
})
