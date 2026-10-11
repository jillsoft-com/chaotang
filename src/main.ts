import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/main.css'
import { initializeAppStorage } from './services/storage'

async function bootstrap(): Promise<void> {
  // 先迁移并加载旧数据，再导入会在模块初始化时读取配置的业务单例。
  await initializeAppStorage()
  const [{ default: App }, { default: router }, { initializeSkills }, { llmService }, { memoryStore }] = await Promise.all([
    import('./App.vue'),
    import('./router'),
    import('./services/skills'),
    import('./services/llm-config'),
    import('./services/memory')
  ])
  initializeSkills()
  await Promise.all([llmService.ready, memoryStore.ready])
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.use(ElementPlus, { locale: zhCn })
  app.mount('#app')
  window.addEventListener('app-storage-error', (event) => {
    const message = (event as CustomEvent<string>).detail
    ElMessage.error(`本地数据保存失败：${message}`)
  })
}

bootstrap().catch((error) => {
  const root = document.getElementById('app')
  if (root) root.textContent = `无法加载本地数据：${error instanceof Error ? error.message : '未知错误'}。旧数据仍保留，请检查磁盘与系统安全存储后重启。`
})
