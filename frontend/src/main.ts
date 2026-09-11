import { createApp } from 'vue'
import App from './App.vue'
import "./styles/index.css"
import { isWindowsPlatform } from './shared/platform/platform'

async function bootstrap() {
  if (isWindowsPlatform()) {
    document.documentElement.dataset.platform = 'windows'
    await Promise.all([
      import('@fontsource-variable/noto-sans-sc'),
      import('@fontsource/jetbrains-mono/400.css'),
      import('@fontsource/jetbrains-mono/500.css'),
      import('@fontsource/jetbrains-mono/600.css')
    ])
  }

  createApp(App).mount('#app')
}

void bootstrap()
