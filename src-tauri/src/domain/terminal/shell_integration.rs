use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

// Shell integration 脚本随二进制嵌入,启动本地终端时物化到应用配置目录,
// 再通过 ZDOTDIR / --init-file 注入本地 shell。见 docs/shell-integration-development.md。

const INTEGRATION_ZSH: &str = include_str!("shell_integration/integration.zsh");
const INTEGRATION_BASH: &str = include_str!("shell_integration/integration.bash");
const ZDOTDIR_ZSHENV: &str = include_str!("shell_integration/zdotdir-zshenv.zsh");
const ZDOTDIR_ZSHRC: &str = include_str!("shell_integration/zdotdir-zshrc.zsh");
const BASH_INIT: &str = include_str!("shell_integration/bash-init.bash");

/// 把集成脚本写入 `<app_config_dir>/shell-integration/`(内容变化时覆盖),
/// 返回该目录路径。
pub fn ensure_integration_scripts(app_config_dir: &Path) -> Result<PathBuf> {
    let root = app_config_dir.join("shell-integration");
    let files: &[(&str, &str)] = &[
        ("integration.zsh", INTEGRATION_ZSH),
        ("integration.bash", INTEGRATION_BASH),
        ("zdotdir/.zshenv", ZDOTDIR_ZSHENV),
        ("zdotdir/.zshrc", ZDOTDIR_ZSHRC),
        ("bash-init.bash", BASH_INIT),
    ];
    for (relative, content) in files {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let needs_write = std::fs::read_to_string(&path)
            .map(|current| current != *content)
            .unwrap_or(true);
        if needs_write {
            std::fs::write(&path, content)
                .with_context(|| format!("failed to write {}", path.display()))?;
        }
    }
    Ok(root)
}

/// 依据 shell 类型给启动命令附加注入参数;不认识的 shell 保持原样。
pub fn apply_shell_integration(
    program: &str,
    args: &mut Vec<String>,
    envs: &mut Vec<(String, String)>,
    integration_dir: &Path,
) {
    let shell_name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let Some(dir) = integration_dir.to_str() else {
        return;
    };
    match shell_name {
        "zsh" => {
            envs.push(("AI_TERM".into(), "1".into()));
            envs.push(("AI_TERM_INTEGRATION_DIR".into(), dir.into()));
            if let Some(original) = std::env::var_os("ZDOTDIR") {
                if let Ok(original) = original.into_string() {
                    envs.push(("AI_TERM_USER_ZDOTDIR".into(), original));
                }
            }
            envs.push((
                "ZDOTDIR".into(),
                integration_dir
                    .join("zdotdir")
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
        "bash" => {
            envs.push(("AI_TERM".into(), "1".into()));
            envs.push(("AI_TERM_INTEGRATION_DIR".into(), dir.into()));
            *args = vec![
                "--init-file".into(),
                integration_dir
                    .join("bash-init.bash")
                    .to_string_lossy()
                    .into_owned(),
                "-i".into(),
            ];
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_scripts_once_and_reports_root() {
        let dir =
            std::env::temp_dir().join(format!("ai-term-integration-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = ensure_integration_scripts(&dir).expect("write scripts");
        assert!(root.join("integration.zsh").exists());
        assert!(root.join("zdotdir/.zshrc").exists());
        // 第二次调用不应报错(幂等)
        ensure_integration_scripts(&dir).expect("idempotent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zsh_injection_sets_zdotdir() {
        let mut args = vec!["-i".to_string()];
        let mut envs = Vec::new();
        apply_shell_integration("/bin/zsh", &mut args, &mut envs, Path::new("/tmp/it"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "ZDOTDIR" && value.ends_with("zdotdir")));
        assert_eq!(args, vec!["-i".to_string()]);
    }

    #[test]
    fn unknown_shell_untouched() {
        let mut args = vec!["-i".to_string()];
        let mut envs = Vec::new();
        apply_shell_integration("/bin/fish", &mut args, &mut envs, Path::new("/tmp/it"));
        assert!(envs.is_empty());
    }
}
