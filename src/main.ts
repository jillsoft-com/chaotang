import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import './assets/main.css'
import { initializeSkills } from './services/skills'
import { llmService } from './services/llm-config'

// 初始化 Skill 系统（注册工具 + 绑定角色）
initializeSkills()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(ElementPlus, { locale: zhCn })
llmService.ready.then(() => app.mount('#app')).catch((error) => {
  const root = document.getElementById('app')
  if (root) root.textContent = `无法加载模型配置：${error instanceof Error ? error.message : '未知错误'}。请检查系统安全存储后重启。`
})
