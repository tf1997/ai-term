import { createRenderer } from 'vue'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

export function mountComposable(context, setup) {
  let state
  let disposed = false
  const app = renderer.createApp({ setup() { state = setup(); return () => null } })
  app.mount({})
  const unmount = () => { if (!disposed) { disposed = true; app.unmount() } }
  context.after(unmount)
  return { state, unmount }
}

export function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
