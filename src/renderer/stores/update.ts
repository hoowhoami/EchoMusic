import { defineStore } from 'pinia';
import type {
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateDownloadStatus,
} from '../../shared/app';
import { useSettingStore } from './setting';

/**
 * 更新状态的单一可信来源（single source of truth）。
 *
 * 应用内只保留一个 UpdateDialog 实例（挂载在 App.vue），所有检查/下载状态
 * 都收敛到这里：启动时静默检查、设置页手动检查共用同一份状态，避免出现
 * 重复下载、状态不同步、再次检查不弹窗等问题。
 */
export const useUpdateStore = defineStore('update', {
  state: () => ({
    checkResult: null as UpdateCheckResult | null,
    downloadStatus: 'idle' as UpdateDownloadStatus,
    downloadPercent: 0,
    downloadError: '',
    isChecking: false,
    dialogOpen: false,
    initialized: false,
    disposeDownload: null as null | (() => void),
    checkResultListener: null as null | ((payload: unknown) => void),
  }),
  actions: {
    /** 注册 IPC 监听并从主进程拉取当前状态（恢复进度）。幂等。 */
    async init() {
      if (this.initialized) return;
      this.initialized = true;

      const listener = (payload: unknown) => this.handleCheckResult(payload);
      this.checkResultListener = listener;
      window.electron?.ipcRenderer?.on('update-check-result', listener);

      this.disposeDownload =
        window.electron?.updater?.onDownloadStatus((result) => {
          this.applyDownloadStatus(result);
        }) ?? null;

      try {
        const state = await window.electron?.updater?.getState?.();
        if (state) {
          if (state.checkResult) this.checkResult = state.checkResult;
          if (state.download) this.applyDownloadStatus(state.download);
        }
      } catch {
        // 主进程暂不可用时忽略，后续事件会补齐状态
      }
    },

    dispose() {
      if (this.checkResultListener) {
        window.electron?.ipcRenderer?.off('update-check-result', this.checkResultListener);
        this.checkResultListener = null;
      }
      this.disposeDownload?.();
      this.disposeDownload = null;
      this.initialized = false;
    },

    handleCheckResult(payload: unknown) {
      this.isChecking = false;

      const silent = Boolean(
        payload && typeof payload === 'object' && Reflect.get(payload, 'silent') === true,
      );

      if (!payload || typeof payload !== 'object') {
        const settingStore = useSettingStore();
        this.checkResult = {
          status: 'error',
          currentVersion: settingStore.appVersion || '未知',
        };
      } else {
        this.checkResult = payload as UpdateCheckResult;
      }

      // 静默检查：仅在有可用更新时弹窗；手动检查：始终弹窗
      if (silent) {
        if (this.checkResult?.status === 'available') this.dialogOpen = true;
      } else {
        this.dialogOpen = true;
      }
    },

    applyDownloadStatus(result: UpdateDownloadResult) {
      this.downloadStatus = result.status;
      if (result.progress) {
        this.downloadPercent = Math.round(result.progress.percent);
      } else if (result.status === 'idle') {
        this.downloadPercent = 0;
      }
      if (result.status === 'error') {
        this.downloadError = result.error || '未知错误';
      } else {
        this.downloadError = '';
      }
    },

    /** 触发检查更新。silent=false 为用户手动检查。 */
    check(silent = false) {
      if (!silent) this.isChecking = true;
      const settingStore = useSettingStore();
      settingStore.checkForUpdates(silent);
    },

    /** 开始下载。下载中/已下载时忽略，防止重复下载。 */
    download() {
      if (this.downloadStatus === 'downloading' || this.downloadStatus === 'downloaded') return;
      this.downloadStatus = 'downloading';
      this.downloadPercent = 0;
      this.downloadError = '';
      window.electron?.updater?.download();
    },

    install() {
      const settingStore = useSettingStore();
      window.electron?.updater?.install(settingStore.silentUpdate);
    },

    openRelease() {
      const url = this.checkResult?.releaseUrl;
      if (!url) return;
      window.electron?.ipcRenderer?.send('open-external', url);
    },

    openDownload() {
      const url = this.checkResult?.downloadUrl || this.checkResult?.releaseUrl;
      if (!url) return;
      window.electron?.ipcRenderer?.send('open-external', url);
    },

    /** 关闭弹窗仅隐藏，不取消下载、不清空状态，便于稍后重新打开查看进度。 */
    closeDialog() {
      this.dialogOpen = false;
    },
  },
});
