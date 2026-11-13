import assert from 'node:assert/strict'
import test from 'node:test'
import { commandWaitHint } from '../../src/domains/ai/domain/agentCommandWait'

test('提示持续监听，区分有限读取和引号中的示例', () => {
  for (const command of ['tail -f app.log', 'tail -F app.log', 'tail --follow=name app.log', 'journalctl -f', 'docker logs --follow app', 'kubectl logs -f app', 'LANG=C LC_ALL=C /usr/bin/tail -f app.log']) {
    assert.match(commandWaitHint(command), /持续监听/, command)
  }
  for (const command of ['tail -n 100 app.log', 'tail -- -f', "echo 'tail -f app.log'", 'ls || true', 'sleep 10']) {
    assert.equal(commandWaitHint(command), '', command)
  }
})
