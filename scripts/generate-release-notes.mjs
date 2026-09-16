import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const escapeMarkdown = text => text.replace(/[\\`*_[\]<>]/g, '\\$&')

export function generateReleaseNotes({ tag, repository, cwd = process.cwd() }) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Expected a version tag such as v0.3.0')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected GITHUB_REPOSITORY in owner/repository format')
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error('Release notes require full history; use checkout fetch-depth: 0')
  const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`)
  let previousTag = ''
  try {
    previousTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${commit}^`)
  } catch { /* The first release has no earlier version tag. */ }
  const range = previousTag ? `${previousTag}..${commit}` : commit
  const commits = git('log', '--reverse', '--no-merges', '--format=%H%x09%s', range)
    .split('\n').filter(Boolean).map(line => {
      const separator = line.indexOf('\t')
      return { hash: line.slice(0, separator), subject: line.slice(separator + 1) }
    })
  const url = `https://github.com/${repository}`
  const sections = [`# AI Term ${tag}`]
  // Read the summary from the tagged tree so rerunning an old release is stable.
  const summaryPath = `.github/release-notes/${tag}.md`
  if (git('ls-tree', '--name-only', commit, '--', summaryPath)) sections.push(git('show', `${commit}:${summaryPath}`))
  const groups = new Map([
    ['新增功能', []], ['修复与改进', []], ['文档与维护', []]
  ])
  for (const { hash, subject } of commits) {
    const type = subject.match(/^(\w+)(?:\([^)]*\))?!?:/)?.[1]
    const category = type === 'feat' ? '新增功能' : ['fix', 'perf', 'refactor'].includes(type) ? '修复与改进' : '文档与维护'
    groups.get(category).push(`- ${escapeMarkdown(subject)} ([${hash.slice(0, 7)}](${url}/commit/${hash}))`)
  }
  for (const [title, entries] of groups) {
    if (entries.length) sections.push(`## ${title}\n\n${entries.join('\n')}`)
  }
  if (previousTag) sections.push(`[完整变更：${previousTag} → ${tag}](${url}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)})`)
  sections.push('## 下载\n\n构建产物会由对应平台任务陆续上传：Windows 便携版（ZIP）、Windows 安装包（MSI）、Ubuntu 安装包（DEB）、Linux musl（tar.gz）和 macOS 通用安装包（DMG）。')
  return `${sections.join('\n\n')}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, output] = process.argv.slice(2)
  if (!output) throw new Error('Usage: node scripts/generate-release-notes.mjs <tag> <output.md>')
  writeFileSync(output, generateReleaseNotes({ tag, repository: process.env.GITHUB_REPOSITORY || 'tf1997/ai-term' }))
  console.log(`Generated release notes for ${tag}: ${output}`)
}
