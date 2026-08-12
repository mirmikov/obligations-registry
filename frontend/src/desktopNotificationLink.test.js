import test from 'node:test'
import assert from 'node:assert/strict'
import { readDesktopNotificationTarget } from './desktopNotificationLink.js'

test('desktop notification deep link opens an exact chat conversation', () => {
  assert.deepEqual(readDesktopNotificationTarget('?page=chat&conversation=42'), { page: 'chat', conversationID: 42 })
})

test('desktop notification deep link accepts known pages without unsafe conversation values', () => {
  assert.deepEqual(readDesktopNotificationTarget('?page=registry'), { page: 'registry', conversationID: null })
  assert.deepEqual(readDesktopNotificationTarget('?page=chat&conversation=javascript:1'), { page: 'chat', conversationID: null })
  assert.equal(readDesktopNotificationTarget('?page=unknown&conversation=42'), null)
})
