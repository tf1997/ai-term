/**
 * 把 AI 请求失败的原始报错整理成可读的结构化呈现。
 *
 * 输入是后端 `anyhow` 链或前端 catch 到的原文（见 src-tauri/src/domain/ai/），
 * 通常形如 `模型请求失败：HTTP 502\n模型未返回错误正文`。直接铺在 Markdown 里
 * 会塌成一行连续冒号的句子，既看不出是哪一类故障，也给不出下一步动作。
 */

export interface AiErrorPresentation {
  /** 一句话结论,替代原始首行。 */
  title: string
  /** 短标签,如 `HTTP 502` / `超时` / `网络`;无法归类时为空。 */
  code: string
  /** 下一步建议;归类不到时为空,由折叠区里的原文兜底。 */
  hint: string
  /** 清洗后的原始报文,供折叠区展示与复制。 */
  detail: string
  /** 是否值得直接重试(网关/限流/超时/网络类为真,配置与鉴权类为假)。 */
  retryable: boolean
}

/** 兜底标题的截断长度,超出部分用省略号收尾。 */
const FALLBACK_TITLE_MAX = 60

/**
 * 历史消息里拼过的装饰性前缀。错误正文现在只存原始报文,但数据库里仍有旧记录,
 * 重新加载会话时要能剥回原文,否则卡片会把「任务出错：」当成故障内容。
 */
const LEGACY_PREFIXES = [
  '任务出错：',
  '模型流式调用失败。\n\n错误详情：',
  '模型调用失败，未执行任何远程请求结果。\n\n错误详情：'
]

/** 旧 catch 分支会在正文尾部追加本地建议命令,同样需要剥离。 */
const LEGACY_SUGGESTION_PATTERN = /\n\n可临时参考本地建议：[\s\S]*$/

function stripLegacyDecoration(raw: string) {
  let text = raw.replace(/\r\n?/g, '\n').trim()
  for (const prefix of LEGACY_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim()
      break
    }
  }
  return text.replace(LEGACY_SUGGESTION_PATTERN, '').trim()
}

function firstLine(text: string) {
  return text.split('\n').find((line) => line.trim())?.trim() ?? ''
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function httpStatus(text: string) {
  const match = text.match(/HTTP\s+(\d{3})/i)
  return match ? Number(match[1]) : 0
}

/** 归类结果:除 detail 外的全部字段,detail 由调用方统一填。 */
type Classification = Omit<AiErrorPresentation, 'detail'>

function classify(text: string): Classification {
  const lower = text.toLowerCase()
  const status = httpStatus(text)

  // 配置缺失优先于一切:没填 Base URL / Model / API Key 时根本没发出请求。
  if (text.includes('请先配置 AI Base URL') || text.includes('请先配置 AI Model') || text.includes('请在 AI 配置中填写 API Key')) {
    return {
      title: 'AI 配置不完整',
      code: '配置',
      hint: '在左侧配置菜单里补全接口地址、模型名称与 API Key 后再试。',
      retryable: false
    }
  }

  if (text.includes('AI 后端调用不可用') || text.includes('__TAURI_IPC__')) {
    return {
      title: '本地后端不可用',
      code: '本地',
      hint: '请通过 Tauri 客户端运行，或在 src-tauri 目录执行 cargo run。',
      retryable: false
    }
  }

  if (text.includes('AI 接口返回了 HTML 页面')) {
    return {
      title: '接口返回了网页而不是模型响应',
      code: '配置',
      hint: 'Base URL 可能填成了控制台或登录页，展开详情按提示改成 OpenAI 兼容 API 根路径。',
      retryable: false
    }
  }

  if (status === 401 || status === 403) {
    return {
      title: '鉴权失败，API Key 无效或无权限',
      code: `HTTP ${status}`,
      hint: '检查 AI 配置中的 API Key 是否正确、是否有该模型的调用权限。',
      retryable: false
    }
  }

  if (status === 404) {
    return {
      title: '接口地址或模型不存在',
      code: 'HTTP 404',
      hint: '检查配置中的接口地址与模型名称，注意 Base URL 通常以 /v1 结尾。',
      retryable: false
    }
  }

  if (status === 429) {
    return {
      title: '请求过于频繁，已被限流',
      code: 'HTTP 429',
      hint: '稍等片刻再重试；持续触发可降低提问频率或更换渠道。',
      retryable: true
    }
  }

  if (status === 400 || status === 422) {
    return {
      title: '请求被模型拒绝',
      code: `HTTP ${status}`,
      hint: '模型名或请求参数可能不被该接口支持，展开详情核对后调整配置。',
      retryable: false
    }
  }

  if (status === 408 || status === 504) {
    return {
      title: '请求超时',
      code: `HTTP ${status}`,
      hint: '检查网络连通性，或减少随请求发送的终端上下文后重试。',
      retryable: true
    }
  }

  if (status >= 500) {
    return {
      title: '模型服务暂时不可用',
      code: `HTTP ${status}`,
      hint: '服务端网关错误，稍后重试；持续失败可在 AI 配置中更换模型或接口地址。',
      retryable: true
    }
  }

  const streamInterrupted = text.includes('流式响应读取中断') || lower.includes('failed to read ai stream chunk')
  const streamIdleTimeout = text.includes('流式响应超时')

  if ((streamInterrupted || streamIdleTimeout) && (text.includes('超时') || lower.includes('timeout') || lower.includes('timed out'))) {
    return {
      title: 'AI 回复等待超时',
      code: '超时',
      hint: streamIdleTimeout
        ? '等待模型数据超过配置的超时时间。可在 AI 配置中调大请求超时，或设为 0 取消超时后重试。'
        : '流式连接等待超时。可重试；持续发生时请检查网络、代理或模型服务的超时设置。',
      retryable: true
    }
  }

  if (streamInterrupted) {
    return {
      title: 'AI 回复连接中断',
      code: '断流',
      hint: '网络、代理或模型服务可能提前关闭了连接。可重试；部分回复不代表完整结果。',
      retryable: true
    }
  }

  if (text.includes('超时') || lower.includes('timeout') || lower.includes('timed out')) {
    return {
      title: '请求超时',
      code: '超时',
      hint: '检查网络连通性，或减少随请求发送的终端上下文后重试。',
      retryable: true
    }
  }

  if (text.includes('网络请求失败') || lower.includes('dns') || lower.includes('connection refused') || lower.includes('certificate')) {
    return {
      title: '网络无法访问模型服务',
      code: '网络',
      hint: '检查本机网络、代理设置，以及接口地址是否可达。',
      retryable: true
    }
  }

  if (text.includes('模型返回为空') || text.includes('AI 未返回会话摘要')) {
    return {
      title: '模型没有返回内容',
      code: '空响应',
      hint: '可以直接重试；反复为空时换一个模型试试。',
      retryable: true
    }
  }

  if (status >= 400) {
    return {
      title: '请求未被接受',
      code: `HTTP ${status}`,
      hint: '展开详情查看接口返回的原因，确认接口地址与模型配置。',
      retryable: false
    }
  }

  return {
    title: truncate(firstLine(text) || '模型请求失败', FALLBACK_TITLE_MAX),
    code: '',
    hint: '',
    retryable: true
  }
}

/**
 * 归类一条 AI 错误原文。空输入也返回可渲染的结构,调用方无需额外判空。
 */
export function describeAiError(raw: string): AiErrorPresentation {
  const detail = stripLegacyDecoration(raw ?? '')
  if (!detail) {
    return {
      title: '模型请求失败',
      code: '',
      hint: '未拿到具体错误信息，可以直接重试。',
      detail: '',
      retryable: true
    }
  }
  return { ...classify(detail), detail }
}

/**
 * 折叠区是否值得展示:原文只有一行且已经被标题完整表达时,再开一层没有信息量。
 */
export function hasExtraErrorDetail(view: AiErrorPresentation) {
  return Boolean(view.detail) && view.detail !== view.title
}
