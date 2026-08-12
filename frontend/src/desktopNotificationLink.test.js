import test from 'node:test'
import assert from 'node:assert/strict'
import { readDesktopNotificationTarget } from './desktopNotificationLink.js'

test('desktop notification deep link opens an exact chat conversation', () => {
  assert.deepEqual(readDesktopNotificationTarget('?page=chat&conversation=42'), { page: 'chat', conversationID: 42, aiScanBatch: null })
})

test('desktop notification deep link accepts known pages without unsafe conversation values', () => {
  assert.deepEqual(readDesktopNotificationTarget('?page=registry'), { page: 'registry', conversationID: null, aiScanBatch: null })
  assert.deepEqual(readDesktopNotificationTarget('?page=chat&conversation=javascript:1'), { page: 'chat', conversationID: null, aiScanBatch: null })
  assert.equal(readDesktopNotificationTarget('?page=unknown&conversation=42'), null)
})

test('desktop AI scan deep link accepts only a 48 character batch token on registry page', () => {
  const batch = '0123456789abcdef0123456789abcdef0123456789abcdef'
  assert.deepEqual(readDesktopNotificationTarget(`?page=registry&ai_scan_batch=${batch}`), { page: 'registry', conversationID: null, aiScanBatch: batch })
  assert.equal(readDesktopNotificationTarget('?page=registry&ai_scan_batch=../../secret').aiScanBatch, null)
  assert.equal(readDesktopNotificationTarget(`?page=chat&ai_scan_batch=${batch}`).aiScanBatch, null)
})
