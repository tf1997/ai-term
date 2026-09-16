import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateReleaseNotes } from './generate-release-notes.mjs'

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ai-term-release-notes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Release Test')
  git('config', 'user.email', 'release-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const commit = subject => git('commit', '--allow-empty', '-m', subject)
  const notes = tag => generateReleaseNotes({ cwd, tag, repository: 'example/ai-term' })
  return { cwd, git, commit, notes }
}

test('release notes include direct commits since the previous tag and exclude later work', t => {
  const { cwd, git, commit, notes } = fixture(t)
  commit('feat: previous feature')
  git('tag', 'v0.2.0')
  commit('feat(scripts): searchable library')
  commit('fix(ui): shared theme')
  mkdirSync(join(cwd, '.github/release-notes'), { recursive: true })
  writeFileSync(join(cwd, '.github/release-notes/v0.3.0.md'), '## 本次更新\n\n- 脚本搜索与主题统一。\n')
  git('add', '.')
  commit('chore(release): prepare v0.3.0')
  git('tag', '-a', 'v0.3.0', '-m', 'v0.3.0')
  const body = notes('v0.3.0')
  assert.match(body, /脚本搜索与主题统一/)
  assert.match(body, /## 新增功能\n\n- feat\(scripts\): searchable library/)
  assert.match(body, /## 修复与改进\n\n- fix\(ui\): shared theme/)
  assert.match(body, /compare\/v0\.2\.0\.\.\.v0\.3\.0/)
  assert.doesNotMatch(body, /previous feature/)
  writeFileSync(join(cwd, '.github/release-notes/v0.3.0.md'), 'later summary')
  git('add', '.')
  commit('feat: later feature')
  git('tag', 'v0.4.0')
  assert.equal(notes('v0.3.0'), body, 'Reruns use the tagged tree and never append duplicate notes')
})

test('first release and a later release without a summary both contain their new features', t => {
  const { git, commit, notes } = fixture(t)
  commit('feat: initial terminal')
  git('tag', 'v0.1.0')
  assert.match(notes('v0.1.0'), /initial terminal/)
  assert.doesNotMatch(notes('v0.1.0'), /compare\//)
  commit('feat: next feature')
  git('tag', 'v0.2.0')
  assert.match(notes('v0.2.0'), /next feature/)
  assert.doesNotMatch(notes('v0.2.0'), /initial terminal/)
})

test('invalid or missing tags fail instead of publishing notes for the wrong revision', t => {
  const { notes } = fixture(t)
  assert.throws(() => notes('../main'), /Expected a version tag/)
  assert.throws(() => notes('v9.9.9'))
})
