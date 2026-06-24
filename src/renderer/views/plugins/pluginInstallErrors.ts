export const getPluginInstallErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('reply was never sent')) {
    return '插件安装被主进程中断，请重启 EchoMusic 后检查插件状态';
  }
  return message || '插件安装失败';
};
