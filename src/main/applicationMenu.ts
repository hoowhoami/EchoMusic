import { app, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { getDevToolsEnabledSetting } from './storage/settings';

const isMac = process.platform === 'darwin';
const appDisplayName = 'EchoMusic';

interface ApplicationMenuOptions {
  openSettings?: () => void | Promise<void>;
}

const buildMacApplicationMenu = (options: ApplicationMenuOptions = {}) => {
  const template: MenuItemConstructorOptions[] = [
    {
      label: appDisplayName,
      submenu: [
        { role: 'about', label: `关于 ${appDisplayName}` },
        {
          label: '偏好设置…',
          accelerator: 'Command+,',
          click: () => {
            void options.openSettings?.();
          },
        },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appDisplayName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appDisplayName}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置所有窗口' },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
};

export const configureApplicationMenu = (options: ApplicationMenuOptions = {}) => {
  app.setName(appDisplayName);

  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(buildMacApplicationMenu(options));
};

export const configureWebContentsShortcuts = (
  webContents: WebContents,
  options: ApplicationMenuOptions = {},
) => {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const key = input.key.toLowerCase();
    const isSettingsShortcut = (input.control || input.meta) && key === ',';
    const isDevToolsShortcut =
      key === 'f12' ||
      ((input.control || input.meta) && input.shift && key === 'i') ||
      (input.meta && input.alt && key === 'i');

    if (!isMac && isSettingsShortcut) {
      event.preventDefault();
      void options.openSettings?.();
      return;
    }

    if (isDevToolsShortcut && getDevToolsEnabledSetting()) {
      event.preventDefault();
      webContents.toggleDevTools();
    }
  });
};
