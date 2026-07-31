import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCostCategoryResponsibleMap, withDefaultResponsible } from './referenceDefaults.js'

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
