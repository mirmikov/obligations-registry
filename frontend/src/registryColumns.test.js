import assert from 'node:assert/strict'
import test from 'node:test'
import { getRegistryStickyOffsets } from './registryColumns.js'

test('sticky registry columns remain contiguous after resizing', () => {
  assert.deepEqual(getRegistryStickyOffsets([46, 220, 130, 130]), {
    counterparty: 46,
    entryDate: 266,
    accountType: 396,
    legalEntity: 526,
  })

  assert.deepEqual(getRegistryStickyOffsets([46, 130, 105, 100]), {
    counterparty: 46,
    entryDate: 176,
    accountType: 281,
    legalEntity: 381,
  })

  assert.deepEqual(getRegistryStickyOffsets([46, 317, 188, 142]), {
    counterparty: 46,
    entryDate: 363,
    accountType: 551,
    legalEntity: 693,
  })
})
