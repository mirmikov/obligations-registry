export function normalizeTaxIdInput(value = '') {
  return String(value).replace(/[\s-]+/g, '')
}

function counterpartyAliases(item) {
  return Array.isArray(item?.aliases) ? item.aliases.filter(Boolean).join(' ') : ''
}

export function filterCounterparties(items = [], query = '') {
  const term = String(query).trim().toLocaleLowerCase('ru-RU')
  if (!term) return items
  return items.filter(item => `${item.value || ''} ${item.tax_id || ''} ${counterpartyAliases(item)}`.toLocaleLowerCase('ru-RU').includes(term))
}

export function referenceOptionSearchText(option) {
  if (typeof option === 'string') return option
  return `${option?.value || ''} ${option?.tax_id || ''} ${counterpartyAliases(option)}`.trim()
}
