import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.NODE_ENV !== 'production';

let serverProcess: ChildProcess | null = null;

let mainWindow: any;
let lyricsWindow: any = null;

// 创建桌面歌词窗口
function createLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.show();
    lyricsWindow.focus();
    return;
  }

  lyricsWindow = new BrowserWindow({
    width: 800,
    height: 200,
    x: Math.round((require('electron').screen.getPrimaryDisplay().workAreaSize.width - 800) / 2),
    y: 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      zoomFactor: 1.0,
      sandbox: false,
    },
  });

  // 加载歌词窗口页面
  const lyricsUrl = isDev
    ? 'http://localhost:3000/desktop-lyrics.html'
    : `file://${path.join(__dirname, '../dist/public/desktop-lyrics.html')}`;

  lyricsWindow.loadURL(lyricsUrl);

  lyricsWindow.once('ready-to-show', () => {
    console.log('[Main] 歌词窗口准备完成，开始显示');
    lyricsWindow.show();
    lyricsWindow.webContents.send('lyrics-window-created');
  });

  lyricsWindow.on('closed', () => {
    console.log('[Main] 歌词窗口已关闭');
    lyricsWindow = null;
    // 通知渲染进程窗口已关闭
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-window-closed');
    }
  });

  // 开发模式下打开开发者工具
  if (isDev) {
    lyricsWindow.webContents.openDevTools();
  }

  console.log('[Main] 歌词窗口创建完成');
}

// 启动服务器
function startServer() {
  if (isDev) {
    // 开发环境 - 假设服务器已经在外部启动
    console.log('开发环境：请确保服务器已在 http://localhost:10086 启动');
    return;
  }

  // 生产环境 - 启动打包后的服务器
  try {
    const serverPath = path.join(__dirname, '../server/bin/api_js/app.js');
    console.log('启动服务器:', serverPath);

    serverProcess = spawn('node', [serverPath], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '10086', HOST: '0.0.0.0' },
    });

    serverProcess.on('error', err => {
      console.error('服务器启动失败:', err);
    });

    serverProcess.on('exit', code => {
      console.log(`服务器进程退出，代码: ${code}`);
      serverProcess = null;
    });
  } catch (error) {
    console.error('启动服务器时出错:', error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    minWidth: 1000,
    width: 1000,
    minHeight: 700,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
    // remove the default titlebar
    titleBarStyle: 'hidden',
    // expose window controls in Windows/Linux
    ...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {}),
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  // 配置 webRequest 拦截器处理跨域
  const session = mainWindow.webContents.session;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // 允许所有来源跨域访问
        'Access-Control-Allow-Origin': ['*'],
        // 允许的请求方法
        'Access-Control-Allow-Methods': ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        // 允许的请求头
        'Access-Control-Allow-Headers': ['Content-Type', 'Authorization'],
      },
    });
  });

  mainWindow.loadURL(startUrl);

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorDescription);
  });

  mainWindow.webContents.on('did-frame-finish-load', () => {
    console.log('Page loaded successfully');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 监听窗口关闭事件，隐藏而不是关闭
  mainWindow.on('close', event => {
    if (!mainWindow?.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 先启动服务器
  if (!isDev) {
    console.log('启动API服务器...');
    startServer();
    // 等待服务器启动
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  createWindow();

  // IPC 处理程序 - 防止系统休眠
  ipcMain.on('prevent-sleep', event => {
    const id = powerSaveBlocker.start('prevent-display-sleep');
    console.log('Prevented system sleep with ID:', id);
    event.returnValue = id;
  });

  // IPC 处理程序 - 允许系统休眠
  ipcMain.on('allow-sleep', (event, id) => {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
      console.log('Allowed system sleep for ID:', id);
    }
  });

  // IPC 处理程序 - 创建桌面歌词窗口
  ipcMain.on('create-lyrics-window', () => {
    console.log('[Main] 收到创建歌词窗口请求');
    createLyricsWindow();
  });

  // IPC 处理程序 - 关闭桌面歌词窗口
  ipcMain.on('close-lyrics-window', () => {
    console.log('[Main] 收到关闭歌词窗口请求');
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.close();
    }
  });

  // IPC 处理程序 - 歌词数据更新
  ipcMain.on('lyrics-data-update', (event, data) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('lyrics-data-update', data);
    }
  });

  // IPC 处理程序 - 歌词窗口控制事件
  ipcMain.on('lyrics-control', (event, action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-control', action);
    }
  });

  // IPC 处理程序 - 歌词窗口准备就绪
  ipcMain.on('lyrics-window-ready', () => {
    console.log('[Main] 歌词窗口渲染完成，发送创建完成事件');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-window-created');
    }
  });

  // IPC 处理程序 - 窗口拖动相关
  let initialWindowPosition = { x: 0, y: 0 };

  ipcMain.on('start-window-drag', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      const bounds = lyricsWindow.getBounds();
      initialWindowPosition = { x: bounds.x, y: bounds.y };
    }
  });

  ipcMain.on('move-window', (event, { deltaX, deltaY }) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      const newX = initialWindowPosition.x + deltaX;
      const newY = initialWindowPosition.y + deltaY;
      lyricsWindow.setPosition(newX, newY);
    }
  });

  ipcMain.on('end-window-drag', () => {
    // 拖动结束，可以在这里保存位置等
  });
});

app.on('window-all-closed', () => {
  // 在 macOS 上，应用和菜单栏通常会保持活动状态
  // 直到用户明确使用 Cmd + Q 退出
  if (process.platform !== 'darwin') {
    // 关闭服务器进程
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
    app.quit();
  }
});

app.on('activate', () => {
  // 在 macOS 上点击 dock 图标时重新显示窗口
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 添加单例应用支持
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 如果已经有实例在运行，则退出当前实例
  app.quit();
} else {
  app.on('second-instance', () => {
    // 当有第二个实例启动时，显示主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 处理应用退出
app.on('before-quit', () => {
  // 确保歌词窗口被关闭
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.close();
    lyricsWindow = null;
  }
  // 确保服务器进程被关闭
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

// 在 macOS 上，当 dock 图标被点击时显示窗口
if (process.platform === 'darwin') {
  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
