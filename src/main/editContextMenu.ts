import {
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

// 右键菜单事件参数中与本模块相关的子集（完整类型为 Electron 的 ContextMenuParams）
interface EditMenuParams {
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

// 构造输入框编辑菜单模板。动作通过闭包显式指向目标 webContents（比 role 更稳，
// 不受弹出时焦点转移影响，可覆盖 iframe），enabled 依据事件携带的 editFlags 与剪贴板内容。
export const buildEditContextMenuTemplate = (
  contents: WebContents,
  params: EditMenuParams,
  clipboardText: string,
): MenuItemConstructorOptions[] => {
  // 标签与 mac 应用菜单的编辑项（applicationMenu.ts）保持一致
  return [
    { label: '剪切', enabled: params.editFlags.canCut, click: () => contents.cut() },
    { label: '复制', enabled: params.editFlags.canCopy, click: () => contents.copy() },
    {
      label: '粘贴',
      // canPaste 只反映目标可粘贴，还需剪贴板确有文本才视为可用
      enabled: params.editFlags.canPaste && clipboardText.length > 0,
      click: () => contents.paste(),
    },
    { type: 'separator' },
    { label: '全选', enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
  ];
};

// 为窗口/iframe 的 webContents 挂接输入框右键编辑菜单。
// Windows/Linux 下应用菜单为 null（applicationMenu.ts），此处是唯一的原生编辑入口。
export const configureEditContextMenu = (webContents: WebContents) => {
  webContents.on('context-menu', (_event, params) => {
    // DevTools 有自己的菜单，其输入框不应被本菜单接管；
    // 监听挂在 web-contents-created 时 URL 还是空的，必须事件时判断
    if (webContents.getURL().startsWith('devtools://')) return;
    // 仅文本输入目标弹出；其余区域维持现状（歌曲列表右键由渲染层 SongList 自行处理）
    if (!params.isEditable) return;

    const template = buildEditContextMenuTemplate(webContents, params, clipboard.readText());
    // 不传 x/y，默认在鼠标光标位置弹出（对 iframe 坐标也天然正确）
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(webContents) ?? undefined,
    });
  });
};
