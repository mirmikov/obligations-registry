import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCostCategoryResponsibleMap, buildCounterpartyDefermentMap, withDefaultCounterpartyDeferment, withDefaultResponsible, withReferenceDefaults } from './referenceDefaults.js'

test('reference mappings are joined to cost category names', () => {
  const result = buildCostCategoryResponsibleMap({
    cost_categories: [{ id: 17, value: 'Аренда' }],
    cost_category_responsibles: [{ cost_category_id: 17, responsible: 'Иванов И.И.' }],
  })
  assert.deepEqual(result, { Аренда: 'Иванов И.И.' })
})

test('choosing a mapped cost category sets its default responsible', () => {
  const result = withDefaultResponsible({ cost_category: 'Аренда', responsible: 'Петров П.П.' }, 'cost_category', { Аренда: 'Иванов И.И.' })
  assert.equal(result.responsible, 'Иванов И.И.')
})

test('manual responsible changes are preserved', () => {
  const result = withDefaultResponsible({ cost_category: 'Аренда', responsible: 'Петров П.П.' }, 'responsible', { Аренда: 'Иванов И.И.' })
  assert.equal(result.responsible, 'Петров П.П.')
})

test('an unmapped category does not clear an existing responsible', () => {
  const result = withDefaultResponsible({ cost_category: 'Прочие расходы', responsible: 'Петров П.П.' }, 'cost_category', { Аренда: 'Иванов И.И.' })
  assert.equal(result.responsible, 'Петров П.П.')
})

test('counterparty deferment mappings are joined to counterparty names including zero days', () => {
  const result = buildCounterpartyDefermentMap({
    counterparties: [{ id: 7, value: 'ООО Альфа' }, { id: 8, value: 'ИП Бета' }],
    counterparty_deferments: [{ counterparty_id: 7, deferment_days: 30 }, { counterparty_id: 8, deferment_days: 0 }],
  })
  assert.deepEqual(result, { 'ООО Альфа': 30, 'ИП Бета': 0 })
})

test('choosing a mapped counterparty replaces deferment but a manual deferment edit is preserved', () => {
  const defaults = { 'ООО Альфа': 30 }
  assert.equal(withDefaultCounterpartyDeferment({ counterparty: 'ООО Альфа', deferment_days: 5 }, 'counterparty', defaults).deferment_days, 30)
  assert.equal(withDefaultCounterpartyDeferment({ counterparty: 'ООО Альфа', deferment_days: 5 }, 'deferment_days', defaults).deferment_days, 5)
})

test('counterparty default recalculates planned payment date from document date', () => {
  const result = withReferenceDefaults({
    counterparty: 'ООО Альфа', document_date: '2026-08-13', deferment_days: null, planned_payment_date: '', responsible: '', cost_category: '',
  }, 'counterparty', {}, { 'ООО Альфа': 30 })
  assert.equal(result.deferment_days, 30)
  assert.equal(result.planned_payment_date, '2026-09-12')
})

test('unmapped counterparty does not erase a manually entered deferment', () => {
  const result = withReferenceDefaults({ counterparty: 'ООО Без настройки', deferment_days: 14 }, 'counterparty', {}, { 'ООО Альфа': 30 })
  assert.equal(result.deferment_days, 14)
})
