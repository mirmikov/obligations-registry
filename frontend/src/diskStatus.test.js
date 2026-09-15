import assert from 'node:assert/strict'
import test from 'node:test'
import { diskStatusPresentation, diskStatusTooltip, formatDiskBytes } from './diskStatus.js'

test('disk usage is presented in GiB for the developer', () => {
  const status = { state: 'available', used_percent: 21, used_bytes: 40 * 1024 ** 3, total_bytes: 200 * 1024 ** 3, available_bytes: 160 * 1024 ** 3 }
  assert.deepEqual(diskStatusPresentation(status), { title: 'Диск VM · 21%', subtitle: '40 ГБ из 200 ГБ', tone: 'success' })
  assert.match(diskStatusTooltip(status), /Свободно 160 ГБ/)
  assert.equal(formatDiskBytes(1536 * 1024 ** 2), '1,5 ГБ')
})

test('disk usage warns before the VM is full', () => {
  assert.equal(diskStatusPresentation({ state: 'available', used_percent: 84 }).tone, 'warning')
  assert.equal(diskStatusPresentation({ state: 'available', used_percent: 93 }).tone, 'error')
  assert.equal(diskStatusPresentation(null).subtitle, 'Нет данных')
})
