export const BLANK_ACCOUNT_TYPE_FILTER = '__blank__'

export function filterSelectOptions(options, query) {
  const term = String(query || '').trim().toLocaleLowerCase('ru-RU')
  if (!term) return options
  return options.filter(option => option.label.toLocaleLowerCase('ru-RU').includes(term))
}
