( export LC_ALL=C
command -v base64 >/dev/null 2>&1 || exit 1
ai_snap_host=$(hostname 2>/dev/null) && ai_snap_uid=$(id -u) && ai_snap_root=$(ls -id /) || exit 1
printf '@TAG@_SCOPE\n'
printf '%s\n%s\n%s\n%s' "$ai_snap_host" "$ai_snap_uid" "$ai_snap_root" "$(readlink /proc/self/ns/mnt 2>/dev/null)" | base64
printf '\n@TAG@_SCOPE_END\n'
ai_snap_i=0
ai_snap_budget=262144
for ai_snap_path in @PATHS@; do
  printf '@TAG@_FILE_%s\n' "$ai_snap_i"
  ai_snap_parent=$(dirname "$ai_snap_path")
  ai_snap_name=$(basename "$ai_snap_path")
  ai_snap_dir=$(CDPATH= cd -P "$ai_snap_parent" 2>/dev/null && pwd -P)
  ai_snap_resolved=$ai_snap_path
  if [ -n "$ai_snap_dir" ]; then ai_snap_resolved="${ai_snap_dir%/}/$ai_snap_name"; fi
  printf '%s' "$ai_snap_resolved" | base64
  printf '\n@TAG@_PATH_END\n'
  ai_snap_lower=$(printf '%s' "$ai_snap_resolved" | tr '[:upper:]' '[:lower:]')
  case "$ai_snap_lower" in
    */.ssh/*|*/.aws/*|*/.kube/*|*/.docker/*|*/library/keychains/*|*/.env|*/.env.*|*/shadow*|*/gshadow*|*/sudoers*|*.pem|*.key|*.p12|*.pfx|*.jks|*.keychain-db|*/.netrc|*/.npmrc|*/.pypirc|*/cookies|*/logins.json|*/'login data')
      printf 'unsupported\n\n@TAG@_FILE_END\n'
      ai_snap_i=$((ai_snap_i + 1))
      continue;;
  esac
  if [ -L "$ai_snap_path" ]; then
    printf 'unsupported\n'
  elif [ -f "$ai_snap_path" ]; then
    if [ "$ai_snap_budget" -le 0 ]; then
      printf 'budget\n'
    else
      ai_snap_limit=65536
      if [ "$ai_snap_budget" -lt "$ai_snap_limit" ]; then ai_snap_limit=$ai_snap_budget; fi
      printf 'text\n'
      { head -c "$((ai_snap_limit + 1))" "$ai_snap_path" 2>/dev/null; ai_snap_read_status=$?; printf '\n@TAG@_READ_STATUS_%s\n' "$ai_snap_read_status"; } | base64
      ai_snap_size=$(wc -c < "$ai_snap_path" 2>/dev/null) || ai_snap_size=$((ai_snap_limit + 1))
      case "$ai_snap_size" in *[!0-9[:space:]]*|'') ai_snap_size=$((ai_snap_limit + 1));; esac
      ai_snap_budget=$((ai_snap_budget - ai_snap_size))
    fi
  elif [ -e "$ai_snap_path" ]; then
    printf 'unsupported\n'
  else
    ai_snap_ancestor=$ai_snap_parent
    while [ ! -e "$ai_snap_ancestor" ] && [ ! -L "$ai_snap_ancestor" ] && [ "$ai_snap_ancestor" != / ]; do
      ai_snap_ancestor=$(dirname "$ai_snap_ancestor")
    done
    if [ -d "$ai_snap_ancestor" ] && [ -x "$ai_snap_ancestor" ]; then printf 'missing\n'; else printf 'unreadable\n'; fi
  fi
  printf '\n@TAG@_FILE_END\n'
  ai_snap_i=$((ai_snap_i + 1))
done
)
