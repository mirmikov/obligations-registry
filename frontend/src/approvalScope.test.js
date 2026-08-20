import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalPermissionKeys, normalizeApprovalEntityOptions, withApprovalEnabled, withApprovalScope } from './approvalScope.js'

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

test('selecting a legal entity immediately enables registry approval permission', () => {
  const next = withApprovalScope({
    permissions: { 'registry.edit': true, 'obligations.approve': false },
    approval_legal_entities: [],
  }, [' ООО МЦ Мирт '])
  assert.equal(next.permissions['obligations.approve'], true)
  assert.equal(next.permissions['registry.view'], true)
  assert.equal(next.permissions['registry.edit'], true)
  assert.deepEqual(next.approval_legal_entities, ['ООО МЦ Мирт'])
})

test('approval switch supports all entities and clears scope when disabled', () => {
  const enabled = withApprovalEnabled({
    permissions: { 'registry.edit': true },
    approval_legal_entities: [],
  }, true)
  assert.equal(enabled.permissions['obligations.approve'], true)
  assert.equal(enabled.permissions['registry.view'], true)
  assert.deepEqual(enabled.approval_legal_entities, [])

  const disabled = withApprovalEnabled({
    permissions: Object.fromEntries(approvalPermissionKeys.map(key => [key, true])),
    approval_legal_entities: ['ООО МЦ Мирт'],
  }, false)
  for (const key of approvalPermissionKeys) assert.equal(disabled.permissions[key], false)
  assert.deepEqual(disabled.approval_legal_entities, [])
})
