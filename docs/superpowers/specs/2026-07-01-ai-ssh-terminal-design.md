# AI SSH Terminal Design

## Goal

Build a desktop AI terminal client with Vue, Tauri, and Rust. The app connects to company servers through an interactive SSH gateway, supports direct terminal input, supports file transfer, and lets users configure their own AI provider.

## Product Scope

The first version focuses on one user operating one local desktop client:

- Save SSH connection profiles.
- Connect to a company gateway domain with password or SSH key.
- Fill the interactive gateway menu with personal username, target server IP, and target server username.
- Open a real terminal where the user types directly inside the terminal surface.
- Support password-first setup and SSH-key reuse for both gateway and target accounts.
- Transfer files with SFTP/SCP when the gateway allows it, with a terminal-based fallback for constrained environments.
- Provide an AI side panel for command explanation, command drafting, output summarization, and risk warnings.
- Support custom AI configuration, including OpenAI-compatible endpoints, company gateways, local providers, model names, API keys, system prompts, and context policies.

Team sharing, centralized audit, RBAC, cloud sync, and admin consoles are not part of the first version.

## User Experience

The main page is a desktop workbench:

- Left sidebar: connection profiles and server search.
- Center: xterm-style terminal with direct keyboard input.
- Right panel: AI assistant and file transfer context.
- Top bar: session tabs, connection action, and AI configuration entry.
- Connection strip: gateway domain, personal username, target IP, and target username.

The terminal is the primary interaction area. AI suggestions can insert text at the terminal cursor, but the user decides whether to press Enter. Destructive or high-risk commands require explicit confirmation before insertion or execution.

## Connection Model

The app treats the gateway and target server as two independent authentication layers.

```text
Gateway layer:
- host: company SSH domain
- port: usually 22
- username: company personal username
- auth: auto, password, or key

Target layer:
- host: server IP or hostname
- username: server username
- auth: auto, password, or key
```

The first supported jump mode is `interactive-menu`.

```text
1. Rust starts an SSH session to the gateway.
2. Rust opens an interactive PTY/channel.
3. A small expect-style state machine reads gateway output.
4. The state machine matches prompts and sends configured values.
5. Once the remote shell prompt is detected, terminal I/O is streamed to Vue.
```

The menu automation must be configurable. Company-specific prompt text must live in a profile, not in hard-coded Rust logic.

## Authentication And Key Setup

The app supports password and key for both gateway and target accounts.

Recommended behavior:

```text
authMode = auto:
1. Try the configured key first.
2. If key auth fails or no key exists, prompt for password.
3. After successful password login, offer to install the ai-term public key.
4. On the next connection, prefer key auth again.
```

Passwords are never stored in plain config files. If the user chooses to save a password, it is stored in the operating system credential store. Private keys are generated locally and protected with file permissions and, where practical, a passphrase stored in the credential store.

The app uses a dedicated key identity:

```text
Key name: ai-term-ed25519
Key type: Ed25519
Default location: app-managed secure data directory
Public key comment: ai-term:<local-device-id>
```

Public-key installation can happen on the gateway account, the target account, or both, depending on user choice and server policy. If installation fails, the profile remains usable with password or manually configured key auth.

## Terminal Architecture

Vue renders the terminal with xterm.js. Rust owns the actual SSH session and forwards bytes through Tauri events.

```text
Vue xterm.js
  -> Tauri command: terminal_write(session_id, bytes)
  -> Rust session manager
  -> SSH PTY stdin

SSH PTY stdout/stderr
  -> Rust reader task
  -> Tauri event: terminal:data
  -> Vue xterm.write()
```

Resize events are forwarded from xterm.js to Rust so the remote PTY tracks the visible terminal size.

The terminal view must not use a separate command input box. Keystrokes go directly to xterm.js and then to the remote PTY.

## File Transfer

The preferred file-transfer path is SFTP over SSH because it shares authentication and avoids legacy FTP complexity.

Supported modes:

- `sftp-direct`: connect to the target with SFTP through supported gateway routing.
- `sftp-gateway`: upload to gateway storage, then copy to the target when allowed.
- `scp-through-terminal`: use remote `scp` or shell commands after entering the target.
- `inline-small-file`: stream small files through shell-safe base64 encoding when no file subsystem is available.

The client should detect the best available mode per profile and show it in the UI. Traditional FTP can be added as a separate provider, but it is not the default because enterprise SSH environments usually favor SFTP/SCP.

## AI Configuration

AI settings are first-class and user configurable.

Configurable fields:

- Provider type: OpenAI-compatible, OpenAI, company gateway, Ollama, or custom HTTP.
- Base URL.
- Model.
- API key reference.
- System prompt.
- Risk policy.
- Context policy.
- Timeout and retry limits.

API keys are stored only in the OS credential store. The JSON config stores a credential reference, not the secret value.

Context policy defaults to the safest useful behavior:

```text
Default: send only selected terminal output or explicitly attached command output.
Never send: saved passwords, private keys, credential-store values, or full terminal scrollback by default.
```

The AI assistant can:

- Explain selected output.
- Draft commands.
- Summarize logs.
- Identify risky commands.
- Insert a suggested command at the terminal cursor.

The assistant must not execute generated commands without user action.

## Data Model

Configuration is stored in SQLite. Secrets are not stored in SQLite; rows keep only credential references that point to the OS credential store.

SQLite stores:

- Connection profiles.
- Gateway menu profiles.
- AI provider configuration metadata.
- App settings and UI preferences.

OS credential storage keeps:

- SSH passwords.
- AI API keys.
- SSH private-key passphrases.
- Other tokens or secrets.

Connection profile:

```json
{
  "id": "prod-app-01",
  "name": "prod-app-01",
  "gateway": {
    "host": "ssh.company.com",
    "port": 22,
    "username": "company.user",
    "authMode": "auto",
    "credentialRef": "gateway:prod-app-01"
  },
  "target": {
    "host": "10.12.8.21",
    "username": "app",
    "authMode": "auto",
    "credentialRef": "target:prod-app-01"
  },
  "jumpMode": "interactive-menu",
  "menuProfileId": "company-default",
  "fileTransferMode": "auto"
}
```

Menu profile:

```json
{
  "id": "company-default",
  "name": "Company Gateway Default",
  "steps": [
    {
      "expect": "username",
      "send": "${gateway.username}"
    },
    {
      "expect": "server ip",
      "send": "${target.host}"
    },
    {
      "expect": "server user",
      "send": "${target.username}"
    }
  ],
  "successPatterns": ["Last login", "$ ", "# "],
  "failurePatterns": ["Permission denied", "authentication failed"]
}
```

AI provider config:

```json
{
  "id": "default",
  "provider": "openai-compatible",
  "baseUrl": "https://ai-gateway.company.com/v1",
  "model": "gpt-4.1-mini",
  "apiKeyRef": "ai-provider:default",
  "contextPolicy": "selected-output-only",
  "systemPrompt": "You are an assistant for safe server operations.",
  "riskPolicy": "confirm-dangerous"
}
```

## Rust Domain Boundaries

The Rust side is organized by domain instead of one flat source directory:

- `domain/connection`: connection models, profile validation, gateway menu automation, and transfer strategy.
- `domain/auth`: credential-store abstraction and SSH key metadata/management.
- `domain/terminal`: SSH/PT​Y terminal session abstractions.
- `domain/ai`: AI provider config validation, redaction, and provider calls.
- `domain/storage`: SQLite schema, migrations, and config repositories.
- `app`: Tauri commands, events, and active application state.

Secrets never cross into Vue except as masked metadata such as `configured: true`.

## Error Handling

Errors shown to users should be actionable:

- Gateway unreachable.
- Authentication failed.
- Menu prompt not recognized.
- Target server selection failed.
- Key installation failed.
- SFTP unavailable.
- AI provider request failed.

The terminal remains inspectable after connection failure so the user can see relevant gateway output without exposing secrets.

## Testing Strategy

Core Rust logic is tested without real company infrastructure:

- Unit-test profile validation.
- Unit-test credential references without storing real secrets.
- Unit-test menu automation with scripted input/output transcripts.
- Unit-test AI config validation and secret redaction.
- Integration-test terminal stream plumbing with a local mock session.
- Integration-test file-transfer strategy selection with mocked capabilities.

Manual testing covers:

- Password login to gateway.
- Key login to gateway.
- Password login to target.
- Key login to target.
- Interactive menu mismatch.
- AI config with OpenAI-compatible endpoint.
- SFTP available and unavailable paths.

## Preview Artifact

The current static UI preview is:

```text
terminal-preview.html
```

It shows the intended workbench layout but does not connect to real SSH.
