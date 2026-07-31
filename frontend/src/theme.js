export const THEME_STORAGE_KEY = 'registry_theme'

export function resolveTheme(storedTheme, prefersDark = false) {
  if (storedTheme === 'dark' || storedTheme === 'light') return storedTheme
  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(theme, root = document.documentElement, storage = localStorage) {
  const nextTheme = resolveTheme(theme)
  root.dataset.theme = nextTheme
  root.style.colorScheme = nextTheme
  storage.setItem(THEME_STORAGE_KEY, nextTheme)
  const themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.setAttribute('content', nextTheme === 'dark' ? '#0b1518' : '#153c46')
  return nextTheme
}
