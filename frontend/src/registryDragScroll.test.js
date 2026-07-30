import assert from 'node:assert/strict'
import test from 'node:test'
import { canContinueRegistryDrag, canStartRegistryDrag, getRegistryDragScroll, hasRegistryDragStarted } from './registryDragScroll.js'

test('registry drag starts only from the primary left mouse button', () => {
  assert.equal(canStartRegistryDrag(0, true), true)
  assert.equal(canStartRegistryDrag(1, true), false)
  assert.equal(canStartRegistryDrag(2, true), false)
  assert.equal(canStartRegistryDrag(0, false), false)
})

test('registry drag continues only while the left mouse button remains pressed', () => {
  assert.equal(canContinueRegistryDrag(1), true)
  assert.equal(canContinueRegistryDrag(3), true)
  assert.equal(canContinueRegistryDrag(0), false)
  assert.equal(canContinueRegistryDrag(2), false)
})

test('registry drag waits for deliberate pointer movement', () => {
  assert.equal(hasRegistryDragStarted(100, 100, 103, 103), false)
  assert.equal(hasRegistryDragStarted(100, 100, 105, 100), true)
})

test('registry drag scrolls horizontally, vertically and diagonally', () => {
  assert.deepEqual(getRegistryDragScroll(40, 60, 300, 200, 250, 200), { left: 90, top: 60 })
  assert.deepEqual(getRegistryDragScroll(40, 60, 300, 200, 300, 150), { left: 40, top: 110 })
  assert.deepEqual(getRegistryDragScroll(40, 60, 300, 200, 250, 150), { left: 90, top: 110 })
})
