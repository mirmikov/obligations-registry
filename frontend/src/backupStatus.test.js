import assert from 'node:assert/strict'
import test from 'node:test'
import { backupStatusPresentation, backupStatusTooltip } from './backupStatus.js'

test('completed backup displays its application version', () => {
  assert.deepEqual(backupStatusPresentation({ state: 'completed', version: '98f696f' }), { tone: 'success', title: 'Бэкап выполнен', subtitle: 'Версия 98f696f' })
})

test('missed backup is shown as an error', () => {
  const view = backupStatusPresentation({ state: 'overdue' })
  assert.equal(view.tone, 'error')
  assert.match(view.title, /не выполнен/i)
})

test('tooltip includes database and application versions', () => {
  const tooltip = backupStatusTooltip({ state: 'completed', version: '98f696f', database_version: '17.5' })
  assert.match(tooltip, /98f696f/)
  assert.match(tooltip, /17\.5/)
})
