export function can(user, permission) {
  return Boolean(user?.is_developer || user?.permissions?.[permission])
}

export const pagePermissions = {
  dashboard: 'dashboard.view',
  executive: 'executive.view',
  registry: 'registry.view',
  'credits-leasing': 'credits.view',
  payments: 'payments.view',
  chat: 'chat.view',
  references: 'references.view',
  users: 'users.view',
  audit: 'audit.view',
}

export function firstAllowedPage(user) {
  return ['dashboard', 'registry', 'payments', 'chat', 'executive', 'credits-leasing', 'references', 'users', 'audit']
    .find(page => can(user, pagePermissions[page])) || 'access-denied'
}
