import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeScriptRisks } from '../../src/shared/security/scriptRisk'

function kinds(command) {
  return analyzeScriptRisks(command).map((risk) => risk.kind)
}

test('风险扫描忽略引号中的示例文本和 shell 注释', () => {
  assert.deepEqual(kinds('echo "rm -rf /tmp/example"'), [])
  assert.deepEqual(kinds("printf '%s' 'systemctl restart nginx'"), [])
  assert.deepEqual(kinds('printf ready # rm -rf /tmp/example'), [])
})

test('风险扫描仍识别引号外的真实多命令操作', () => {
  const risks = analyzeScriptRisks('echo ready; rm -rf "/tmp/example"')
  assert.ok(risks.some((risk) => risk.kind === 'delete'))
  assert.equal(risks[0].line, 1)
})

test('多行风险命令只按实际命令文本命中', () => {
  const risks = analyzeScriptRisks([
    '# 示例：rm -rf 不应被注释触发',
    'echo "shutdown now"',
    'systemctl restart nginx'
  ].join('\n'))
  assert.deepEqual([...new Set(risks.map((risk) => risk.kind))], ['service'])
  assert.equal(risks[0].line, 3)
})

test('风险扫描保留真实路径但忽略普通参数中的风险词', () => {
  assert.deepEqual(kinds('systemctl status "reboot"'), [])
  assert.ok(kinds('cp app.conf "/etc/app.conf"').includes('edit'))
  assert.ok(kinds('ip route add 10.0.0.0/24 dev eth0').includes('network'))
  assert.ok(kinds("sh -c 'rm -rf /tmp/example'").includes('execution'))
})
