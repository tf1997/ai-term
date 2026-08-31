/**
 * Returns whether a command argument points at a file that may contain
 * credentials, private keys, or other sensitive local state.
 *
 * Matching is deliberately conservative: a false positive only adds an
 * approval step, while a false negative can disclose file contents.
 */
export function isSensitivePath(path: string) {
  const value = normalizePath(path)
  if (!value) return false

  const slashPath = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  const basename = slashPath.split('/').pop() ?? slashPath
  const lowerPath = slashPath.toLowerCase()
  const lowerBase = basename.toLowerCase()

  if (/(^|\/)\.ssh\/id_[^/]+$/.test(lowerPath) && !lowerBase.endsWith('.pub')) return true
  if (/\.(?:pem|key|p12|pfx|jks)$/.test(lowerBase)) return true
  if (/(^|\/)\.env(?:\.[^/]*)?$/.test(lowerPath)) return true
  if (/(^|\/)\.aws\/credentials$/.test(lowerPath)) return true
  if (/(^|\/)\.kube\/config$/.test(lowerPath)) return true
  if (/(^|\/)\.docker\/config\.json$/.test(lowerPath)) return true
  if (/(^|\/)\.(?:netrc|npmrc|pypirc)$/.test(lowerPath)) return true
  if (/(^|\/)(?:shadow|gshadow|sudoers)(?:[-.]|\/|$)/.test(lowerPath)) return true
  if (/(^|\/)library\/keychains\/[^/]+$/.test(lowerPath) || lowerBase.endsWith('.keychain-db')) return true
  if (/(^|\/)(?:login data|logins\.json|cookies)$/.test(lowerPath)) return true
  return false
}

function normalizePath(path: string) {
  return path
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^file:\/\//i, '')
}
