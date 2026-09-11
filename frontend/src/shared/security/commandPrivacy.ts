const SENSITIVE_OPTION_PATTERN = /(?:^|\s)--(?:password|passwd|token|api-key|apikey|secret|client-secret)(?:=|\s+)\S+/i
const AUTHORIZATION_HEADER_PATTERN = /\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+\S+/i
const SECRET_ENV_PATTERN = /(?:^|\s)(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AZURE_OPENAI_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|DATABASE_PASSWORD|DB_PASSWORD|PRIVATE_KEY|CLIENT_SECRET)\s*=\s*\S+/i
const CREDENTIAL_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/i
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i

export function isSensitiveCommand(command: string) {
  const value = command.trim()
  if (!value) return false
  return SENSITIVE_OPTION_PATTERN.test(value)
    || AUTHORIZATION_HEADER_PATTERN.test(value)
    || SECRET_ENV_PATTERN.test(value)
    || CREDENTIAL_URL_PATTERN.test(value)
    || PRIVATE_KEY_PATTERN.test(value)
}
