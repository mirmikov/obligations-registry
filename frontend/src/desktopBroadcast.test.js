import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDesktopBroadcastPayload } from './desktopBroadcast.js'

test('desktop broadcast payload is trimmed and targets all active users', () => {
  assert.deepEqual(buildDesktopBroadcastPayload({ title: '  Обновление  ', body: '  Обновите страницу  ', action_url: '/?page=registry' }), {
    kind: 'system.broadcast', title: 'Обновление', body: 'Обновите страницу', action_url: '/?page=registry', user_ids: [],
  })
})

test('desktop broadcast rejects an unknown navigation target', () => {
  assert.equal(buildDesktopBroadcastPayload({ title: 'Тест', body: 'Текст', action_url: 'https://example.org' }).action_url, '')
})
