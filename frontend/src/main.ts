import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { isWindowsPlatform } from './utils/platform'

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
