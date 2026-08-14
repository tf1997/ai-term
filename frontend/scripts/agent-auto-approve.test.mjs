import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_READONLY_COMMANDS,
  classifyForAutoExec,
  suggestPatternForCommand,
  validateAllowlistPattern
} from '../src/lib/agentAutoApprove.ts'

const builtinOnly = { userPatterns: [], includeBuiltin: true }

function classify(command, sources = builtinOnly) {
  return classifyForAutoExec(command, sources)
}

test('单命令命中内置只读集', () => {
  const df = classify('df -h')
  assert.equal(df.eligible, true)
  assert.equal(df.matched, 'df')
  assert.equal(df.suggestedPattern, 'df')

  const ls = classify('ls -la /var')
  assert.equal(ls.eligible, true)
  assert.equal(ls.matched, 'ls')

  assert.equal(classify('uname -a').eligible, true)
  assert.equal(classify('free -h').eligible, true)

  // 反例:不在集合内的命令不放行
  const rm = classify('rm -rf /tmp/x')
  assert.equal(rm.eligible, false)
  assert.equal(rm.matched, undefined)
  assert.equal(classify('vim /etc/hosts').eligible, false)
  assert.equal(classify('touch /tmp/a').eligible, false)
})

test('管道逐段判定', () => {
  const piped = classify('ps aux | grep nginx')
  assert.equal(piped.eligible, true)
  assert.equal(piped.matched, 'ps')
  assert.equal(classify('ps aux|grep nginx').eligible, true, '无空格管道同样分段')
  assert.equal(classify('ps aux |& grep nginx').eligible, true, '|& 等价 2>&1 | 按管道处理')

  // 反例:任一段不通过则整体不通过
  assert.equal(classify('cat a | sh').eligible, false)
  assert.equal(classify('df -h | tee /tmp/out').eligible, false)
})

test('链式命令逐段判定', () => {
  assert.equal(classify('df -h && free -h').eligible, true)
  assert.equal(classify('df -h; uptime').eligible, true)
  assert.equal(classify('df -h || free -h').eligible, true)
  assert.equal(classify('df -h & free -h').eligible, true, '后台 & 各部分逐段判定')

  // 反例
  assert.equal(classify('df -h && rm -rf /tmp/x').eligible, false)
  assert.equal(classify('ls & rm -rf /tmp/x').eligible, false, '后台 & 不能夹带写操作')
  assert.equal(classify('df -h; reboot').eligible, false)
})

test('输出重定向一票否决与 /dev/null、fd 复制例外', () => {
  assert.equal(classify('ls > out.txt').eligible, false)
  assert.equal(classify('ls >> /var/log/x').eligible, false)
  assert.equal(classify('git diff > /tmp/patch').eligible, false)

  assert.equal(classify('ls > /dev/null').eligible, true)
  assert.equal(classify('ls >> /dev/null').eligible, true)
  assert.equal(classify('ls 2>&1').eligible, true)
  assert.equal(classify('ls 2>/dev/null').eligible, true)
  assert.equal(classify('grep -r x . 2> /dev/null').eligible, true)

  // 引号内的 > 不算重定向(echo 不在内置集,用用户 pattern 验证)
  const echoSources = { userPatterns: ['echo'], includeBuiltin: false }
  assert.equal(classify("echo '>'", echoSources).eligible, true)
  assert.equal(classify('echo ">" out', echoSources).eligible, true)
  // 反例:真实重定向时用户 pattern 也越不过否决
  assert.equal(classify('echo > /tmp/x', echoSources).eligible, false)
})

test('sudo 一票否决,允许来源无效', () => {
  const sudoSources = { userPatterns: ['sudo cat'], includeBuiltin: true }
  assert.equal(classify('sudo cat /etc/shadow', sudoSources).eligible, false)
  assert.equal(classify('sudo df -h').eligible, false)
  assert.equal(classify('FOO=1 sudo df').eligible, false, '剥离 env 前缀后仍按 sudo 否决')
  assert.equal(classify('timeout 5 sudo df').eligible, false, '剥离 timeout 包装后仍按 sudo 否决')
  assert.equal(classify('df -h && sudo ls').eligible, false, '任一段 sudo 即整体否决')
  // 正例对照
  assert.equal(classify('df -h').eligible, true)
})

test('命令替换与进程替换否决,单引号内例外', () => {
  assert.equal(classify('ls $(pwd)').eligible, false)
  assert.equal(classify('ls `pwd`').eligible, false)
  const echoSources = { userPatterns: ['echo'], includeBuiltin: false }
  assert.equal(classify('echo "$(pwd)"', echoSources).eligible, false, '双引号内 $( 仍然生效')
  assert.equal(classify('cat <(rm -rf /tmp/x)').eligible, false, '进程替换 <( ) 内含命令执行')
  assert.equal(classify('ls >(wc)').eligible, false, '进程替换 >( ) 同样否决')

  // 单引号内为字面量,不否决
  assert.equal(classify("grep '$(pwd)' /tmp/f").eligible, true)
  assert.equal(classify("ls '`x`'").eligible, true)
})

test('timeout/command 包装与环境变量前缀剥离', () => {
  const wrapped = classify('timeout 5 df -h')
  assert.equal(wrapped.eligible, true)
  assert.equal(wrapped.matched, 'df')
  assert.equal(classify('timeout -k 3 10s df -h').eligible, true, '-k 带参选项与时长均剥离')
  assert.equal(classify('FOO=1 df -h').eligible, true)
  assert.equal(classify('FOO=1 BAR=2 timeout 30 df -h').eligible, true)
  assert.equal(classify('command df -h').eligible, true)

  // 反例:包装剥离后按内层命令判定
  assert.equal(classify('timeout 5 rm -rf /tmp/x').eligible, false)
  assert.equal(classify('FOO=1', builtinOnly).eligible, false, '纯赋值段无命令可匹配')
})

test('条目级禁用参数:tail / find / journalctl', () => {
  assert.equal(classify('tail -f /var/log/syslog').eligible, false)
  assert.equal(classify('tail --follow=name /var/log/x').eligible, false)
  assert.equal(classify('tail -fn10 /var/log/x').eligible, false, '组合短选项中的 f 同样否决')
  assert.equal(classify('tail -n 100 /var/log/syslog').eligible, true)
  assert.equal(classify('tail -c 200 /tmp/f').eligible, true)

  assert.equal(classify('find /tmp -name x').eligible, true)
  assert.equal(classify('find /tmp -name x -delete').eligible, false)
  assert.equal(classify('find . -name x -exec rm {} \\;').eligible, false)

  assert.equal(classify('journalctl -u nginx -n 50').eligible, true)
  assert.equal(classify('journalctl --vacuum-size=1G').eligible, false)
  assert.equal(classify('journalctl -f').eligible, false)
})

test('条目级禁用参数:docker / kubectl / git 与两 token 条目', () => {
  assert.equal(classify('docker ps').eligible, true)
  assert.equal(classify('docker images').eligible, true)
  assert.equal(classify('docker inspect c1').eligible, true)
  assert.equal(classify('docker logs c1').eligible, true)
  assert.equal(classify('docker logs -f c1').eligible, false)
  assert.equal(classify('docker logs --follow c1').eligible, false)
  assert.equal(classify('docker rm c1').eligible, false, 'docker rm 不在集合')

  assert.equal(classify('kubectl get pods').eligible, true)
  assert.equal(classify('kubectl describe pod x').eligible, true)
  assert.equal(classify('kubectl logs pod-1').eligible, true)
  assert.equal(classify('kubectl logs -f pod-1').eligible, false)
  assert.equal(classify('kubectl delete pod x').eligible, false)

  assert.equal(classify('git status').eligible, true)
  assert.equal(classify('git log --oneline -5').eligible, true)
  assert.equal(classify('git diff --stat').eligible, true)
  assert.equal(classify('git show HEAD').eligible, true)
  assert.equal(classify('git branch').eligible, true)
  assert.equal(classify('git branch -a').eligible, true)
  assert.equal(classify('git branch -D feature').eligible, false)
  assert.equal(classify('git branch --delete feature').eligible, false)
  assert.equal(classify('git push').eligible, false, 'git push 不在集合')
  assert.equal(classify('git stash').eligible, false, 'git stash 不在集合')

  assert.equal(classify('systemctl status nginx').eligible, true)
  assert.equal(classify('systemctl is-active nginx').eligible, true)
  assert.equal(classify('systemctl restart nginx').eligible, false)
})

test('ip 条目 nextTokenAllowlist 限 show 语义', () => {
  assert.equal(classify('ip addr').eligible, true)
  assert.equal(classify('ip addr show').eligible, true)
  assert.equal(classify('ip addr show dev eth0').eligible, true)
  assert.equal(classify('ip route list').eligible, true)
  assert.equal(classify('ip route get 8.8.8.8').eligible, true)
  assert.equal(classify('ip link ls').eligible, true)

  // 反例:首个非选项 token 不在允许列表
  assert.equal(classify('ip addr add 10.0.0.1/24 dev eth0').eligible, false)
  assert.equal(classify('ip link set eth0 down').eligible, false)
  assert.equal(classify('ip route del default').eligible, false)
})

test('用户 pattern 的 token 前缀语义', () => {
  const gitStatus = { userPatterns: ['git status'], includeBuiltin: false }
  const hit = classify('git status --porcelain', gitStatus)
  assert.equal(hit.eligible, true)
  assert.equal(hit.matched, 'git status')
  assert.equal(classify('git status', gitStatus).eligible, true)
  assert.equal(classify('git stash', gitStatus).eligible, false)
  assert.equal(classify('git stat', gitStatus).eligible, false, 'token 完整比较,不是字符串前缀')

  const lsOnly = { userPatterns: ['ls'], includeBuiltin: false }
  assert.equal(classify('ls -la', lsOnly).eligible, true)
  assert.equal(classify('lsof -i', lsOnly).eligible, false, 'ls 不命中 lsof(token 边界)')

  // 用户 pattern 是显式授权,不附加条目级规则(tail -f 在内置集会被禁)
  const tailUser = { userPatterns: ['tail'], includeBuiltin: false }
  assert.equal(classify('tail -f /var/log/x', tailUser).eligible, true)
  // 但一票否决仍然有效
  assert.equal(classify('tail -f /var/log/x > /tmp/o', tailUser).eligible, false)
})

test('includeBuiltin 开关', () => {
  assert.equal(classify('df -h', { userPatterns: [], includeBuiltin: false }).eligible, false, '关闭后内置集不生效')
  assert.equal(classify('df -h', { userPatterns: ['df'], includeBuiltin: false }).eligible, true, '用户 patterns 不受开关影响')
  assert.equal(classify('df -h', builtinOnly).eligible, true)
})

test('未闭合引号与 heredoc 整体否决', () => {
  const echoSources = { userPatterns: ['echo'], includeBuiltin: true }
  assert.equal(classify('echo "abc', echoSources).eligible, false)
  assert.equal(classify("ls 'x").eligible, false)
  assert.equal(classify('cat <<EOF').eligible, false)
  assert.equal(classify("cat << 'EOF'").eligible, false)
  assert.equal(classify('ls <<-EOF').eligible, false)

  // 正例对照:herestring 不是 heredoc,闭合引号正常放行
  assert.equal(classify('wc -l <<< abc').eligible, true)
  assert.equal(classify("grep 'a b' /tmp/f").eligible, true)
})

test('matched 返回首个命中来源(多段取第一段)', () => {
  assert.equal(classify('df -h && free -h').matched, 'df')
  assert.equal(classify('ps aux | grep nginx').matched, 'ps')
  // 用户 pattern 先于内置集命中
  const userFirst = classify('ls -la /var', { userPatterns: ['ls -la'], includeBuiltin: true })
  assert.equal(userFirst.matched, 'ls -la')
  // 内置条目返回条目 pattern 文本
  assert.equal(classify('git log --oneline').matched, 'git log')
})

test('suggestPatternForCommand', () => {
  assert.equal(suggestPatternForCommand('git status --porcelain'), 'git status')
  assert.equal(suggestPatternForCommand('df -h'), 'df')
  assert.equal(suggestPatternForCommand('FOO=1 timeout 5 docker logs x'), 'docker logs')
  assert.equal(suggestPatternForCommand('ps aux | grep nginx'), 'ps', '多段取第一段')
  assert.equal(suggestPatternForCommand('systemctl status nginx'), 'systemctl status')
  assert.equal(suggestPatternForCommand('rm -rf /tmp/x'), 'rm', '建议值与是否放行无关')
  assert.equal(suggestPatternForCommand(''), '')
  assert.equal(suggestPatternForCommand('   '), '')

  // classify 返回的 suggestedPattern 与之一致,否决时也给建议
  assert.equal(classify('tail -f x').suggestedPattern, 'tail')
  assert.equal(classify('docker logs -f c1').suggestedPattern, 'docker logs')
})

test('validateAllowlistPattern 正反例', () => {
  assert.deepEqual(validateAllowlistPattern('git status'), { ok: true })
  assert.deepEqual(validateAllowlistPattern('ls'), { ok: true })
  assert.deepEqual(validateAllowlistPattern('systemctl status nginx'), { ok: true })
  assert.deepEqual(validateAllowlistPattern('a b c d'), { ok: true }, '4 个 token 为上限内')

  const cases = [
    ['', '空'],
    ['   ', '仅空白'],
    ['sudo cat', 'sudo 开头'],
    ['ls > /dev/null', '含 >'],
    ['echo $(x)', '含 $('],
    ['cat a | sh', '含 |'],
    ['df; rm', '含 ;'],
    ['tail `x`', '含反引号'],
    ["grep 'x'", '含引号'],
    ['ls\ncat', '含换行'],
    ['a b c d e', '超过 4 个 token']
  ]
  for (const [pattern, label] of cases) {
    const result = validateAllowlistPattern(pattern)
    assert.equal(result.ok, false, `${label} 应被拒绝`)
    assert.ok(result.reason, `${label} 应给出中文原因`)
  }
})

test('规格之外的额外收紧(写/执行漏洞封堵)', () => {
  // env CMD 会执行任意命令,仅允许纯选项用法
  assert.equal(classify('env').eligible, true)
  assert.equal(classify('env -0').eligible, true)
  assert.equal(classify('env rm -rf /tmp/x').eligible, false)
  // hostname <名称> 会设置主机名
  assert.equal(classify('hostname').eligible, true)
  assert.equal(classify('hostname -f').eligible, true)
  assert.equal(classify('hostname evil-name').eligible, false)
  // date -s/--set 会设置系统时间
  assert.equal(classify('date +%s').eligible, true)
  assert.equal(classify('date -s 2020-01-01').eligible, false)
  assert.equal(classify('date --set=2020-01-01').eligible, false)
  // ss -K/--kill 会强制关闭连接
  assert.equal(classify('ss -tlnp').eligible, true)
  assert.equal(classify('ss -K dst 10.0.0.1').eligible, false)
  // tail -F 与 -f 等价
  assert.equal(classify('tail -F /var/log/x').eligible, false)
  // 裸 git branch <名> 是建分支;--set-upstream-to 等是写操作
  assert.equal(classify('git branch new-feature').eligible, false)
  assert.equal(classify('git branch --set-upstream-to=origin/main').eligible, false)
  // git log/diff/show 的 --output 写文件
  assert.equal(classify('git log -p').eligible, true)
  assert.equal(classify('git log --output=/tmp/x').eligible, false)
  // rg --pre 执行外部命令(--pretty 是展示选项,不受影响)
  assert.equal(classify('rg -n TODO src').eligible, true)
  assert.equal(classify('rg --pretty TODO').eligible, true)
  assert.equal(classify('rg --pre cat TODO .').eligible, false)
  // find -fprint0 写文件(规格正则漏掉的谓词)
  assert.equal(classify('find . -fprint0 /tmp/out').eligible, false)
  // journalctl --rotate 等写日志目录
  assert.equal(classify('journalctl --rotate').eligible, false)
  // 危险环境变量前缀能改变实际执行的代码
  assert.equal(classify('LC_ALL=C ls').eligible, true)
  assert.equal(classify('PATH=/tmp ls').eligible, false)
  assert.equal(classify('LD_PRELOAD=/tmp/e.so cat /tmp/f').eligible, false)
  // 交互终端的历史展开(!!、!字符串)会插入历史命令文本,按注入结构否决
  assert.equal(classify('ls !!').eligible, false)
  assert.equal(classify('find . ! -name x').eligible, true, '! 后随空格为字面量')
  assert.equal(classify("grep 'a!b' /tmp/f").eligible, true, '单引号内为字面量')
})

test('内置集数据完整性', () => {
  for (const entry of BUILTIN_READONLY_COMMANDS) {
    const tokenCount = entry.pattern.split(' ').length
    assert.ok(tokenCount >= 1 && tokenCount <= 2, `${entry.pattern} 应为 1–2 个 token`)
    assert.equal(validateAllowlistPattern(entry.pattern).ok, true, `${entry.pattern} 应通过同源校验`)
  }
  const firstTokens = new Set(BUILTIN_READONLY_COMMANDS.map((entry) => entry.pattern.split(' ')[0]))
  for (const excluded of ['less', 'more', 'top', 'watch', 'curl', 'wget', 'echo', 'cd']) {
    assert.equal(firstTokens.has(excluded), false, `${excluded} 刻意不收录`)
  }
  // 条目 pattern 互不重复
  const patterns = BUILTIN_READONLY_COMMANDS.map((entry) => entry.pattern)
  assert.equal(new Set(patterns).size, patterns.length)
})
