import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { approvalStatusOptions, can, canApproveObligations, pagePermissions } from './permissions.js'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const users = readFileSync(new URL('./UsersPage.jsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('developer always has every client permission', () => {
  assert.equal(can({ is_developer: true, permissions: {} }, 'anything'), true)
})

test('ordinary users receive only explicitly enabled permissions', () => {
  const user = { permissions: { 'registry.view': true, 'registry.delete': false } }
  assert.equal(can(user, pagePermissions.registry), true)
  assert.equal(can(user, 'registry.delete'), false)
})

test('manager, configured editor and protected developer can approve obligations', () => {
  assert.equal(canApproveObligations({ role: 'manager', permissions: { 'obligations.approve': true } }), true)
  assert.equal(canApproveObligations({ role: 'editor', permissions: { 'obligations.approve': true } }), true)
  assert.equal(canApproveObligations({ role: 'editor', permissions: {} }), false)
  assert.equal(canApproveObligations({ role: 'manager', permissions: {} }), false)
  assert.equal(canApproveObligations({ role: 'developer', is_developer: true }), true)
  for (const role of ['admin', 'accountant', 'viewer']) assert.equal(canApproveObligations({ role }), false)
  const options = [{ value: 'Зарегистрирован' }, { value: 'К оплате' }, { value: 'Оплачено' }]
  assert.deepEqual(approvalStatusOptions(options, { role: 'editor' }).map(item => item.value), ['Зарегистрирован', 'Оплачено'])
  assert.equal(approvalStatusOptions(options, { role: 'manager', permissions: { 'obligations.approve': true } }).length, 3)
})

test('manager approval can be limited to several legal entities', () => {
  const manager = {
    role: 'manager',
    permissions: { 'obligations.approve': true },
    approval_legal_entities: ['ООО МЦ Мирт', 'ООО Клиника Мирт'],
  }
  assert.equal(canApproveObligations(manager), true)
  assert.equal(canApproveObligations(manager, 'ООО МЦ Мирт'), true)
  assert.equal(canApproveObligations(manager, 'ооо клиника мирт'), true)
  assert.equal(canApproveObligations(manager, 'ООО Стоматология'), false)
  assert.equal(canApproveObligations(manager, ''), false)
  assert.equal(canApproveObligations({ ...manager, approval_legal_entities: [] }, 'ООО Стоматология'), true)
  assert.equal(canApproveObligations({ role: 'developer', is_developer: true, approval_legal_entities: ['Одно юрлицо'] }, 'Другое юрлицо'), true)
  const editor = { ...manager, role: 'editor' }
  assert.equal(canApproveObligations(editor, 'ООО МЦ Мирт'), true)
  assert.equal(canApproveObligations(editor, 'ООО Клиника Мирт'), true)
  assert.equal(canApproveObligations(editor, 'ООО Стоматология'), false)
  assert.equal(canApproveObligations({ ...editor, approval_legal_entities: [] }, 'ООО Стоматология'), true)

})

test('user settings persist and display multiple approval legal entities', () => {
  assert.match(users, /payload\.approval_legal_entities/)
  assert.match(users, /Юрлица для утверждения/)
  assert.match(users, /Все юридические лица/)
  assert.match(users, /withApprovalScope\(current, values\)/)
  assert.match(users, /Утверждение «К оплате» разрешено/)
  assert.match(users, /Разрешить утверждение «К оплате»/)
})

test('navigation, registry actions and access editor are permission driven', () => {
  assert.match(app, /permission: 'executive\.view'/)
  assert.match(app, /permission: 'my_invoices\.view'/)
  assert.match(app, /can\(user, 'registry\.undo'\)/)
  assert.match(registry, /can\(user, 'registry\.delete'\)/)
  assert.match(registry, /can\(user, 'desktop\.broadcast'\)/)
  assert.match(registry, /can\(user, 'system\.maintenance'\)/)
  assert.match(users, /canHoldApprovalPermissions\(form\.role\)/)
  assert.match(users, /role === 'manager' \|\| role === 'editor'/)
  assert.match(users, /setLegalEntities\(normalizeApprovalEntityOptions\(references\.legal_entities\)\)/)
  assert.match(users, /const availableOptions = normalizeApprovalEntityOptions\(options\)/)
  assert.match(users, /Индивидуальные права/)
  assert.match(users, /form\.is_developer/)
  assert.match(users, /RoleCard role="accountant"/)
  assert.match(users, /RoleCard role="manager"/)
  assert.match(users, /users\.permissions/)
  assert.match(users, /option value="accountant"/)
  assert.match(app, /accountant: 'Бухгалтер'/)
  assert.match(app, /manager: 'Руководитель'/)
})

test('maintenance banner is non-blocking and controlled from registry', () => {
  assert.match(app, /system-maintenance-banner/)
  assert.match(app, /api\/system\/maintenance/)
  assert.match(registry, /Ведется обновление|Начать обновление/)
})

test('permission groups keep an independent vertical scroll area', () => {
  assert.match(styles, /\.user-access-body\{[^}]*height:0;[^}]*min-height:0;[^}]*overflow:hidden/)
  assert.match(styles, /\.permission-editor\{[^}]*min-height:0;[^}]*overflow:hidden/)
  assert.match(styles, /\.permission-groups\{[^}]*min-height:0;[^}]*flex:1 1 auto;[^}]*overflow-y:auto/)
  assert.match(styles, /\.permission-groups\{[^}]*grid-auto-rows:max-content/)
  assert.match(styles, /\.user-access-modal>\.modal-head,\.user-access-modal>\.modal-footer\{flex:0 0 auto\}/)
})
