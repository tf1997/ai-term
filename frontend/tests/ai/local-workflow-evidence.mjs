// Called by the opt-in native local acceptance test with its actual persisted
// checkpoint and receipts. No model, command executor or output is fabricated.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { recoveredAgentSteps } from '../../src/domains/ai/domain/agentCheckpoints'
import { recordAgentVerification, agentTaskOutcome } from '../../src/domains/ai/domain/agentTaskProgress'
import { taskScriptSourceFromCheckpoint } from '../../src/domains/ai/domain/agentScriptExport'
import { createTaskScriptDraft } from '../../src/domains/scripts/domain/taskScript'

const { checkpoint, changes } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const steps = recoveredAgentSteps(checkpoint)
const checks = recordAgentVerification(JSON.stringify({
  id: 'http', purpose: '确认配置已在实际响应中生效', required: true,
  check: { kind: 'output-contains', stepId: 'health', expected: 'HTTP 200 response=after generation=1' }
}), [], steps)
assert.equal(checks[0].status, 'passed')
assert.equal(agentTaskOutcome(checkpoint.state.plan, checks), 'verified')
checkpoint.state.verifications = checks
const draft = createTaskScriptDraft(taskScriptSourceFromCheckpoint(checkpoint, changes), ['edit', 'config-check', 'health'])
assert.equal(draft.metadata.source.runId, checkpoint.runId)
assert.deepEqual(draft.metadata.source.stepIds, ['edit', 'config-check', 'health'])
assert.ok(draft.metadata.parameters.some(parameter => parameter.type === 'directory'))
assert.ok(draft.metadata.omittedSteps.some(step => step.stepId === 'reload' && step.reason === 'not-completed'))
assert.equal(draft.metadata.checks[0].id, 'http')
process.stdout.write(JSON.stringify({ checks, draft }))
