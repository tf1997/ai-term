const explicitShellLanguages = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'fish',
  'ksh',
  'ash',
  'dash',
  'bat',
  'batch',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'ps1'
])

const shellSessionLanguages = new Set([
  'console',
  'terminal',
  'session',
  'shell-session',
  'bash-session',
  'sh-session',
  'zsh-session',
  'powershell-session',
  'pwsh-session',
  'cmd-session'
])

const languageAliases: Record<string, string> = {
  batchfile: 'bat',
  dosbatch: 'bat',
  ps: 'powershell',
  shellscript: 'shell',
  'shell-script': 'shell',
  'bash-script': 'bash',
  'powershell-script': 'powershell',
  'cmd-script': 'cmd'
}

export type ShellScriptLanguage = 'bash' | 'powershell' | 'cmd' | 'shell'

const lowSignalCommands = new Set(['and', 'but', 'for', 'if', 'then', 'this', 'that', 'the', 'with'])

const commandPrefixes = new Set([
  'sudo',
  'su',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'brew',
  'systemctl',
  'service',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'rm',
  'cp',
  'mv',
  'sed',
  'awk',
  'grep',
  'find',
  'chmod',
  'chown',
  'curl',
  'wget',
  'echo',
  'cat',
  'mkdir',
  'touch',
  'tar',
  'ssh',
  'scp',
  'rsync',
  'ls',
  'cd',
  'pwd',
  'ps',
  'top',
  'htop',
  'free',
  'df',
  'du',
  'uname',
  'whoami',
  'hostname',
  'ip',
  'ifconfig',
  'netstat',
  'ss',
  'journalctl',
  'crontab',
  'export',
  'source',
  'bash',
  'sh',
  'zsh',
  'fish',
  'python',
  'python3',
  'node',
  'npm',
  'yarn',
  'pnpm',
  'git',
  'make',
  'cargo',
  'go',
  'rustup',
  'java',
  'javac',
  'mvn',
  'gradle',
  'unzip',
  'zip',
  'openssl',
  'nc',
  'dig',
  'nslookup',
  'ping',
  'powershell',
  'pwsh',
  'cmd',
  'wmic',
  'net',
  'netsh',
  'sc',
  'reg',
  'tasklist',
  'taskkill',
  'ipconfig',
  'choco',
  'winget',
  'robocopy',
  'xcopy',
  'copy',
  'del',
  'dir',
  'type',
  'set',
  'cls'
])

export function normalizeCodeLanguage(language: string) {
  const raw = language.trim().toLowerCase()
  if (!raw) return ''
  const token = raw
    .replace(/^language-/, '')
    .replace(/^\{?\.?/, '')
    .split(/[\s,{[]+/)[0]
    .replace(/[}:]+$/g, '')
  return languageAliases[token] ?? token
}

export function isShellLanguage(language: string) {
  const normalized = normalizeCodeLanguage(language)
  return explicitShellLanguages.has(normalized) || shellSessionLanguages.has(normalized)
}

export function detectShellScriptLanguage(content: string, fileName = ''): ShellScriptLanguage {
  const normalizedName = fileName.trim().toLowerCase()
  if (/\.ps1$/.test(normalizedName)) return 'powershell'
  if (/\.(?:cmd|bat)$/.test(normalizedName)) return 'cmd'
  if (/\.(?:bash|bashrc)$/.test(normalizedName)) return 'bash'

  const source = content.replace(/\r\n/g, '\n')
  const firstLine = source.split('\n', 1)[0]?.trim() ?? ''
  if (/^#!.*\b(?:powershell|pwsh)(?:\s|$)/i.test(firstLine)) return 'powershell'
  if (/^#!.*\b(?:bash)(?:\s|$)/i.test(firstLine)) return 'bash'
  if (/^#!.*\b(?:sh|zsh|fish|ksh)(?:\s|$)/i.test(firstLine)) return 'shell'

  if (
    /^\s*@echo\s+off\b/im.test(source) ||
    /^\s*(?:setlocal|endlocal|goto|call|rem)\b/im.test(source) ||
    /%(?:[A-Za-z_][\w]*|[0-9*])%/.test(source)
  ) return 'cmd'

  if (
    /^\s*#requires\b/im.test(source) ||
    /\$(?:env|global|script|local|private):[A-Za-z_][\w]*/i.test(source) ||
    /\[(?:CmdletBinding|Parameter|ValidateSet|switch|string|int|bool|array|hashtable)\b/i.test(source) ||
    /\b(?:Add|Clear|Connect|ConvertFrom|ConvertTo|Copy|Disable|Disconnect|Enable|Enter|Exit|Export|Find|Format|ForEach|Get|Import|Install|Invoke|Join|Measure|Move|New|Out|Read|Receive|Register|Remove|Rename|Restart|Select|Send|Set|Sort|Split|Start|Stop|Test|Uninstall|Unregister|Update|Wait|Where|Write)-[A-Z][A-Za-z0-9-]*\b/i.test(source) ||
    /\b(?:param|process|begin|end)\s*\(/i.test(source)
  ) return 'powershell'

  if (
    /^\s*(?:export|source|declare|local|readonly)\s+/m.test(source) ||
    /\[\[|\]\]/.test(source) ||
    /\b(?:if|for|while|until|case)\b[^\n]*(?:;\s*)?\b(?:then|do|in)\b/.test(source) ||
    /^\s*(?:fi|done|esac)\s*$/m.test(source) ||
    /\bfunction\s+[A-Za-z_][\w]*\s*(?:\(\))?\s*\{/.test(source)
  ) return 'bash'

  return 'shell'
}

export function codeBlockLabel(language: string, content = '') {
  const normalized = normalizeCodeLanguage(language)
  if (normalized) return normalized
  return isShellLikeCodeBlock(language, content) ? 'shell' : 'text'
}

export function shellCommandFromCodeBlock(language: string, content: string) {
  if (!isShellLikeCodeBlock(language, content)) return ''
  return normalizeShellCommand(content)
}

export function isShellLikeCodeBlock(language: string, content: string) {
  const normalized = normalizeCodeLanguage(language)
  if (explicitShellLanguages.has(normalized)) return normalizeShellCommand(content).length > 0
  if (shellSessionLanguages.has(normalized)) return hasShellSignal(content)
  if (normalized && !['text', 'plain', 'plaintext', 'txt'].includes(normalized)) return false
  return hasShellSignal(content)
}

export function looksLikeShellCommand(line: string) {
  const stripped = stripShellPrompt(line)
  if (!stripped || stripped.startsWith('<')) return false
  if (/^#!\//.test(stripped)) return true
  const firstToken = stripped.split(/\s+/)[0]?.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
  if (!firstToken || lowSignalCommands.has(firstToken)) return false
  if (commandPrefixes.has(firstToken)) return true
  if (/^(?:sudo|env|time|nohup)\s+/.test(stripped)) return true
  return /^[\w./~$-]+\s+.+(?:&&|\|\||[|;&<>])/.test(stripped)
}

export function normalizeShellCommand(command: string) {
  const lines = stripLanguagePreamble(command)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(stripShellPrompt)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trim().startsWith('//') && !/^rem\b/i.test(line.trim()) && !/^::/.test(line.trim()))
  return lines.join('\n').trim()
}

function hasShellSignal(content: string) {
  const normalized = stripLanguagePreamble(content).replace(/\r\n/g, '\n')
  if (/^#!\//m.test(normalized)) return true
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return false
  if (lines.some(hasShellPrompt)) return true
  const commandLikeCount = lines.filter(looksLikeShellCommand).length
  return commandLikeCount > 0 && commandLikeCount >= Math.min(2, lines.length)
}

function stripLanguagePreamble(content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const first = lines[0]?.trim() ?? ''
  if (lines.length > 1 && isShellLanguage(first)) return lines.slice(1).join('\n')
  return content
}

function hasShellPrompt(line: string) {
  const trimmed = line.trim()
  return /^\$ /.test(trimmed) ||
    /^#\s+\S/.test(trimmed) ||
    /^PS\s+[A-Z]:\\[^>]*>\s*/i.test(trimmed) ||
    /^[A-Z]:\\[^>]*>\s*/i.test(trimmed) ||
    /^(?:\[[^\]]+\]\s*)?[\w.-]+@[\w.-]+(?::[^#$>]*)?[#$]\s+/.test(trimmed)
}

function stripShellPrompt(line: string) {
  return line
    .trim()
    .replace(/^\$ /, '')
    .replace(/^#\s+(?=\S)/, '')
    .replace(/^PS\s+[A-Z]:\\[^>]*>\s*/i, '')
    .replace(/^[A-Z]:\\[^>]*>\s*/i, '')
    .replace(/^(?:\[[^\]]+\]\s*)?[\w.-]+@[\w.-]+(?::[^#$>]*)?[#$]\s+/, '')
}
