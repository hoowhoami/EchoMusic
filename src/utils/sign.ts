import { useUserStore, useSettingStore } from '@/store';
import { youthDayVip, youthMonthVipRecord, youthVip } from '@/api';
import { formatTimestamp } from '@/utils';
import type { VipReceive } from '@/types';

export interface VipMonthRecord {
  day: string;
}

export class AutoSignService {
  private signIntervalId: number | null = null;
  private vipIntervalId: number | null = null;
  private isRunning = false;
  private isSignInProgress = false;
  private isVipInProgress = false;

  constructor() {
    this.bindMethods();
  }

  private bindMethods() {
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.performAutoSign = this.performAutoSign.bind(this);
    this.performAutoReceiveVip = this.performAutoReceiveVip.bind(this);
  }

  // 启动自动签到服务
  start() {
    if (this.isRunning) return;

    const settingStore = useSettingStore();
    const userStore = useUserStore();

    if (!userStore.isAuthenticated) {
      console.log('用户未登录，无法启动自动签到');
      return;
    }

    this.isRunning = true;
    console.log('启动自动签到服务');

    // 自动签到
    if (settingStore.autoSign) {
      this.startAutoSign();
    }

    // 自动领取VIP
    if (settingStore.autoReceiveVip) {
      this.startAutoReceiveVip();
    }
  }

  // 停止自动签到服务
  stop() {
    if (!this.isRunning) return;

    console.log('停止自动签到服务');
    this.isRunning = false;

    if (this.signIntervalId) {
      clearInterval(this.signIntervalId);
      this.signIntervalId = null;
    }

    if (this.vipIntervalId) {
      clearInterval(this.vipIntervalId);
      this.vipIntervalId = null;
    }
  }

  // 重启服务（配置变化时调用）
  restart() {
    this.stop();
    setTimeout(() => this.start(), 100);
  }

  // 启动自动签到
  private startAutoSign() {
    // 立即执行一次
    this.performAutoSign();

    // 每小时检查一次
    this.signIntervalId = window.setInterval(
      () => {
        this.performAutoSign();
      },
      60 * 60 * 1000,
    );
  }

  // 启动自动领取VIP
  private startAutoReceiveVip() {
    // 立即执行一次
    this.performAutoReceiveVip();

    // 每3分钟检查一次
    this.vipIntervalId = window.setInterval(
      () => {
        this.performAutoReceiveVip();
      },
      3 * 60 * 1000,
    );
  }

  // 执行自动签到
  private async performAutoSign() {
    if (this.isSignInProgress) {
      console.log('签到正在进行中，跳过此次执行');
      return;
    }

    try {
      this.isSignInProgress = true;
      const userStore = useUserStore();
      const settingStore = useSettingStore();

      if (!settingStore.autoSign || !userStore.isAuthenticated) {
        return;
      }

      // 检查今天是否已签到
      const isSigned = await this.checkTodayIsSigned();

      if (isSigned) {
        console.log('今日已签到，跳过自动签到');
        return;
      }

      console.log('执行自动签到...');
      await youthDayVip();
      await userStore.fetchUserExtends();
      console.log('自动签到成功');

      // 可选：显示通知
      if (window.$message) {
        window.$message.success('自动签到成功');
      }
    } catch (error) {
      console.error('自动签到失败:', error);
    } finally {
      this.isSignInProgress = false;
    }
  }

  // 执行自动领取VIP
  private async performAutoReceiveVip() {
    if (this.isVipInProgress) {
      console.log('VIP领取正在进行中，跳过此次执行');
      return;
    }

    const userStore = useUserStore();

    try {
      this.isVipInProgress = true;

      const settingStore = useSettingStore();

      if (!settingStore.autoReceiveVip || !userStore.isAuthenticated) {
        return;
      }

      if (userStore.isVipReceiveCompleted) {
        console.log('今日VIP已领取完成，跳过自动领取');
        return;
      }

      if (userStore.vipReceiveNextTime && userStore.vipReceiveNextTime > new Date().getTime()) {
        console.log('VIP领取时间未到，跳过自动领取');
        return;
      }

      console.log('执行自动领取VIP...');
      const res = await youthVip();
      userStore.setVipReceive(res);
      await userStore.fetchUserExtends();
      console.log('自动领取VIP成功');

      // 可选：显示通知
      if (window.$message) {
        window.$message.success('自动领取VIP成功');
      }
    } catch (error: any) {
      console.error('自动领取VIP失败:', error);
      if (error?.error_code === 30002) {
        console.error('今天次数已用光');
        userStore.setVipReceiveCompleted();
      }
    } finally {
      this.isVipInProgress = false;
    }
  }

  // 检查今天是否已签到
  private async checkTodayIsSigned(): Promise<boolean> {
    try {
      const monthRecord = await youthMonthVipRecord();
      const today = formatTimestamp(new Date().getTime());

      return monthRecord.list?.some((item: VipMonthRecord) => item.day === today) || false;
    } catch (error) {
      console.error('检查签到状态失败:', error);
      return false;
    }
  }

  // 手动执行签到（供UI调用）
  async manualSign(): Promise<void> {
    const userStore = useUserStore();

    if (!userStore.isAuthenticated) {
      throw new Error('用户未登录');
    }

    const isSigned = await this.checkTodayIsSigned();
    if (isSigned) {
      throw new Error('今日已签到');
    }

    await youthDayVip();
    await userStore.fetchUserExtends();
  }

  // 手动领取VIP（供UI调用）
  async manualReceiveVip(): Promise<VipReceive> {
    const userStore = useUserStore();

    if (!userStore.isAuthenticated) {
      throw new Error('用户未登录');
    }

    if (userStore.isVipReceiveCompleted) {
      throw new Error('今日会员已经领取完成');
    }

    if (userStore.vipReceiveNextTime && userStore.vipReceiveNextTime > new Date().getTime()) {
      throw new Error(
        `下一次领取时间为 ${formatTimestamp(userStore.vipReceiveNextTime, 'YYYY-MM-DD HH:mm:ss')} 之后`,
      );
    }

    const res = await youthVip();
    userStore.setVipReceive(res);
    await userStore.fetchUserExtends();

    return res;
  }

  // 获取VIP领取记录（供UI调用）
  async getVipMonthRecord(): Promise<VipMonthRecord[]> {
    const monthRecord = await youthMonthVipRecord();
    return monthRecord.list || [];
  }
}

// 创建单例实例
export const autoSignService = new AutoSignService();

// 导出工具函数
export const signUtils = {
  /**
   * 检查指定日期是否已签到
   */
  async isSigned(year: number, month: number, day: number): Promise<boolean> {
    try {
      const timestamp = new Date(year, month - 1, day).getTime();
      const monthRecord = await youthMonthVipRecord();

      return (
        monthRecord.list?.some((item: VipMonthRecord) => item.day === formatTimestamp(timestamp)) ||
        false
      );
    } catch (error) {
      console.error('检查签到状态失败:', error);
      return false;
    }
  },

  /**
   * 转换为时间戳
   */
  toTimestamp(year: number, month: number, day: number): number {
    return new Date(year, month - 1, day).getTime();
  },
};
