import assert from 'node:assert/strict'
import test from 'node:test'
import { isSensitivePath } from "../../src/shared/security/pathPrivacy"

test('敏感凭据与私钥路径被拦截', () => {
  for (const path of [
    '~/.ssh/id_rsa',
    '/Users/dev/.ssh/id_ed25519',
    '$HOME/.env.production',
    '/home/dev/.aws/credentials',
    '/home/dev/.kube/config',
    '/home/dev/.docker/config.json',
    '/home/dev/.netrc',
    '/etc/shadow',
    '/etc/sudoers.d/ops',
    '/tmp/server.pem',
    '/Users/dev/Library/Keychains/login.keychain-db',
    '/Users/dev/Library/Application Support/Google/Chrome/Default/Login Data'
  ]) {
    assert.equal(isSensitivePath(path), true, path)
  }
})

test('公开项目路径与公钥不误判', () => {
  for (const path of [
    '/Users/dev/project/src/main.ts',
    '/Users/dev/.ssh/id_rsa.pub',
    '/tmp/target',
    '/var/log/system.log'
  ]) {
    assert.equal(isSensitivePath(path), false, path)
  }
})
