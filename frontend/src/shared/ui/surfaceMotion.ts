/** Keep a leaving docked panel's width while the workspace settles once. */
export function captureSurfaceWidth(element: Element) {
  if (element instanceof HTMLElement) element.style.setProperty('--surface-leave-width', `${element.getBoundingClientRect().width}px`)
}
