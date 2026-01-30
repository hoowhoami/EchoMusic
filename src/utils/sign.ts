import { useUserStore, useSettingStore } from '@/store';
import { youthDayVip, youthMonthVipRecord, youthDayVipUpgrade } from '@/api';
import { formatTimestamp } from '@/utils';

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

    // 每小时检查一次（与TVIP保持一致）
    this.vipIntervalId = window.setInterval(
      () => {
        this.performAutoReceiveVip();
      },
      60 * 60 * 1000,
    );
  }

  // 执行自动签到
  private async performAutoSign() {
    if (this.isSignInProgress) {
      console.log('TVIP领取正在进行中，跳过此次执行');
      return;
    }

    try {
      this.isSignInProgress = true;
      const userStore = useUserStore();
      const settingStore = useSettingStore();

      if (!settingStore.autoSign || !userStore.isAuthenticated) {
        return;
      }

      // 检查今天是否已领取TVIP
      const isSigned = await this.checkTodayIsSigned();

      if (isSigned) {
        console.log('今日TVIP已领取，跳过自动领取');
        // 更新状态
        if (userStore.vipReceive) {
          userStore.setVipReceive({
            ...userStore.vipReceive,
            tvipClaimed: true,
          });
        }
        return;
      }

      console.log('执行自动领取TVIP...');
      let receive_day = formatTimestamp(new Date().getTime());
      await youthDayVip(receive_day);

      // 更新状态
      userStore.setVipReceive({
        day: new Date().getTime(),
        tvipClaimed: true,
        svipClaimed: userStore.vipReceive?.svipClaimed || false,
      });

      await userStore.fetchUserExtends();
      console.log('自动领取TVIP成功');

      // 可选：显示通知
      if (window.$message) {
        window.$message.success('自动领取畅听VIP成功');
      }
    } catch (error) {
      console.error('自动领取TVIP失败:', error);
    } finally {
      this.isSignInProgress = false;
    }
  }

  // 执行自动领取VIP（升级至SVIP）
  private async performAutoReceiveVip() {
    if (this.isVipInProgress) {
      console.log('SVIP升级正在进行中，跳过此次执行');
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
        console.log('今日VIP已全部领取完成，跳过自动升级');
        return;
      }

      // 检查SVIP是否已升级
      if (userStore.isSvipClaimedToday) {
        console.log('今日SVIP已升级，跳过自动升级');
        return;
      }

      // 检查TVIP是否已领取
      const tvipClaimed = await this.checkTvipClaimedToday();
      if (!tvipClaimed) {
        console.log('TVIP未领取，无法升级SVIP');
        // 如果自动签到开启，尝试先领取TVIP
        if (settingStore.autoSign) {
          console.log('尝试先自动领取TVIP...');
          await this.performAutoSign();
          // 等待2秒让API处理完成
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          return;
        }
      }

      console.log('执行自动升级SVIP...');
      await youthDayVipUpgrade();

      // 更新状态
      userStore.setVipReceive({
        day: new Date().getTime(),
        tvipClaimed: true,
        svipClaimed: true,
      });

      await userStore.fetchUserExtends();
      console.log('自动升级SVIP成功');

      // 可选：显示通知
      if (window.$message) {
        window.$message.success('自动升级概念VIP成功');
      }
    } catch (error: any) {
      console.error('自动升级SVIP失败:', error);
    } finally {
      this.isVipInProgress = false;
    }
  }

  // 检查今天是否已领取TVIP
  private async checkTvipClaimedToday(): Promise<boolean> {
    try {
      const monthRecord = await youthMonthVipRecord();
      const today = formatTimestamp(new Date().getTime());

      return monthRecord.list?.some((item: VipMonthRecord) => item.day === today) || false;
    } catch (error) {
      console.error('检查TVIP状态失败:', error);
      return false;
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
      throw new Error('今日已领取畅听VIP');
    }
    let receive_day = formatTimestamp(new Date().getTime());
    await youthDayVip(receive_day);

    // 更新状态
    userStore.setVipReceive({
      day: new Date().getTime(),
      tvipClaimed: true,
      svipClaimed: userStore.vipReceive?.svipClaimed || false,
    });

    await userStore.fetchUserExtends();
  }

  // 手动领取VIP（供UI调用）- 升级至SVIP
  async manualReceiveVip(): Promise<void> {
    const userStore = useUserStore();

    if (!userStore.isAuthenticated) {
      throw new Error('用户未登录');
    }

    if (userStore.isVipReceiveCompleted) {
      throw new Error('今日会员已经全部领取完成');
    }

    // 检查TVIP是否已领取
    const tvipClaimed = await this.checkTvipClaimedToday();
    if (!tvipClaimed) {
      throw new Error('请先领取畅听VIP');
    }

    // 检查SVIP是否已升级
    if (userStore.isSvipClaimedToday) {
      throw new Error('今日概念VIP已升级');
    }

    await youthDayVipUpgrade();

    // 更新状态
    userStore.setVipReceive({
      day: new Date().getTime(),
      tvipClaimed: true,
      svipClaimed: true,
    });

    await userStore.fetchUserExtends();
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
