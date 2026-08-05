# AI Term shell integration(bash):OSC 133 语义标记。bash 无 preexec,
# 命令文本不经 633;E 上报,由前端从屏幕缓冲兜底捕获。
case "$-" in *i*) ;; *) return 0 ;; esac
[ -n "${AI_TERM_SHELL_INTEGRATION_ACTIVE:-}" ] && return 0
[ -n "${VSCODE_SHELL_INTEGRATION:-}" ] && return 0
AI_TERM_SHELL_INTEGRATION_ACTIVE=1

__ai_term_exit=0

__ai_term_capture_exit() {
  __ai_term_exit=$?
}

__ai_term_prompt_command() {
  printf '\e]133;D;%s\a\e]133;A\a\e]7;file://%s%s\a' "$__ai_term_exit" "${HOSTNAME:-localhost}" "$PWD"
  # 主题可能在 PROMPT_COMMAND 里重写 PS1,每个周期检查并补回 B 标记
  if [[ "$PS1" != *']133;B'* ]]; then
    PS1="${PS1}\[\e]133;B\a\]"
  fi
}

# PS0 在读取到非空命令后、执行前展开:C 标记(空回车不触发)
PS0="${PS0}\e]133;C\a"

# 退出码最先捕获,标记输出放在既有 PROMPT_COMMAND(可能重写 PS1)之后
if [ -z "${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="__ai_term_capture_exit;__ai_term_prompt_command"
else
  PROMPT_COMMAND="__ai_term_capture_exit;${PROMPT_COMMAND};__ai_term_prompt_command"
fi
