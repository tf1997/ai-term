import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const sourceRoot = path.resolve(import.meta.dirname, '../../src')
const domainRoot = path.join(sourceRoot, 'domains')
const sourceExtensions = /\.(ts|vue)$/
const publicEntryNames = new Set(['index', 'types', 'views', 'api'])
const legacyRoots = ['components', 'composables', 'lib', 'types', 'utils']
const allowedRootEntries = new Set(['app', 'domains', 'shared', 'styles', 'App.vue', 'main.ts', 'vite-env.d.ts'])

function sourceFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(filePath))
    else if (sourceExtensions.test(entry.name)) files.push(filePath)
  }
  return files
}

function importsFrom(source) {
  const imports = []
  const pattern = /(?:\bfrom\s+|\bimport\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) imports.push(match[1])
  return imports
}

function domainName(filePath) {
  return filePath.match(/[\\/]domains[\\/]([^\\/]+)/)?.[1] ?? ''
}

function resolveImport(filePath, specifier) {
  const target = path.normalize(path.resolve(path.dirname(filePath), specifier))
  const candidates = [target, `${target}.ts`, `${target}.vue`, path.join(target, 'index.ts')]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? target
}

test('frontend uses domain-owned source roots instead of legacy technical layers', () => {
  const unexpectedEntries = fs.readdirSync(sourceRoot).filter((entry) => !allowedRootEntries.has(entry))
  assert.deepEqual(unexpectedEntries, [], `unexpected src root entries: ${unexpectedEntries.join(', ')}`)
  for (const directory of legacyRoots) {
    const absolute = path.join(sourceRoot, directory)
    if (!fs.existsSync(absolute)) continue
    assert.equal(sourceFiles(absolute).length, 0, `legacy source files remain in src/${directory}`)
  }
})

test('shared code has no app or domain dependency', () => {
  const violations = []
  for (const filePath of sourceFiles(path.join(sourceRoot, 'shared'))) {
    for (const specifier of importsFrom(fs.readFileSync(filePath, 'utf8'))) {
      if (specifier.includes('/domains/') || specifier.includes('/app/') || specifier.startsWith('../../domains') || specifier.startsWith('../domains')) {
        violations.push(`${path.relative(sourceRoot, filePath)} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(violations, [])
})

test('domains do not depend on app and cross-domain imports use public entries', () => {
  const violations = []
  for (const filePath of sourceFiles(domainRoot)) {
    const currentDomain = domainName(filePath)
    for (const specifier of importsFrom(fs.readFileSync(filePath, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const targetPath = resolveImport(filePath, specifier)
      const targetDomain = domainName(targetPath)
      if (targetPath.includes(`${path.sep}app${path.sep}`)) {
        violations.push(`${path.relative(sourceRoot, filePath)} -> ${specifier}`)
      }
      if (targetDomain && targetDomain !== currentDomain) {
        const targetName = path.basename(targetPath).replace(/\.[^.]+$/, '')
        if (!publicEntryNames.has(targetName)) {
          violations.push(`${path.relative(sourceRoot, filePath)} -> ${specifier} (private cross-domain import)`)
        }
      }
    }
  }
  assert.deepEqual(violations, [])
})
