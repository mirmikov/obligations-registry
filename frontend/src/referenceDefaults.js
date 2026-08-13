import { withDerivedObligationValues } from './obligationValues.js'

export function buildCostCategoryResponsibleMap(references = {}) {
  const categoriesById = new Map((references.cost_categories || []).map(item => [Number(item.id), item.value]))
  return Object.fromEntries((references.cost_category_responsibles || []).flatMap(item => {
    const category = categoriesById.get(Number(item.cost_category_id))
    const responsible = String(item.responsible || '').trim()
    return category && responsible ? [[category, responsible]] : []
  }))
}

export function buildCounterpartyDefermentMap(references = {}) {
  const counterpartiesById = new Map((references.counterparties || []).map(item => [Number(item.id), item.value]))
  return Object.fromEntries((references.counterparty_deferments || []).flatMap(item => {
    const counterparty = counterpartiesById.get(Number(item.counterparty_id))
    const defermentDays = Number(item.deferment_days)
    return counterparty && Number.isInteger(defermentDays) && defermentDays >= 0 ? [[counterparty, defermentDays]] : []
  }))
}

export function withDefaultResponsible(values, changedField, responsibleByCostCategory = {}) {
  if (changedField !== 'cost_category') return values
  const responsible = responsibleByCostCategory[values.cost_category]
  return responsible ? { ...values, responsible } : values
}

export function withDefaultCounterpartyDeferment(values, changedField, defermentByCounterparty = {}) {
  if (changedField !== 'counterparty' || !Object.prototype.hasOwnProperty.call(defermentByCounterparty, values.counterparty)) return values
  return { ...values, deferment_days: defermentByCounterparty[values.counterparty] }
}

export function withReferenceDefaults(values, changedField, responsibleByCostCategory = {}, defermentByCounterparty = {}) {
  let next = withDefaultResponsible(values, changedField, responsibleByCostCategory)
  const hasDefermentDefault = changedField === 'counterparty' && Object.prototype.hasOwnProperty.call(defermentByCounterparty, next.counterparty)
  next = withDefaultCounterpartyDeferment(next, changedField, defermentByCounterparty)
  next = withDerivedObligationValues(next, changedField)
  return hasDefermentDefault ? withDerivedObligationValues(next, 'deferment_days') : next
}
