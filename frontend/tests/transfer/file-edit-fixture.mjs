export const target = { sessionId: 'terminal', sessionInstance: 'instance', profileId: 'profile', routeVersion: 0, contextVersion: 1, context: { shell: 'bash', user: '1000', workingDirectory: '/tmp', environmentScope: 'scope' } }
export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export function proposal(n = 1, changes = {}) {
  return { reference: { id: id(n + 100), target }, provider: 'current-terminal', writeStrategy: 'atomic-replace', path: `/tmp/config-${n}`, resolvedPath: `/tmp/config-${n}`, environmentScope: 'a'.repeat(64), revision: 'metadata:before', before: 'before\r\n', after: 'after\r\n', sensitive: false, reviewHash: `review-${n}`, restoreOf: null, restoreAttributes: null, ...changes }
}
export function record(p = proposal(), status = 'applied') {
  return { id: p.reference.id, target: p.reference.target, provider: p.provider, writeStrategy: p.writeStrategy, path: p.path, resolvedPath: p.resolvedPath, environmentScope: p.environmentScope, before: p.before, after: p.after, sensitive: p.sensitive, restoreOf: p.restoreOf, createdAt: 1, outcome: { status, revision: status === 'applied' ? 'metadata:after' : null, contentHash: null, beforeAttributes: { mode: 0o640, uid: 1000, gid: 1000 }, afterAttributes: { mode: 0o640, uid: 1000, gid: 1000 }, error: status === 'applied' ? null : { kind: status === 'conflict' ? 'version-changed' : 'transport', message: status } } }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
