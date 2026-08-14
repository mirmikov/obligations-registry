export function can(user, permission) {
  return Boolean(user?.is_developer || user?.permissions?.[permission])
}

export function canApproveObligations(user) {
  return Boolean(user?.is_developer || user?.role === 'developer' || user?.role === 'manager')
}

export function approvalStatusOptions(options = [], userOrAllowed) {
  const allowed = typeof userOrAllowed === 'boolean' ? userOrAllowed : canApproveObligations(userOrAllowed)
  return allowed ? options : options.filter(option => (typeof option === 'string' ? option : option?.value) !== 'К оплате')
}

export const pagePermissions = {
  dashboard: 'dashboard.view',
  'my-invoices': 'my_invoices.view',
  executive: 'executive.view',
  registry: 'registry.view',
  'credits-leasing': 'credits.view',
  'priority-center': 'priority_center.view',
  payments: 'payments.view',
  chat: 'chat.view',
  references: 'references.view',
  users: 'users.view',
  audit: 'audit.view',
}

export function firstAllowedPage(user) {
  return ['dashboard', 'my-invoices', 'registry', 'priority-center', 'payments', 'chat', 'executive', 'credits-leasing', 'references', 'users', 'audit']
    .find(page => can(user, pagePermissions[page])) || 'access-denied'
}
