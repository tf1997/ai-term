import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBashScriptTerminalInput, prepareScriptForExecution } from '../src/lib/scriptExecution.ts'
import { shellCommandFromCodeBlock } from '../src/lib/shellCommand.ts'

test('explicit shell code blocks preserve source comments for editing', () => {
  const source = '# 可修改变量\nREPORT_DIR=/tmp/report\necho "$REPORT_DIR"'
  assert.equal(shellCommandFromCodeBlock('bash', source), source)
  assert.equal(shellCommandFromCodeBlock('console', '# apt update'), 'apt update')
  assert.equal(shellCommandFromCodeBlock('', '# rm -rf /tmp/example\necho safe'), '# rm -rf /tmp/example\necho safe')
  assert.equal(shellCommandFromCodeBlock('', '$ echo safe'), 'echo safe')
  const whitespaceSensitive = "cat <<'EOF'\nvalue  \nEOF\n"
  assert.equal(shellCommandFromCodeBlock('bash', whitespaceSensitive), whitespaceSensitive)
})

test('bash comments are filtered without changing physical line numbers', () => {
  const escapedHash = 'echo ' + String.fromCharCode(92) + '#tag'
  const source = [
    '#!/usr/bin/env bash',
    '# 可修改变量',
    'value="tag # inside"',
    'trimmed=${value#tag}',
    'echo foo#bar',
    escapedHash,
    'echo ok # trailing comment',
    "cat <<'EOF' # heredoc marker",
    '# payload data',
    'EOF',
    "printf '%s\\n' '",
    '# multiline string data',
    "'"
  ].join('\n')

  const prepared = prepareScriptForExecution(source, 'bash')
  const lines = prepared.split('\n')
  assert.equal(lines.length, source.split('\n').length)
  assert.equal(lines[0], '#!/usr/bin/env bash')
  assert.equal(lines[1], '')
  assert.equal(lines[2], 'value="tag # inside"')
  assert.equal(lines[3], 'trimmed=${value#tag}')
  assert.equal(lines[4], 'echo foo#bar')
  assert.equal(lines[5], escapedHash)
  assert.equal(lines[6], 'echo ok # trailing comment')
  assert.equal(lines[7], "cat <<'EOF' # heredoc marker")
  assert.equal(lines[8], '# payload data')
  assert.equal(lines[11], '# multiline string data')
})

test('bash filtering preserves ANSI strings and recognizes arithmetic and quoted heredocs', () => {
  const slash = String.fromCharCode(92)
  const source = [
    "printf '%s\\n' $'can" + slash + "'t",
    '# ANSI string data',
    "'",
    'value=$((1 << 2))',
    '# arithmetic comment',
    'cat <<' + slash + 'EOF',
    '# escaped heredoc data',
    'EOF',
    '# after escaped heredoc',
    'cat <<E"ND"',
    '# combined heredoc data',
    'END',
    '# final comment'
  ].join('\n')
  const lines = prepareScriptForExecution(source, 'bash').split('\n')
  assert.equal(lines.length, source.split('\n').length)
  assert.equal(lines[1], '# ANSI string data')
  assert.equal(lines[4], '')
  assert.equal(lines[6], '# escaped heredoc data')
  assert.equal(lines[8], '')
  assert.equal(lines[10], '# combined heredoc data')
  assert.equal(lines[12], '')
})

test('non-bash scripts remain byte-for-byte intact after line-ending normalization', () => {
  const powerShell = [
    '#Requires -Version 7',
    '# ordinary comment',
    "$value = @'",
    '# here-string data',
    "'@",
    'Write-Host "# string"'
  ].join('\n')
  assert.equal(prepareScriptForExecution(powerShell, 'powershell'), powerShell)

  const cmd = [
    'REM ordinary comment',
    '@REM another comment',
    'echo REM is output',
    'REM keep because this redirects > report.txt',
    'REM keep because this chains & echo done',
    ':: pseudo label'
  ].join('\n')
  assert.equal(prepareScriptForExecution(cmd, 'cmd'), cmd)
})

test('comment filtering normalizes CRLF while preserving line count', () => {
  const source = '# comment\r\necho ok\r\n'
  const prepared = prepareScriptForExecution(source, 'bash')
  assert.equal(prepared, '\necho ok\n')
  assert.equal(prepared.split('\n').length, source.replace(/\r\n/g, '\n').split('\n').length)
})

test('terminal script input uses one UTF-8-safe line without heredoc continuation prompts', () => {
  const source = 'log_info "更新服务"\nprintf \'%s\\n\' "$SERVICE_NAME"\n'
  const input = buildBashScriptTerminalInput(source)
  const payload = /printf '%s' '([^']+)'/.exec(input)?.[1]

  assert.ok(payload)
  assert.equal(input.split('\n').length, 2)
  assert.equal(input.includes('AI_TERM_SCRIPT'), false)
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), source)
})
