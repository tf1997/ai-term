import { createApp, h, shallowRef } from 'vue'
import CommandPolicyReview from '../../src/domains/terminal/presentation/components/CommandPolicyReview.vue'
import { useCommandPolicyReview } from '../../src/domains/terminal/application/useCommandPolicyReview'
import { createApplicationCommandExecutor } from '../../src/domains/terminal/application/useApplicationCommandExecutor'
import '../../src/app/styles/index.css'

const fixture = window.commandPolicyFixture = { writes: [], approvals: [], cancellations: [], outcome: null, error: '', nextDecision: 'ask', sequence: 0, nativeBoundaryMocked: true }
const tab = { id: 'terminal', title: '测试主机 · operator@fixture', connectionId: 'profile', connectionGeneration: 1 }
const source = Array.from({ length: 70 }, (_, i) => `printf '审查行 ${i + 1}'`).join('\n') + '\nprintf final_review_line'
createApp({ setup() {
  const reviewer = useCommandPolicyReview()
  const pane = {
    async prepareCommandIntent(source, operation) {
      return { reference: { id: `ticket-${++fixture.sequence}`, target: { sessionId: 'session', context: { user: 'operator', workingDirectory: '/srv/project', environmentScope: 'container:fixture-app', ...fixture.options.context } } },
        source, operation, analysis: { highestSeverity: 'high', analysisStatus: 'complete', risks: [{ kind: 'execution', severity: 'high', message: '完整命令需要本次确认', range: { startLine: 71 } }], unknownReasons: [], ...fixture.options.analysis, decision: fixture.nextDecision } }
    },
    dispatchPreparedCommand(intent, _failed, written) { fixture.writes.push(intent.source); written(); return true }
  }
  const { execute } = createApplicationCommandExecutor({ panes: shallowRef({ terminal: pane }), tabs: () => [tab], targets: () => ['terminal'], isAgentControlled: () => false, review: reviewer.review }, {
    async approveCommandIntent(ref, source) { fixture.approvals.push({ id: ref.id, source }) },
    async cancelCommandIntent(ref) { fixture.cancellations.push(ref.id) }
  })
  fixture.start = (options = {}) => {
    fixture.options = options
    fixture.outcome = null; fixture.error = ''
    void execute(options.source ?? source, options.operation ?? 'bash-script').then(value => { fixture.outcome = value }).catch(error => { fixture.error = String(error) })
  }
  fixture.reconnect = () => { tab.connectionGeneration++ }
  return () => [
    h('button', { class: 'policy-fixture-trigger', onClick: () => fixture.start() }, '审查脚本'),
    reviewer.pending.value ? h(CommandPolicyReview, { ...reviewer.pending.value, onResolve: reviewer.resolve }) : null
  ]
} }).mount('#fixture')
