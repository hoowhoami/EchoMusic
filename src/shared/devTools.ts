/** 开发者模式 CDP 调试端口默认值 */
export const DEFAULT_DEVTOOLS_DEBUG_PORT = 9223;
/** 调试端口允许范围：避开需要特权的系统端口 */
export const MIN_DEVTOOLS_DEBUG_PORT = 1024;
export const MAX_DEVTOOLS_DEBUG_PORT = 65535;

/** 解析调试端口，非法值返回 null（供 UI 判断是否忽略输入） */
export const parseDevToolsDebugPort = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const port = Number(value);
  return Number.isInteger(port) &&
    port >= MIN_DEVTOOLS_DEBUG_PORT &&
    port <= MAX_DEVTOOLS_DEBUG_PORT
    ? port
    : null;
};

/** 归一化调试端口，非法值回退默认端口 */
export const normalizeDevToolsDebugPort = (value: unknown): number =>
  parseDevToolsDebugPort(value) ?? DEFAULT_DEVTOOLS_DEBUG_PORT;
