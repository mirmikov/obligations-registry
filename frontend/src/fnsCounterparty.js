import { normalizeTaxIdInput } from './counterpartyTaxId.js'

function checksum(digits, weights) {
  return weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0) % 11 % 10
}

export function validateFNSTaxID(value = '') {
  const taxID = normalizeTaxIdInput(value)
  if (!taxID) return { taxID, complete: false, valid: false, error: '' }
  if (!/^\d+$/.test(taxID)) return { taxID, complete: false, valid: false, error: 'ИНН должен содержать только цифры' }
  if (taxID.length !== 10 && taxID.length !== 12) {
    return { taxID, complete: false, valid: false, error: taxID.length > 12 ? 'ИНН содержит слишком много цифр' : '' }
  }
  const valid = taxID.length === 10
    ? checksum(taxID, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(taxID[9])
    : checksum(taxID, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(taxID[10]) && checksum(taxID, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(taxID[11])
  return {
    taxID,
    complete: true,
    valid,
    entityType: taxID.length === 10 ? 'legal_entity' : 'individual_entrepreneur',
    error: valid ? '' : 'Некорректный ИНН: проверьте контрольные цифры',
  }
}

export function fnsEntityLabel(entityType) {
  return entityType === 'individual_entrepreneur' ? 'Индивидуальный предприниматель' : 'Организация'
}

export function formatFNSDate(value = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '—'
  const [year, month, day] = value.split('-')
  return `${day}.${month}.${year}`
}

export function safeFNSSourceURL(value = '') {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === 'pb.nalog.ru' ? parsed.href : ''
  } catch {
    return ''
  }
}
