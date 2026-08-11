import assert from 'node:assert/strict'
import test from 'node:test'

import { clearConversationUnread, normalizeUnreadSnapshot, takeConversationUnread } from './chatUnread.js'

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
