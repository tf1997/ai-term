# AI Term ZDOTDIR 中转(.zshenv):恢复用户 ZDOTDIR 加载原 .zshenv,
# 再把 ZDOTDIR 指回中转目录,保证后续 .zshrc 仍从这里进入。
AI_TERM_INJECTED_ZDOTDIR="${ZDOTDIR:-}"
if [[ -n "${AI_TERM_USER_ZDOTDIR:-}" ]]; then
  ZDOTDIR="$AI_TERM_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
if [[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zshenv"
fi
# 用户 .zshenv 可能改写 ZDOTDIR,记录下来供 .zshrc 使用
AI_TERM_USER_ZDOTDIR="${ZDOTDIR:-${AI_TERM_USER_ZDOTDIR:-}}"
ZDOTDIR="$AI_TERM_INJECTED_ZDOTDIR"
