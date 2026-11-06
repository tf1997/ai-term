export const origin = { sessionId: 'terminal', sessionInstance: 'instance', profileId: 'profile', routeVersion: 0, contextVersion: 1, context: { shell: 'bash', user: '1000', workingDirectory: '/interactive', environmentScope: 'container' } }
export const request = { command: 'printf hello', workingDirectory: '/srv/app', environment: {}, timeoutMs: 120000 }
export const target = { profileId: 'profile', host: 'ssh.fixture.invalid', user: 'deploy', port: 22, gateway: null }
export const intent = { reference: { id: 'task', origin, policyVersion: 'test' }, request, target, effectiveEnvironment: { PATH: '/usr/local/bin:/usr/bin:/bin' }, analysis: { decision: 'ask', analysisStatus: 'complete', risks: [], unknownReasons: [], policyVersion: 'test', highestSeverity: null }, expiresInMs: 300000 }
export const snapshot = { reference: intent.reference, target, sequence: 3, status: 'completed', stdout: '你好', stderr: 'diagnostic', outputBytes: 16, truncated: false, exitCode: 7, exitSignal: null, exitEvidence: 'shell-trailer-and-channel-close', reason: null, startedAt: 1000, finishedAt: 1200 }
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
