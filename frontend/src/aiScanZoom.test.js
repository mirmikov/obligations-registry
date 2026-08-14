import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_SCAN_ZOOM_MAX, AI_SCAN_ZOOM_MIN, clampAIScanZoom, nextAIScanZoom } from './aiScanZoom.js'

test('AI scan preview zoom moves by stable 25 percent steps', () => {
  assert.equal(nextAIScanZoom(100, 1), 125)
  assert.equal(nextAIScanZoom(100, -1), 75)
})

test('AI scan preview zoom stays inside readable bounds', () => {
  assert.equal(nextAIScanZoom(AI_SCAN_ZOOM_MIN, -1), AI_SCAN_ZOOM_MIN)
  assert.equal(nextAIScanZoom(AI_SCAN_ZOOM_MAX, 1), AI_SCAN_ZOOM_MAX)
  assert.equal(clampAIScanZoom(Number.NaN), 100)
})
