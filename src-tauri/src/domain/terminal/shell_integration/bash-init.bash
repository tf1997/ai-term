# AI Term bash 启动中转(--init-file):先加载用户 .bashrc,再启用集成。
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi
if [[ -n "${AI_TERM_INTEGRATION_DIR:-}" && -f "${AI_TERM_INTEGRATION_DIR}/integration.bash" ]]; then
  source "${AI_TERM_INTEGRATION_DIR}/integration.bash"
fi
