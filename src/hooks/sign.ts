import { watch } from 'vue';
import { useUserStore, useSettingStore } from '@/store';
import { autoSignService } from '@/utils/sign';

/**
 * 自动签到相关逻辑
 */
export function useSign() {
  const userStore = useUserStore();
  const settingStore = useSettingStore();

  // 监听用户登录状态变化
  const stopWatchAuth = watch(
    () => userStore.isAuthenticated,
    isAuthenticated => {
      if (isAuthenticated) {
        autoSignService.start();
      } else {
        autoSignService.stop();
      }
    },
  );

  // 监听自动签到和自动领取VIP配置变化
  const stopWatchSettings = watch(
    () => [settingStore.autoSign, settingStore.autoReceiveVip],
    () => {
      if (userStore.isAuthenticated) {
        autoSignService.restart();
      }
    },
  );

  /**
   * 初始化自动签到服务
   */
  const initAutoSign = () => {
    // 如果用户已登录，启动自动签到服务
    if (userStore.isAuthenticated) {
      autoSignService.start();
    }
  };

  /**
   * 清理资源
   */
  const cleanup = () => {
    autoSignService.stop();
    stopWatchAuth();
    stopWatchSettings();
  };

  return {
    initAutoSign,
    cleanup,
  };
}
