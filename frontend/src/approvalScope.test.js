import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeApprovalEntityOptions } from './approvalScope.js'

test('approval scope accepts reference API objects without crashing the editor modal', () => {
  assert.deepEqual(normalizeApprovalEntityOptions([
    { id: 7, value: ' ООО МЦ Мирт ' },
    { id: 8, value: 'ООО Клиника Мирт' },
    { id: 9, value: '' },
  ]), ['ООО МЦ Мирт', 'ООО Клиника Мирт'])
})

test('approval scope keeps stored string values and removes case-insensitive duplicates', () => {
  assert.deepEqual(normalizeApprovalEntityOptions([
    'ООО МЦ Мирт',
    ' ооо мц мирт ',
    'ООО Клиника Мирт',
    null,
  ]), ['ООО МЦ Мирт', 'ООО Клиника Мирт'])
  assert.deepEqual(normalizeApprovalEntityOptions(null), [])
})
