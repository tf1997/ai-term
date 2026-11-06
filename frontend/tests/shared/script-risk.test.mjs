import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeScriptRisks, summarizeScriptRisks, scriptRiskLevelForRisks, buildScriptRiskPreviewLines } from '../../src/shared/security/scriptRisk'
import { MAX_RISK_SCAN_CHARS } from '../../src/shared/security/shellCommandScan'
import { isSensitiveAgentCommand } from '../../src/domains/ai/domain/aiConversation'
import { commandRiskCases } from './command-risk-cases.mjs'

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

for (const { name, command, kind, severity = 'high' } of commandRiskCases) {
  test(`已确认风险回归：${name}`, () => {
    assert.ok(kinds(command).includes(kind), command)
    assert.equal(scriptRiskLevelForRisks(analyzeScriptRisks(command)), severity)
  })
}

test('同一行同类命中保留后续高风险及独立命令记录', () => {
  const risks = analyzeScriptRisks("sed -i 's/a/b/' local.conf; cp app.conf /etc/app.conf; cp app.conf /boot/app.conf")
  assert.deepEqual(risks.filter(risk => risk.kind === 'edit').map(risk => risk.severity), ['medium', 'high', 'high'])
  assert.equal(summarizeScriptRisks(risks)[0].severity, 'high')
  assert.equal(scriptRiskLevelForRisks(risks), 'high')
})

test('续行和多行字面量保持真实命令的物理行号', () => {
  const command = "printf '%s' 'example:\nrm -rf /tmp/data'\nrm \\\n  --recursive /tmp/example"
  const risks = analyzeScriptRisks(command)
  assert.ok(risks.length)
  assert.ok(risks.every(risk => risk.line === 3))
  assert.equal(buildScriptRiskPreviewLines(command, risks)[2].riskClass, 'risk-delete')
})

test('字面量、注释和转义替换不被当作实际执行', () => {
  for (const command of [
    String.raw`printf '%s' '$(rm -rf /tmp/example)'`,
    String.raw`echo "\$(rm -rf /tmp/example)"`,
    String.raw`printf '%s' '$\x27rm -rf\x27'`,
    'echo ready;# rm -rf /tmp/example\nls',
    'echo rm -rf /tmp/example',
    'systemctl status reboot',
    "echo 'PATH=/tmp/bin'",
    "printf '%s' 'line one\nrm -rf /tmp/example'",
    'ls > "/dev/null" 2>&1',
    "printf -- '%%n'",
    "printf -- '%s' '%n'",
    'file -- -C',
    'rg -- --hostname-bin=./hook.sh'
  ]) assert.deepEqual(kinds(command), [], command)
})

test('原有 Windows 命令风险保留原生路径语义', () => {
  for (const command of [String.raw`del C:\Windows\example.ini`, String.raw`copy local.ini C:\Windows\example.ini`, String.raw`C:\Windows\System32\shutdown.exe /r`]) {
    assert.equal(scriptRiskLevelForRisks(analyzeScriptRisks(command)), 'high', command)
  }
})

test('heredoc 数据不冒充命令，未支持结构仍必须审查', () => {
  const risks = analyzeScriptRisks("cat <<'EOF'\nrm -rf /tmp/example\nEOF")
  assert.ok(risks.some(risk => risk.kind === 'execution' && risk.line === 1))
  assert.ok(!risks.some(risk => risk.kind === 'delete'))
})

test('长命令检查末尾风险，超限不返回安全结论', () => {
  const prefix = 'printf ready;'.repeat(4000)
  assert.deepEqual(kinds(prefix), [])
  assert.ok(kinds(prefix + 'rm -rf /tmp/example').includes('delete'))
  const overBudget = ' '.repeat(MAX_RISK_SCAN_CHARS) + 'rm -rf /tmp/example'
  assert.ok(analyzeScriptRisks(overBudget).some(risk => /上限/.test(risk.message)))
  assert.equal(scriptRiskLevelForRisks(analyzeScriptRisks(overBudget)), 'high')
  assert.equal(isSensitiveAgentCommand(' '.repeat(MAX_RISK_SCAN_CHARS) + 'cat ~/.ssh/id_rsa'), true)
})
