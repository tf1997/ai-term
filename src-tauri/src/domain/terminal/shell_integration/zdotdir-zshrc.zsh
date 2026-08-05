# AI Term ZDOTDIR 中转(.zshrc):加载用户原 .zshrc 后启用 shell integration。
if [[ -n "${AI_TERM_USER_ZDOTDIR:-}" ]]; then
  ZDOTDIR="$AI_TERM_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zshrc"
fi
if [[ -n "${AI_TERM_INTEGRATION_DIR:-}" && -f "${AI_TERM_INTEGRATION_DIR}/integration.zsh" ]]; then
  builtin source "${AI_TERM_INTEGRATION_DIR}/integration.zsh"
fi
