# AI Term shell integration(zsh):通过 OSC 133/633 语义标记上报提示符与
# 命令边界、命令文本和退出码。由 AI Term 启动本地 zsh 时经 ZDOTDIR 中转加载。
# 协议与前端消费逻辑见 docs/shell-integration-development.md。

[[ -o interactive ]] || return 0
[[ -n "${AI_TERM_SHELL_INTEGRATION_ACTIVE:-}" ]] && return 0
# 避让:宿主环境已有其它 shell integration 在发标记时不重复安装
[[ -n "${VSCODE_SHELL_INTEGRATION:-}" ]] && return 0
AI_TERM_SHELL_INTEGRATION_ACTIVE=1

builtin autoload -Uz add-zsh-hook

__ai_term_command_running=0
__ai_term_exit_code=0
__ai_term_mark_b=$'%{\e]133;B\a%}'

__ai_term_osc() {
  builtin printf '\e]%s\a' "$1"
}

# $? 会被先于本脚本注册的其它 precmd 钩子(主题等)覆写,
# 用前置钩子最先捕获;标记输出的钩子照常追加在最后。
__ai_term_capture_exit() {
  __ai_term_exit_code=$?
}

__ai_term_precmd() {
  if (( __ai_term_command_running )); then
    __ai_term_command_running=0
    __ai_term_osc "133;D;${__ai_term_exit_code}"
  else
    __ai_term_osc "133;D"
  fi
  __ai_term_osc "133;A"
  __ai_term_osc "7;file://${HOST:-localhost}${PWD}"
  # 主题可能在自己的 precmd 里重写 PS1,每个周期检查并补回 B 标记
  if [[ "$PS1" != *"$__ai_term_mark_b"* ]]; then
    PS1="${PS1}${__ai_term_mark_b}"
  fi
}

__ai_term_preexec() {
  __ai_term_command_running=1
  local encoded
  encoded=$(builtin printf '%s' "$1" | command base64 | command tr -d '\n')
  __ai_term_osc "633;E;${encoded};base64"
  __ai_term_osc "133;C"
}

precmd_functions=(__ai_term_capture_exit ${precmd_functions:#__ai_term_capture_exit})
add-zsh-hook precmd __ai_term_precmd
add-zsh-hook preexec __ai_term_preexec
