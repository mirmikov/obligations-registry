import { normalizeTaxIdInput } from './counterpartyTaxId.js'

export function counterpartyCreationSeed(input = '') {
  const entered = String(input || '').trim()
  const taxID = normalizeTaxIdInput(entered)
  const looksLikeTaxID = Boolean(taxID) && /^[\d\s-]+$/.test(entered)
  if (looksLikeTaxID) return { value: '', taxID, mode: 'fns' }
  return { value: entered, taxID: '', mode: entered ? 'manual' : 'fns' }
}

export function normalizedCounterpartyOptions(options = []) {
  const unique = new Map()
  options.forEach(option => {
    const value = typeof option === 'string' ? option : option?.value
    if (!value || unique.has(value)) return
    const taxID = typeof option === 'string' ? '' : normalizeTaxIdInput(option?.tax_id || '')
    unique.set(value, {
      value,
      taxID,
      searchText: `${value} ${taxID}`.trim().toLocaleLowerCase('ru-RU'),
    })
  })
  return [...unique.values()]
}
