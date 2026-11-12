import { createApp } from 'vue'
import App from './app/App.vue'
import './app/styles/index.css'
import { desktopPlatform } from './shared/platform/platform'

async function bootstrap() {
  const platform = desktopPlatform()
  document.documentElement.dataset.platform = platform
  await Promise.all([
    import('@fontsource/jetbrains-mono/400.css'),
    import('@fontsource/jetbrains-mono/500.css'),
    import('@fontsource/jetbrains-mono/600.css'),
    import('@fontsource/jetbrains-mono/700.css'),
    import('@fontsource/fira-code/400.css'),
    import('@fontsource/fira-code/600.css'),
    import('@fontsource/fira-code/700.css'),
    ...(platform === 'windows' || platform === 'linux' ? [import('@fontsource-variable/noto-sans-sc')] : [])
  ])

  createApp(App).mount('#app')
}

void bootstrap()
