export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'other'

export function desktopPlatform(): DesktopPlatform {
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes('win')) return 'windows'
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('linux')) return 'linux'
  return 'other'
}

export function isWindowsPlatform() {
  return desktopPlatform() === 'windows'
}
