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
  mainWindow.on('close', (event) => {
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
  ipcMain.on('prevent-sleep', (event) => {
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

  // 只有在获得锁的情况下才创建窗口
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
    ipcMain.on('prevent-sleep', (event) => {
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
  });
}

// 处理应用退出
app.on('before-quit', () => {
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

app.on('before-quit', () => {
  // 确保服务器进程被关闭
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
