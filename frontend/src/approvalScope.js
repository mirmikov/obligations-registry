export function normalizeApprovalEntityOptions(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const result = []
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item?.value
    const value = String(raw || '').trim()
    if (!value) continue
    const key = value.toLocaleLowerCase('ru-RU')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}
