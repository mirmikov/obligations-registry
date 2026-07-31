export function buildCostCategoryResponsibleMap(references = {}) {
  const categoriesById = new Map((references.cost_categories || []).map(item => [Number(item.id), item.value]))
  return Object.fromEntries((references.cost_category_responsibles || []).flatMap(item => {
    const category = categoriesById.get(Number(item.cost_category_id))
    const responsible = String(item.responsible || '').trim()
    return category && responsible ? [[category, responsible]] : []
  }))
}

export function withDefaultResponsible(values, changedField, responsibleByCostCategory = {}) {
  if (changedField !== 'cost_category') return values
  const responsible = responsibleByCostCategory[values.cost_category]
  return responsible ? { ...values, responsible } : values
}
