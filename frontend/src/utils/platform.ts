export function isWindowsPlatform() {
  return `${navigator.platform} ${navigator.userAgent}`.toLowerCase().includes('win')
}
