import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { isWindowsPlatform } from './utils/platform'

async function bootstrap() {
  if (isWindowsPlatform()) {
    document.documentElement.dataset.platform = 'windows'
    await Promise.all([
      import('@fontsource/noto-sans-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-500.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-600.css'),
      import('@fontsource/jetbrains-mono/400.css'),
      import('@fontsource/jetbrains-mono/500.css')
    ])
  }

  createApp(App).mount('#app')
}

void bootstrap()
