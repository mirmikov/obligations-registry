import { buildAdvancedSplitPayload, isAdvancedSplitMode } from './advancedPaymentSplit.js'

export function buildPaymentSplitPayload(form, preview) {
  if (isAdvancedSplitMode(form.mode)) return buildAdvancedSplitPayload(form, preview)

  if (form.mode === 'count') {
    return {
      mode: 'count',
      count: Number(form.count),
      payment_dates: [...form.payment_dates],
    }
  }

  if (form.mode === 'amount') {
    return {
      mode: 'amount',
      amount_parts: form.amount_parts.map(part => ({
        amount: Number(part.amount),
        account_type: part.account_type,
        planned_date: part.planned_date,
      })),
    }
  }

  if (form.mode === 'percentage') {
    return {
      mode: 'percentage',
      percentage_parts: form.percentage_parts.map(part => ({
        percent: Number(part.percent),
        account_type: part.account_type,
        planned_date: part.planned_date,
      })),
    }
  }

  return null
}
