import assert from 'node:assert/strict'
import test from 'node:test'
import { canStartRegistryDrag, getRegistryDragScroll, hasRegistryDragStarted } from './registryDragScroll.js'

test('registry drag starts only from the primary left mouse button', () => {
  assert.equal(canStartRegistryDrag(0, true), true)
  assert.equal(canStartRegistryDrag(1, true), false)
  assert.equal(canStartRegistryDrag(2, true), false)
  assert.equal(canStartRegistryDrag(0, false), false)
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
