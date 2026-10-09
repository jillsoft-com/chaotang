<script setup lang="ts">
import { RouterView } from 'vue-router'
import { useDebateStore } from '@/stores/debate'
import { useTheme } from '@/composables/useTheme'
import { onMounted } from 'vue'

const debateStore = useDebateStore()
const { initTheme } = useTheme()

onMounted(() => {
  initTheme()
  debateStore.initializeMinisters()
})
</script>

<template>
  <div id="app">
    <RouterView />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Noto Serif SC', 'SimSun', serif;
}
</style>
