// 检查是否在 Electron 环境中
const isElectron = typeof window !== 'undefined' && window.require;

let powerSaveBlockerId: number | null = null;

/**
 * Prevent system sleep
 */
export const preventSystemSleep = () => {
  if (powerSaveBlockerId === null && isElectron) {
    const { ipcRenderer } = window.require('electron');
    powerSaveBlockerId = ipcRenderer.sendSync('prevent-sleep');
    console.log('System sleep prevented, ID:', powerSaveBlockerId);
  }
  return powerSaveBlockerId;
};

/**
 * Allow system sleep
 */
export const allowSystemSleep = () => {
  if (powerSaveBlockerId !== null && isElectron) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.send('allow-sleep', powerSaveBlockerId);
    console.log('System sleep allowed, ID:', powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
};

/**
 * Check if currently preventing system sleep
 */
export const isPreventingSleep = () => {
  return powerSaveBlockerId !== null;
};
