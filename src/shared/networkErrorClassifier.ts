// 在线插件网络错误的分类与文案映射。
// 主进程抓取插件源失败时调用 classifyNetworkError 生成结构化详情，
// 渲染层据此展示友好文案，并通过「显示详情」弹窗查看原始错误。

export type MarketplaceNetworkErrorCategory =
  | 'offline'
  | 'dns'
  | 'timeout'
  | 'reset'
  | 'refused'
  | 'proxy'
  | 'ssl'
  | 'rate-limit'
  | 'not-found'
  | 'http'
  | 'unknown';

export interface MarketplaceErrorDetail {
  category: MarketplaceNetworkErrorCategory;
  /** 中文类别名，如「连接被重置」。 */
  categoryLabel: string;
  /** 展示给用户的友好标题。 */
  title: string;
  /** 一句可操作的建议文案。 */
  hint: string;
  /** HTTP 状态码（响应已返回时）。 */
  httpStatus?: number;
  /** 实际失败的请求地址（可能带加速前缀或缓存穿透参数）。 */
  url?: string;
  /** 原始错误消息。 */
  rawMessage: string;
  /** 失败时间戳。 */
  failedAt: number;
}

/** 抓取上下文：HTTP 状态码与实际失败的 URL，附加到错误对象上供分类器读取。 */
interface FetchErrorContext {
  statusCode?: number;
  failedUrl?: string;
}

type ErrorWithFetchContext = Error & Partial<FetchErrorContext>;

/** 给错误附加抓取上下文，供 classifyNetworkError 读取，返回原错误便于链式抛出。 */
export const attachFetchErrorContext = (
  error: unknown,
  context: FetchErrorContext,
): unknown => {
  if (error instanceof Error) {
    const target = error as ErrorWithFetchContext;
    if (context.statusCode !== undefined) target.statusCode = context.statusCode;
    if (context.failedUrl) target.failedUrl = context.failedUrl;
  }
  return error;
};

// 各类别展示文案：title 用于错误条/toast，hint 用于详情弹窗的建议区块。
const CATEGORY_MESSAGES: Record<
  MarketplaceNetworkErrorCategory,
  { label: string; title: string; hint: string }
> = {
  offline: {
    label: '网络未连接',
    title: '网络未连接，无法访问插件源',
    hint: '设备当前没有可用的网络连接，请检查网络后再刷新重试。',
  },
  dns: {
    label: '域名解析失败',
    title: '无法解析插件源地址',
    hint: '域名解析失败，可能是 DNS 异常或当前网络无法访问 GitHub，可在 设置 → 网络 中配置代理或 GitHub 加速地址。',
  },
  timeout: {
    label: '连接超时',
    title: '连接插件源超时',
    hint: '连接在限定时间内没有响应，当前网络到 GitHub 的链路可能不稳定，可在 设置 → 网络 中配置代理或 GitHub 加速地址。',
  },
  reset: {
    label: '连接被重置',
    title: '与插件源的连接被中断',
    hint: '连接在传输过程中被重置，常见于网络对 GitHub 的访问被阻断，可在 设置 → 网络 中配置代理或 GitHub 加速地址。',
  },
  refused: {
    label: '连接被拒绝',
    title: '插件源拒绝了连接请求',
    hint: '目标端口拒绝连接，请确认插件源仓库地址是否正确，或检查本地防火墙与代理设置。',
  },
  proxy: {
    label: '代理不可用',
    title: '代理服务器无法访问插件源',
    hint: '请求经代理转发失败，请检查 设置 → 网络 中的代理是否在线、地址与端口是否正确。',
  },
  ssl: {
    label: '证书校验失败',
    title: '插件源的安全证书校验失败',
    hint: 'HTTPS 证书校验未通过，可能是代理劫持或系统时间异常，请检查 设置 → 网络 中的代理配置。',
  },
  'rate-limit': {
    label: '请求被限流',
    title: '插件源请求触发限流',
    hint: 'GitHub 或加速服务暂时限制了请求频率，请稍后再试，或更换 设置 → 网络 中的 GitHub 加速地址。',
  },
  'not-found': {
    label: '索引不存在',
    title: '未找到插件索引文件',
    hint: '仓库中不存在 echo-plugins.json，请确认插件源仓库地址是否正确、仓库是否包含该索引文件。',
  },
  http: {
    label: '服务端响应异常',
    title: '插件源返回异常响应',
    hint: '服务端返回了异常状态码，可能是 GitHub 或加速服务临时故障，请稍后刷新重试。',
  },
  unknown: {
    label: '加载失败',
    title: '在线插件列表加载失败',
    hint: '发生了未知错误，可在下方详情查看原始错误信息，或稍后刷新重试。',
  },
};

// 按优先级排列的匹配规则：依次检查错误消息及 cause 链上的文本。
const CATEGORY_PATTERNS: Array<{
  category: MarketplaceNetworkErrorCategory;
  patterns: RegExp[];
}> = [
  { category: 'offline', patterns: [/ERR_INTERNET_DISCONNECTED/i] },
  {
    category: 'dns',
    patterns: [
      /ERR_NAME_NOT_RESOLVED/i,
      /ERR_DNS_/i,
      /\bENOTFOUND\b/,
      /\bEAI_AGAIN\b/,
      /getaddrinfo/i,
    ],
  },
  {
    category: 'timeout',
    patterns: [
      /ERR_CONNECTION_TIMED_OUT/i,
      /ERR_TIMED_OUT/i,
      /\bETIMEDOUT\b/,
      /UND_ERR_CONNECT_TIMEOUT/i,
      /UND_ERR_HEADERS_TIMEOUT/i,
      /请求超时/,
    ],
  },
  {
    category: 'reset',
    patterns: [
      /ERR_CONNECTION_RESET/i,
      /ERR_CONNECTION_ABORTED/i,
      /ERR_NETWORK_CHANGED/i,
      /\bECONNRESET\b/,
      /\bEPIPE\b/,
      /socket hang up/i,
    ],
  },
  { category: 'refused', patterns: [/ERR_CONNECTION_REFUSED/i, /\bECONNREFUSED\b/] },
  {
    category: 'proxy',
    patterns: [
      /ERR_TUNNEL_CONNECTION_FAILED/i,
      /ERR_PROXY_CONNECTION_FAILED/i,
      /ERR_NO_SUPPORTED_PROXIES/i,
      /ERR_MANDATORY_PROXY_SETUP/i,
    ],
  },
  { category: 'ssl', patterns: [/ERR_CERT_/i, /ERR_SSL_/i] },
];

// 收集错误及其 cause 链上的所有文本（message + code 属性）。
const collectErrorTexts = (error: unknown, depth = 0): string[] => {
  if (!error || depth > 5) return [];
  const texts: string[] = [];
  if (error instanceof Error) {
    if (error.message) texts.push(error.message);
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') texts.push(code);
  } else if (typeof error === 'string') {
    texts.push(error);
  }
  const cause = (error as { cause?: unknown })?.cause;
  if (cause) texts.push(...collectErrorTexts(cause, depth + 1));
  return texts;
};

export const classifyNetworkError = (
  error: unknown,
  context?: { url?: string },
): MarketplaceErrorDetail => {
  const texts = collectErrorTexts(error);
  const rawMessage =
    error instanceof Error && error.message ? error.message : String(error ?? '未知错误');
  const fetchContext = (error ?? {}) as Partial<FetchErrorContext>;
  const statusCode =
    typeof fetchContext.statusCode === 'number' ? fetchContext.statusCode : undefined;

  let category: MarketplaceNetworkErrorCategory = 'unknown';

  // 先按错误码/消息特征分类（网络层错误优先于 HTTP 状态）。
  outer: for (const rule of CATEGORY_PATTERNS) {
    for (const pattern of rule.patterns) {
      if (texts.some((text) => pattern.test(text))) {
        category = rule.category;
        break outer;
      }
    }
  }

  // 网络层特征未命中时，再按 HTTP 状态码归类。
  if (category === 'unknown' && statusCode) {
    if (statusCode === 403 || statusCode === 429) category = 'rate-limit';
    else if (statusCode === 404) category = 'not-found';
    else if (statusCode >= 400) category = 'http';
  }

  const messages = CATEGORY_MESSAGES[category];
  const detail: MarketplaceErrorDetail = {
    category,
    categoryLabel: messages.label,
    title: messages.title,
    hint: messages.hint,
    rawMessage,
    failedAt: Date.now(),
  };
  if (statusCode !== undefined) detail.httpStatus = statusCode;
  const failedUrl = fetchContext.failedUrl || context?.url;
  if (failedUrl) detail.url = failedUrl;
  return detail;
};
