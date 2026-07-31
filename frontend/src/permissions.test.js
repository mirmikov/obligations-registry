import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { can, pagePermissions } from './permissions.js'

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

test('navigation, registry actions and access editor are permission driven', () => {
  assert.match(app, /permission: 'executive\.view'/)
  assert.match(app, /can\(user, 'registry\.undo'\)/)
  assert.match(registry, /can\(user, 'registry\.delete'\)/)
  assert.match(registry, /user\.is_developer/)
  assert.match(users, /Индивидуальные права/)
  assert.match(users, /form\.is_developer/)
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
