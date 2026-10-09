import { ref, watch } from 'vue'

const THEME_KEY = 'chaotang_theme'

const isDark = ref(false)

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved !== null) {
    isDark.value = saved === 'dark'
  } else {
    // 默认跟随系统
    isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  applyTheme()
}

function applyTheme() {
  const html = document.documentElement
  if (isDark.value) {
    html.classList.add('dark')
  } else {
    html.classList.remove('dark')
  }
}

function toggleTheme() {
  isDark.value = !isDark.value
}

function setTheme(dark: boolean) {
  isDark.value = dark
}

watch(isDark, () => {
  localStorage.setItem(THEME_KEY, isDark.value ? 'dark' : 'light')
  applyTheme()
})

export function useTheme() {
  return {
    isDark,
    initTheme,
    toggleTheme,
    setTheme
  }
}
