import assert from 'node:assert/strict'
import test from 'node:test'

import { isSensitiveCommand } from '../src/lib/commandPrivacy.ts'

test('command privacy detects common inline credentials', () => {
  const sensitive = [
    'curl --token abc123 https://example.test',
    'tool --api-key=secret-value status',
    'curl -H "Authorization: Bearer token-value" https://example.test',
    'AWS_SECRET_ACCESS_KEY=secret aws s3 ls',
    'git clone https://user:password@example.test/repo.git',
    'echo "-----BEGIN OPENSSH PRIVATE KEY-----"'
  ]

  sensitive.forEach((command) => assert.equal(isSensitiveCommand(command), true, command))
})

test('command privacy keeps ordinary operational commands recordable', () => {
  const ordinary = [
    'systemctl status api',
    'curl https://example.test/health',
    'docker logs --tail 100 api',
    'cat README.md',
    'tool --password-stdin'
  ]

  ordinary.forEach((command) => assert.equal(isSensitiveCommand(command), false, command))
})
