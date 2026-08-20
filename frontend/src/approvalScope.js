export const approvalPermissionKeys = ['obligations.approve', 'executive.approve', 'credits.approve', 'priority_center.approve']

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

export function withApprovalScope(form, values) {
  return {
    ...form,
    approval_legal_entities: normalizeApprovalEntityOptions(values),
    permissions: {
      ...(form.permissions || {}),
      'obligations.approve': true,
      'registry.view': true,
    },
  }
}

export function withApprovalEnabled(form, enabled) {
  const permissions = { ...(form.permissions || {}), 'obligations.approve': Boolean(enabled) }
  if (enabled) permissions['registry.view'] = true
  else approvalPermissionKeys.forEach(key => { permissions[key] = false })
  return {
    ...form,
    permissions,
    approval_legal_entities: enabled ? normalizeApprovalEntityOptions(form.approval_legal_entities) : [],
  }
}
