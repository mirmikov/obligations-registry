import assert from 'node:assert/strict'
import test from 'node:test'

import { clearConversationUnread, conversationMarker, normalizeUnreadSnapshot, takeConversationUnread, unreadIncreases } from './chatUnread.js'

test('opening a conversation clears only its unread badge immediately', () => {
  const conversations = [{ id: 11, unread: 3 }, { id: 12, unread: 2 }]
  const next = clearConversationUnread(conversations, 11)
  assert.deepEqual(next, [{ id: 11, unread: 0 }, { id: 12, unread: 2 }])
  assert.equal(conversations[0].unread, 3)
})

test('global unread counter removes the opened conversation count', () => {
  const counts = new Map([[11, 3], [12, 2]])
  assert.equal(takeConversationUnread(counts, '11'), 3)
  assert.equal(counts.get(11), 0)
  assert.equal(counts.get(12), 2)
})

test('late polling response cannot restore a badge for an opened conversation', () => {
  const suppressed = new Set(['11'])
  const stale = normalizeUnreadSnapshot([{ id: 11, unread: 3 }, { id: 12, unread: 2 }], suppressed)
  assert.equal(stale.total, 2)
  assert.equal(stale.unreadByConversation.get(11), 0)
  assert.equal(suppressed.has('11'), true)

  const confirmed = normalizeUnreadSnapshot([{ id: 11, unread: 0 }, { id: 12, unread: 2 }], suppressed)
  assert.equal(confirmed.total, 2)
  assert.equal(suppressed.has('11'), false)
})

test('unread increases are detected by conversation regardless of id type', () => {
  const conversations = [{ id: 11, unread: 3 }, { id: 12, unread: 1 }, { id: 13, unread: 0 }]
  const previous = new Map([['11', 1], [12, 1]])
  const next = new Map([[11, 3], ['12', 1], [13, 0]])

  assert.deepEqual(unreadIncreases(conversations, previous, next), [
    { conversation: conversations[0], added: 2 },
  ])
})

test('read suppression ignores stale polling but releases a genuinely newer message', () => {
  const readConversation = { id: 11, unread: 3, last_at: '2026-08-11 10:00:00', last_sender: 'Ольга', last_message: 'Прочитано' }
  const suppressed = new Map([['11', conversationMarker(readConversation)]])

  const stale = normalizeUnreadSnapshot([readConversation], suppressed)
  assert.equal(stale.total, 0)
  assert.equal(suppressed.has('11'), true)

  const newer = { ...readConversation, unread: 1, last_at: '2026-08-11 10:01:00', last_message: 'Новое сообщение' }
  const next = normalizeUnreadSnapshot([newer], suppressed)
  assert.equal(next.total, 1)
  assert.equal(suppressed.has('11'), false)
})
