/** 自动切歌未安排时，根据原因提供建议；权限问题不提示无效的重试。 */
export const resolvePlaybackFailureDetail = (reason: string): string => {
  if (/VIP|会员|购买|付费|支付|权益|授权|版权|下架/i.test(reason)) return '';
  // 上游已经给出操作建议时，不再追加一条重复的说明。
  if (/请.*(?:重试|检查)|后重试/.test(reason)) return '';
  if (/网络|超时|离线|连接(?:失败|异常|中断)/.test(reason)) return '请检查网络后重试';
  if (/解码|不支持|缓冲不足|访问被拒绝/.test(reason)) return '';
  return '请稍后重试';
};
