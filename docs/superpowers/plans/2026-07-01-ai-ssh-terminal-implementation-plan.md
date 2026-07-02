# AI SSH Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vue + Tauri + Rust desktop AI terminal that connects through an interactive SSH gateway, opens a direct-input terminal, supports file transfer, and supports custom AI provider configuration.

**Architecture:** Vue owns the desktop UI, xterm.js terminal rendering, settings screens, and file-transfer panels. Rust is organized by domain folders: connection, auth, terminal, AI, storage, and app. SQLite stores non-secret config data; sensitive values stay in Rust and the operating system credential store.

**Tech Stack:** Vue 3, TypeScript, Vite, Tauri 1, Rust, Tokio, serde, xterm.js, openssh-compatible process backend, keyring, reqwest.

---

## File Structure

Create or modify these files during implementation:

- `frontend/package.json`: frontend scripts and dependencies.
- `frontend/src/main.ts`: Vue app bootstrap.
- `frontend/src/App.vue`: top-level app shell.
- `frontend/src/types/profile.ts`: shared TypeScript types for profiles, AI config, sessions, and transfer status.
- `frontend/src/lib/tauri.ts`: typed wrappers around Tauri commands and events.
- `frontend/src/components/AppShell.vue`: three-column workbench layout.
- `frontend/src/components/ConnectionSidebar.vue`: profile search and connection list.
- `frontend/src/components/TerminalPane.vue`: xterm.js terminal view with direct keyboard input.
- `frontend/src/components/AiPanel.vue`: AI chat, command insertion, and config entry.
- `frontend/src/components/AiConfigPanel.vue`: custom provider configuration form.
- `frontend/src/components/FileTransferPanel.vue`: upload/download list and transfer controls.
- `src-tauri/Cargo.toml`: Rust dependencies.
- `src-tauri/build.rs`: Tauri 1 build script.
- `src-tauri/tauri.conf.json`: Tauri 1 application configuration.
- `src-tauri/src/lib.rs`: Rust module root for tests and app startup.
- `src-tauri/src/main.rs`: Tauri bootstrap and command registration.
- `src-tauri/src/app/state.rs`: shared application state and active session registry.
- `src-tauri/src/app/commands.rs`: Tauri command handlers.
- `src-tauri/src/app/events.rs`: event payload names and helpers.
- `src-tauri/src/domain/connection/models.rs`: Rust data models matching frontend types.
- `src-tauri/src/domain/connection/profiles.rs`: validate non-secret profile data.
- `src-tauri/src/domain/connection/gateway.rs`: expect-style interactive gateway menu state machine.
- `src-tauri/src/domain/connection/transfer.rs`: file-transfer mode detection and operations.
- `src-tauri/src/domain/auth/credentials.rs`: OS credential store adapter.
- `src-tauri/src/domain/auth/keys.rs`: app-owned SSH key generation and metadata.
- `src-tauri/src/domain/terminal/ssh.rs`: SSH session abstraction and terminal I/O.
- `src-tauri/src/domain/ai/config.rs`: AI provider config validation and request adapter.
- `src-tauri/src/domain/storage/sqlite.rs`: SQLite config store boundary.
- `src-tauri/src/domain/storage/schema.sql`: SQLite schema for non-secret config data.
- `src-tauri/tests/gateway_transcript.rs`: gateway menu tests.
- `src-tauri/tests/profile_validation.rs`: profile validation tests.
- `src-tauri/tests/ai_config.rs`: AI config and redaction tests.

## Task 1: Scaffold The Desktop App

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.ts`
- Create: `frontend/src/App.vue`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/main.rs`

- [ ] **Step 1: Create frontend package metadata**

Create `frontend/package.json`:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "vue-tsc --noEmit && vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^1.6.0",
    "@xterm/xterm": "^5.5.0",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^1.6.0",
    "@vitejs/plugin-vue": "^5.1.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vue-tsc": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create Vue entry files**

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Term</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `frontend/src/main.ts`:

```ts
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#app')
```

Create `frontend/src/App.vue`:

```vue
<script setup lang="ts">
import AppShell from './components/AppShell.vue'
</script>

<template>
  <AppShell />
</template>
```

- [ ] **Step 3: Create Rust/Tauri entry files**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "ai-term"
version = "0.1.0"
edition = "2021"

[lib]
name = "ai_term_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[dependencies]
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "1", features = ["shell-open"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "process", "io-util"] }
uuid = { version = "1", features = ["v4", "serde"] }

[build-dependencies]
tauri-build = { version = "1", features = [] }
```

Create `src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

Create `src-tauri/tauri.conf.json`:

```json
{
  "build": {
    "beforeDevCommand": "",
    "beforeBuildCommand": "cd ../frontend && npm run build",
    "devPath": "../frontend/dist",
    "distDir": "../frontend/dist"
  },
  "package": {
    "productName": "AI Term",
    "version": "0.1.0"
  },
  "tauri": {
    "allowlist": {
      "all": false,
      "shell": {
        "all": false,
        "open": true
      }
    },
    "bundle": {
      "active": false,
      "identifier": "com.ai-term.app"
    },
    "security": {
      "csp": null
    },
    "windows": [
      {
        "title": "AI Term",
        "width": 1280,
        "height": 820,
        "minWidth": 980,
        "minHeight": 640
      }
    ]
  }
}
```

Create `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

Create `src-tauri/src/main.rs`:

```rust
fn main() {
    ai_term_lib::run();
}
```

- [ ] **Step 4: Run build checks**

Run:

```bash
(cd frontend && npm install)
(cd frontend && npm run build)
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: frontend build exits 0 and Rust check exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend src-tauri
git commit -m "chore: scaffold vue tauri desktop app"
```

## Task 2: Define Shared Models

**Files:**
- Create: `frontend/src/types/profile.ts`
- Create: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add TypeScript models**

Create `frontend/src/types/profile.ts`:

```ts
export type AuthMode = 'auto' | 'password' | 'key'
export type JumpMode = 'interactive-menu'
export type FileTransferMode = 'auto' | 'sftp-direct' | 'sftp-gateway' | 'scp-through-terminal' | 'inline-small-file'
export type AiProviderType = 'openai-compatible' | 'openai' | 'company-gateway' | 'ollama' | 'custom-http'
export type ContextPolicy = 'selected-output-only' | 'active-command-output' | 'manual-attachments'

export interface AuthEndpoint {
  host: string
  port?: number
  username: string
  authMode: AuthMode
  credentialRef?: string
}

export interface ConnectionProfile {
  id: string
  name: string
  gateway: AuthEndpoint
  target: AuthEndpoint
  jumpMode: JumpMode
  menuProfileId: string
  fileTransferMode: FileTransferMode
}

export interface MenuStep {
  expect: string
  send: string
}

export interface MenuProfile {
  id: string
  name: string
  steps: MenuStep[]
  successPatterns: string[]
  failurePatterns: string[]
}

export interface AiProviderConfig {
  id: string
  provider: AiProviderType
  baseUrl: string
  model: string
  apiKeyRef: string
  contextPolicy: ContextPolicy
  systemPrompt: string
  riskPolicy: 'confirm-dangerous'
}

export interface SessionInfo {
  id: string
  profileId: string
  title: string
  connected: boolean
}
```

- [ ] **Step 2: Add Rust models**

Create `src-tauri/src/models.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    Auto,
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JumpMode {
    InteractiveMenu,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileTransferMode {
    Auto,
    SftpDirect,
    SftpGateway,
    ScpThroughTerminal,
    InlineSmallFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthEndpoint {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub auth_mode: AuthMode,
    pub credential_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub gateway: AuthEndpoint,
    pub target: AuthEndpoint,
    pub jump_mode: JumpMode,
    pub menu_profile_id: String,
    pub file_transfer_mode: FileTransferMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MenuStep {
    pub expect: String,
    pub send: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MenuProfile {
    pub id: String,
    pub name: String,
    pub steps: Vec<MenuStep>,
    pub success_patterns: Vec<String>,
    pub failure_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiProviderType {
    OpenAiCompatible,
    OpenAi,
    CompanyGateway,
    Ollama,
    CustomHttp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ContextPolicy {
    SelectedOutputOnly,
    ActiveCommandOutput,
    ManualAttachments,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub provider: AiProviderType,
    pub base_url: String,
    pub model: String,
    pub api_key_ref: String,
    pub context_policy: ContextPolicy,
    pub system_prompt: String,
    pub risk_policy: String,
}
```

- [ ] **Step 3: Register the module**

Modify `src-tauri/src/main.rs`:

```rust
mod models;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

- [ ] **Step 4: Run type checks**

Run:

```bash
(cd frontend && npm run build)
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/profile.ts src-tauri/src/models.rs src-tauri/src/main.rs
git commit -m "feat: add shared connection and ai models"
```

## Task 3: Build The Workbench UI

**Files:**
- Create: `frontend/src/styles.css`
- Create: `frontend/src/components/AppShell.vue`
- Create: `frontend/src/components/ConnectionSidebar.vue`
- Create: `frontend/src/components/TerminalPane.vue`
- Create: `frontend/src/components/AiPanel.vue`
- Create: `frontend/src/components/AiConfigPanel.vue`
- Create: `frontend/src/components/FileTransferPanel.vue`

- [ ] **Step 1: Add base styles**

Create `frontend/src/styles.css` using the visual direction from `terminal-preview.html`: dark workbench, left profile rail, center terminal, right AI/files panel, 6-8px radii, restrained colors, no decorative background art.

- [ ] **Step 2: Create static shell components**

Create `frontend/src/components/AppShell.vue`:

```vue
<script setup lang="ts">
import ConnectionSidebar from './ConnectionSidebar.vue'
import TerminalPane from './TerminalPane.vue'
import AiPanel from './AiPanel.vue'
import FileTransferPanel from './FileTransferPanel.vue'
</script>

<template>
  <div class="app-shell">
    <header class="titlebar">
      <div class="brand">AI Term</div>
      <div class="session-tabs">
        <button class="tab active">prod-app-01</button>
      </div>
      <div class="top-actions">
        <button>AI Config</button>
        <button>新建</button>
        <button class="primary">连接</button>
      </div>
    </header>
    <ConnectionSidebar />
    <TerminalPane />
    <aside class="right-panel">
      <AiPanel />
      <FileTransferPanel />
    </aside>
  </div>
</template>
```

Create components with hard-coded preview data matching the current design. Keep the terminal component focused on the terminal surface and connection strip; keep AI config in its own component.

- [ ] **Step 3: Verify layout**

Run:

```bash
(cd frontend && npm run build)
```

Expected: the static frontend assets are written to `frontend/dist` for `cargo run` to load.

- [ ] **Step 4: Build frontend**

Run:

```bash
(cd frontend && npm run build)
```

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles.css frontend/src/components
git commit -m "feat: build terminal workbench ui"
```

## Task 4: Add Profile Persistence

**Files:**
- Create: `src-tauri/src/profiles.rs`
- Create: `src-tauri/tests/profile_validation.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write validation tests**

Create `src-tauri/tests/profile_validation.rs`:

```rust
use ai_term_lib::models::{AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode};
use ai_term_lib::profiles::validate_profile;

fn endpoint(host: &str, username: &str) -> AuthEndpoint {
    AuthEndpoint {
        host: host.to_string(),
        port: Some(22),
        username: username.to_string(),
        auth_mode: AuthMode::Auto,
        credential_ref: None,
    }
}

#[test]
fn valid_profile_passes() {
    let profile = ConnectionProfile {
        id: "prod-app-01".into(),
        name: "prod-app-01".into(),
        gateway: endpoint("ssh.company.com", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert!(validate_profile(&profile).is_ok());
}

#[test]
fn empty_gateway_host_fails() {
    let profile = ConnectionProfile {
        id: "prod-app-01".into(),
        name: "prod-app-01".into(),
        gateway: endpoint("", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
    };

    assert_eq!(
        validate_profile(&profile).unwrap_err().to_string(),
        "gateway host is required"
    );
}
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test profile_validation
```

Expected: compile fails because `profiles::validate_profile` does not exist.

- [ ] **Step 3: Implement profile validation**

Create `src-tauri/src/profiles.rs`:

```rust
use anyhow::{bail, Result};

use crate::models::ConnectionProfile;

pub fn validate_profile(profile: &ConnectionProfile) -> Result<()> {
    if profile.id.trim().is_empty() {
        bail!("profile id is required");
    }
    if profile.name.trim().is_empty() {
        bail!("profile name is required");
    }
    if profile.gateway.host.trim().is_empty() {
        bail!("gateway host is required");
    }
    if profile.gateway.username.trim().is_empty() {
        bail!("gateway username is required");
    }
    if profile.target.host.trim().is_empty() {
        bail!("target host is required");
    }
    if profile.target.username.trim().is_empty() {
        bail!("target username is required");
    }
    if profile.menu_profile_id.trim().is_empty() {
        bail!("menu profile id is required");
    }
    Ok(())
}
```

Modify `src-tauri/src/main.rs`:

```rust
pub mod models;
pub mod profiles;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

- [ ] **Step 4: Run passing tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test profile_validation
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/profiles.rs src-tauri/src/main.rs src-tauri/tests/profile_validation.rs
git commit -m "feat: validate connection profiles"
```

## Task 5: Add Credential And Key Management Boundaries

**Files:**
- Create: `src-tauri/src/credentials.rs`
- Create: `src-tauri/src/keys.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add dependencies**

Modify `src-tauri/Cargo.toml` dependencies:

```toml
keyring = "3"
rand_core = "0.6"
ssh-key = { version = "0.6", features = ["ed25519", "rand_core"] }
```

- [ ] **Step 2: Implement credential adapter interface**

Create `src-tauri/src/credentials.rs`:

```rust
use anyhow::Result;

pub trait CredentialStore: Send + Sync {
    fn set_secret(&self, key: &str, value: &str) -> Result<()>;
    fn get_secret(&self, key: &str) -> Result<Option<String>>;
    fn delete_secret(&self, key: &str) -> Result<()>;
}

pub struct OsCredentialStore {
    service: String,
}

impl OsCredentialStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
}

impl CredentialStore for OsCredentialStore {
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        let entry = keyring::Entry::new(&self.service, key)?;
        entry.set_password(value)?;
        Ok(())
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(&self.service, key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    fn delete_secret(&self, key: &str) -> Result<()> {
        let entry = keyring::Entry::new(&self.service, key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }
}
```

- [ ] **Step 3: Implement app key metadata**

Create `src-tauri/src/keys.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyInfo {
    pub name: String,
    pub private_key_path: PathBuf,
    pub public_key_path: PathBuf,
    pub comment: String,
}

pub fn default_key_name() -> &'static str {
    "ai-term-ed25519"
}

pub fn key_comment(device_id: &str) -> String {
    format!("ai-term:{device_id}")
}
```

- [ ] **Step 4: Register modules**

Modify `src-tauri/src/main.rs`:

```rust
pub mod credentials;
pub mod keys;
pub mod models;
pub mod profiles;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

- [ ] **Step 5: Run Rust check**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Rust check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/credentials.rs src-tauri/src/keys.rs src-tauri/src/main.rs
git commit -m "feat: add credential and key management boundaries"
```

## Task 6: Implement Gateway Menu State Machine

**Files:**
- Create: `src-tauri/src/gateway.rs`
- Create: `src-tauri/tests/gateway_transcript.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write transcript tests**

Create `src-tauri/tests/gateway_transcript.rs`:

```rust
use ai_term_lib::gateway::{GatewayAction, GatewayAutomaton};
use ai_term_lib::models::{MenuProfile, MenuStep};
use std::collections::HashMap;

fn menu() -> MenuProfile {
    MenuProfile {
        id: "company-default".into(),
        name: "Company Default".into(),
        steps: vec![
            MenuStep { expect: "personal username".into(), send: "${gateway.username}".into() },
            MenuStep { expect: "server ip".into(), send: "${target.host}".into() },
            MenuStep { expect: "server user".into(), send: "${target.username}".into() },
        ],
        success_patterns: vec!["Last login".into(), "$ ".into()],
        failure_patterns: vec!["Permission denied".into()],
    }
}

fn vars() -> HashMap<String, String> {
    HashMap::from([
        ("gateway.username".into(), "company.user".into()),
        ("target.host".into(), "10.12.8.21".into()),
        ("target.username".into(), "app".into()),
    ])
}

#[test]
fn sends_values_in_prompt_order() {
    let mut automaton = GatewayAutomaton::new(menu(), vars());

    assert_eq!(
        automaton.on_output("Input personal username:").unwrap(),
        GatewayAction::SendLine("company.user".into())
    );
    assert_eq!(
        automaton.on_output("Input server ip:").unwrap(),
        GatewayAction::SendLine("10.12.8.21".into())
    );
    assert_eq!(
        automaton.on_output("Input server user:").unwrap(),
        GatewayAction::SendLine("app".into())
    );
    assert_eq!(
        automaton.on_output("Last login: Wed Jul 1").unwrap(),
        GatewayAction::Connected
    );
}
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test gateway_transcript
```

Expected: compile fails because `gateway` module does not exist.

- [ ] **Step 3: Implement state machine**

Create `src-tauri/src/gateway.rs`:

```rust
use anyhow::{bail, Result};
use std::collections::HashMap;

use crate::models::MenuProfile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayAction {
    Wait,
    SendLine(String),
    Connected,
    Failed(String),
}

pub struct GatewayAutomaton {
    menu: MenuProfile,
    vars: HashMap<String, String>,
    next_step: usize,
}

impl GatewayAutomaton {
    pub fn new(menu: MenuProfile, vars: HashMap<String, String>) -> Self {
        Self { menu, vars, next_step: 0 }
    }

    pub fn on_output(&mut self, output: &str) -> Result<GatewayAction> {
        let lower = output.to_lowercase();

        if let Some(pattern) = self
            .menu
            .failure_patterns
            .iter()
            .find(|pattern| lower.contains(&pattern.to_lowercase()))
        {
            return Ok(GatewayAction::Failed(pattern.clone()));
        }

        if self
            .menu
            .success_patterns
            .iter()
            .any(|pattern| output.contains(pattern))
        {
            return Ok(GatewayAction::Connected);
        }

        let Some(step) = self.menu.steps.get(self.next_step) else {
            return Ok(GatewayAction::Wait);
        };

        if lower.contains(&step.expect.to_lowercase()) {
            self.next_step += 1;
            return Ok(GatewayAction::SendLine(resolve_template(&step.send, &self.vars)?));
        }

        Ok(GatewayAction::Wait)
    }
}

fn resolve_template(template: &str, vars: &HashMap<String, String>) -> Result<String> {
    if let Some(name) = template.strip_prefix("${").and_then(|value| value.strip_suffix('}')) {
        return vars
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing menu variable {name}"));
    }
    if template.contains("${") {
        bail!("only full-value templates are supported");
    }
    Ok(template.to_string())
}
```

- [ ] **Step 4: Register module**

Modify `src-tauri/src/main.rs`:

```rust
pub mod credentials;
pub mod gateway;
pub mod keys;
pub mod models;
pub mod profiles;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

- [ ] **Step 5: Run passing test**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test gateway_transcript
```

Expected: transcript test passes.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/gateway.rs src-tauri/src/main.rs src-tauri/tests/gateway_transcript.rs
git commit -m "feat: automate interactive gateway menu"
```

## Task 7: Add Terminal Session Commands

**Files:**
- Create: `src-tauri/src/app_state.rs`
- Create: `src-tauri/src/ssh.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/events.rs`
- Create: `frontend/src/lib/tauri.ts`
- Modify: `src-tauri/src/main.rs`
- Modify: `frontend/src/components/TerminalPane.vue`

- [ ] **Step 1: Define frontend Tauri wrapper**

Create `frontend/src/lib/tauri.ts`:

```ts
import { invoke } from '@tauri-apps/api/tauri'
import { listen } from '@tauri-apps/api/event'

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export function connectProfile(profileId: string) {
  return invoke<string>('connect_profile', { profileId })
}

export function terminalWrite(sessionId: string, data: string) {
  return invoke<void>('terminal_write', { sessionId, data })
}

export function terminalResize(sessionId: string, cols: number, rows: number) {
  return invoke<void>('terminal_resize', { sessionId, cols, rows })
}

export function onTerminalData(handler: (event: TerminalDataEvent) => void) {
  return listen<TerminalDataEvent>('terminal:data', (event) => handler(event.payload))
}
```

- [ ] **Step 2: Add Rust command skeletons**

Create `src-tauri/src/commands.rs`:

```rust
use anyhow::Result;
use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;

#[tauri::command]
pub async fn connect_profile(profile_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    state.register_session(session_id.clone(), profile_id).await;
    Ok(session_id)
}

#[tauri::command]
pub async fn terminal_write(session_id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    state.write_terminal(&session_id, data.into_bytes()).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn terminal_resize(session_id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    state.resize_terminal(&session_id, cols, rows).await.map_err(|err| err.to_string())
}
```

Create `src-tauri/src/app_state.rs`:

```rust
use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, String>>,
}

impl AppState {
    pub async fn register_session(&self, session_id: String, profile_id: String) {
        self.sessions.lock().await.insert(session_id, profile_id);
    }

    pub async fn write_terminal(&self, session_id: &str, _data: Vec<u8>) -> Result<()> {
        ensure_session_exists(&self.sessions.lock().await, session_id)?;
        Ok(())
    }

    pub async fn resize_terminal(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<()> {
        ensure_session_exists(&self.sessions.lock().await, session_id)?;
        Ok(())
    }
}

fn ensure_session_exists(sessions: &HashMap<String, String>, session_id: &str) -> Result<()> {
    if sessions.contains_key(session_id) {
        Ok(())
    } else {
        anyhow::bail!("unknown session {session_id}")
    }
}
```

Create `src-tauri/src/events.rs`:

```rust
pub const TERMINAL_DATA: &str = "terminal:data";
```

Create `src-tauri/src/ssh.rs`:

```rust
pub struct SshSession;
```

- [ ] **Step 3: Register commands and state**

Modify `src-tauri/src/main.rs`:

```rust
pub mod app_state;
pub mod commands;
pub mod credentials;
pub mod events;
pub mod gateway;
pub mod keys;
pub mod models;
pub mod profiles;
pub mod ssh;

use app_state::AppState;
use commands::{connect_profile, terminal_resize, terminal_write};

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_profile,
            terminal_write,
            terminal_resize
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
```

- [ ] **Step 4: Wire xterm direct input**

Modify `frontend/src/components/TerminalPane.vue` so xterm.js handles keyboard input directly:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { connectProfile, onTerminalData, terminalWrite } from '../lib/tauri'

const host = ref<HTMLDivElement | null>(null)
let term: Terminal | undefined
let sessionId = ''
let dispose: (() => void) | undefined

onMounted(async () => {
  term = new Terminal({ cursorBlink: true, fontSize: 13, convertEol: true })
  term.open(host.value!)
  term.write('Connecting to gateway...\\r\\n')
  sessionId = await connectProfile('prod-app-01')
  term.onData((data) => {
    void terminalWrite(sessionId, data)
  })
  dispose = await onTerminalData((event) => {
    if (event.sessionId === sessionId) {
      term?.write(event.data)
    }
  })
})

onBeforeUnmount(() => {
  dispose?.()
  term?.dispose()
})
</script>

<template>
  <main class="terminal-pane">
    <section class="connection-strip">
      <div>ssh.company.com</div>
      <div>company.user</div>
      <div>10.12.8.21</div>
      <div>app</div>
    </section>
    <div ref="host" class="xterm-host" />
  </main>
</template>
```

- [ ] **Step 5: Run checks**

Run:

```bash
(cd frontend && npm run build)
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tauri.ts frontend/src/components/TerminalPane.vue src-tauri/src
git commit -m "feat: wire terminal session commands"
```

## Task 8: Implement Real SSH Backend

**Files:**
- Modify: `src-tauri/src/ssh.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Choose SSH backend and add dependency**

Use a process-backed OpenSSH implementation first because it naturally supports PTY behavior, local SSH config compatibility, ProxyJump-compatible environments, and mature authentication prompts. Add:

```toml
portable-pty = "0.8"
shell-words = "1"
```

- [ ] **Step 2: Implement PTY process session**

Modify `src-tauri/src/ssh.rs` to start a local `ssh` process in a PTY for the first working version:

```rust
use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};

pub struct PtySshSession {
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
}

impl PtySshSession {
    pub fn connect_gateway(host: &str, username: &str, cols: u16, rows: u16) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = CommandBuilder::new("ssh");
        cmd.arg(format!("{username}@{host}"));
        let _child = pair.slave.spawn_command(cmd)?;
        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;
        Ok(Self { writer, reader })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn read_available(&mut self, buffer: &mut [u8]) -> Result<usize> {
        Ok(self.reader.read(buffer)?)
    }
}
```

- [ ] **Step 3: Connect backend to session manager**

Store `PtySshSession` inside `AppState` by session ID and spawn a reader task that emits `terminal:data`. Keep the gateway menu automation layer between initial output and user-controlled terminal mode.

- [ ] **Step 4: Manual test password login**

Run:

```bash
cd src-tauri
cargo run
```

Expected: the Tauri client window opens from `frontend/dist`, the terminal surface receives direct keyboard input, and typed characters flow through the Rust command bridge.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/ssh.rs src-tauri/src/app_state.rs src-tauri/src/commands.rs
git commit -m "feat: connect terminal to openssh pty backend"
```

## Task 9: Add AI Provider Configuration

**Files:**
- Create: `src-tauri/src/ai.rs`
- Create: `src-tauri/tests/ai_config.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `frontend/src/components/AiConfigPanel.vue`
- Modify: `frontend/src/components/AiPanel.vue`

- [ ] **Step 1: Write AI config tests**

Create `src-tauri/tests/ai_config.rs`:

```rust
use ai_term_lib::ai::{redact_ai_config, validate_ai_config};
use ai_term_lib::models::{AiProviderConfig, AiProviderType, ContextPolicy};

fn config() -> AiProviderConfig {
    AiProviderConfig {
        id: "default".into(),
        provider: AiProviderType::OpenAiCompatible,
        base_url: "https://ai-gateway.company.com/v1".into(),
        model: "gpt-4.1-mini".into(),
        api_key_ref: "ai-provider:default".into(),
        context_policy: ContextPolicy::SelectedOutputOnly,
        system_prompt: "You are an assistant for safe server operations.".into(),
        risk_policy: "confirm-dangerous".into(),
    }
}

#[test]
fn valid_ai_config_passes() {
    assert!(validate_ai_config(&config()).is_ok());
}

#[test]
fn redacted_config_keeps_reference_not_secret() {
    let redacted = redact_ai_config(&config());
    assert_eq!(redacted.api_key_ref, "configured");
}
```

- [ ] **Step 2: Implement validation and redaction**

Create `src-tauri/src/ai.rs`:

```rust
use anyhow::{bail, Result};

use crate::models::AiProviderConfig;

pub fn validate_ai_config(config: &AiProviderConfig) -> Result<()> {
    if config.id.trim().is_empty() {
        bail!("ai config id is required");
    }
    if config.base_url.trim().is_empty() {
        bail!("ai base url is required");
    }
    if config.model.trim().is_empty() {
        bail!("ai model is required");
    }
    if config.api_key_ref.trim().is_empty() {
        bail!("ai api key reference is required");
    }
    if config.system_prompt.trim().is_empty() {
        bail!("ai system prompt is required");
    }
    if config.risk_policy != "confirm-dangerous" {
        bail!("unsupported risk policy");
    }
    Ok(())
}

pub fn redact_ai_config(config: &AiProviderConfig) -> AiProviderConfig {
    let mut redacted = config.clone();
    redacted.api_key_ref = "configured".to_string();
    redacted
}
```

- [ ] **Step 3: Register module and run tests**

Modify `src-tauri/src/main.rs` to include:

```rust
pub mod ai;
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test ai_config
```

Expected: 2 tests pass.

- [ ] **Step 4: Wire AI config UI**

`AiConfigPanel.vue` submits provider type, base URL, model, context policy, system prompt, and risk policy to Rust. The API key field calls a dedicated command that stores the secret in the credential store and returns only a credential reference.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai.rs src-tauri/src/main.rs src-tauri/tests/ai_config.rs frontend/src/components/AiConfigPanel.vue frontend/src/components/AiPanel.vue
git commit -m "feat: add custom ai provider configuration"
```

## Task 10: Add File Transfer Strategy

**Files:**
- Create: `src-tauri/src/transfer.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `frontend/src/components/FileTransferPanel.vue`

- [ ] **Step 1: Define transfer modes**

Create `src-tauri/src/transfer.rs`:

```rust
use crate::models::FileTransferMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferCapabilities {
    pub sftp_direct: bool,
    pub sftp_gateway: bool,
    pub scp_available: bool,
}

pub fn choose_transfer_mode(capabilities: &TransferCapabilities) -> FileTransferMode {
    if capabilities.sftp_direct {
        FileTransferMode::SftpDirect
    } else if capabilities.sftp_gateway {
        FileTransferMode::SftpGateway
    } else if capabilities.scp_available {
        FileTransferMode::ScpThroughTerminal
    } else {
        FileTransferMode::InlineSmallFile
    }
}
```

- [ ] **Step 2: Register module**

Modify `src-tauri/src/main.rs`:

```rust
pub mod transfer;
```

- [ ] **Step 3: Wire transfer panel to backend commands**

Add Tauri commands:

```rust
#[tauri::command]
pub async fn detect_transfer_mode(profile_id: String) -> Result<FileTransferMode, String> {
    let _ = profile_id;
    Ok(FileTransferMode::InlineSmallFile)
}
```

The first real backend can return detected capability results after SSH integration is stable.

- [ ] **Step 4: Run checks**

Run:

```bash
(cd frontend && npm run build)
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transfer.rs src-tauri/src/main.rs frontend/src/components/FileTransferPanel.vue
git commit -m "feat: add file transfer strategy selection"
```

## Task 11: End-To-End Manual Verification

**Files:**
- Modify: `docs/manual-test-checklist.md`

- [ ] **Step 1: Create manual checklist**

Create `docs/manual-test-checklist.md`:

```markdown
# Manual Test Checklist

- [ ] Password login to gateway shows prompt inside the terminal.
- [ ] Gateway menu receives personal username, target IP, and target username.
- [ ] Target shell accepts direct keyboard input inside xterm.js.
- [ ] AI Config saves provider metadata without exposing API key text.
- [ ] AI command suggestion inserts into terminal without auto-executing.
- [ ] SFTP detection reports the available transfer mode.
- [ ] Failed auth leaves terminal output inspectable.
- [ ] Window resize updates remote terminal dimensions.
```

- [ ] **Step 2: Run automated checks**

Run:

```bash
(cd frontend && npm run build)
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: frontend build exits 0 and Rust tests pass.

- [ ] **Step 3: Run app manually**

Run:

```bash
cd src-tauri
cargo run
```

Expected: app opens from built dist assets, profile connects through the gateway, and terminal input is direct.

- [ ] **Step 4: Commit**

```bash
git add docs/manual-test-checklist.md
git commit -m "docs: add manual verification checklist"
```

## Self-Review

- Spec coverage: connection profiles, interactive gateway menu, dual-layer auth, key setup boundary, direct terminal input, file transfer strategy, and custom AI configuration are covered by tasks.
- Placeholder scan: the plan contains concrete file paths, command names, model fields, and first-pass code for core boundaries.
- Type consistency: TypeScript and Rust names use the same profile concepts; Rust uses serde renaming to match frontend JSON.
- Scope check: centralized team management, cloud sync, RBAC, and enterprise audit are intentionally outside this first implementation plan.

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-07-01-ai-ssh-terminal-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
