import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 使用更可靠的方法检测生产环境：检查是否是打包后的应用
const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

let serverProcess: ChildProcess | null = null;

let mainWindow: any;
let lyricsWindow: any = null;
let loadingWindow: any = null;

// 创建加载窗口
function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 400,
    height: 500,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    center: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
    show: false,
  });

  const loadingUrl = isDev
    ? `file://${path.join(__dirname, '..', 'loading.html')}`
    : `file://${path.join(__dirname, '../loading.html')}`;

  loadingWindow.loadURL(loadingUrl);

  loadingWindow.once('ready-to-show', () => {
    loadingWindow.show();
  });

  loadingWindow.on('closed', () => {
    loadingWindow = null;
  });

  if (isDev) {
    loadingWindow.webContents.openDevTools();
  }
}

// 创建桌面歌词窗口
function createLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.show();
    lyricsWindow.focus();
    return;
  }

  // 在macOS上确保dock图标保持可见
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  lyricsWindow = new BrowserWindow({
    width: 800,
    height: 200,
    x: Math.round((require('electron').screen.getPrimaryDisplay().workAreaSize.width - 800) / 2),
    y: 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: process.platform !== 'darwin', // 在macOS上不跳过任务栏，避免影响dock
    resizable: true,
    hasShadow: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: false,
    type: 'panel', // 使用panel类型确保在全屏窗口上方
    level: 'screen-saver', // 设置最高层级
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      zoomFactor: 1.0,
      sandbox: false,
      webSecurity: false, // 允许加载本地文件
      allowRunningInsecureContent: true, // 允许运行不安全内容
    },
  });

  // 加载歌词窗口页面
  const lyricsUrl = isDev
    ? 'http://localhost:3000/desktop-lyrics.html'
    : `file://${path.join(__dirname, '../dist/desktop-lyrics.html')}`;

  lyricsWindow.loadURL(lyricsUrl);

  // 设置窗口层级，确保在全屏窗口上方显示
  lyricsWindow.setAlwaysOnTop(true, 'screen-saver');

  // 在macOS上设置额外的层级属性
  if (process.platform === 'darwin') {
    lyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  lyricsWindow.once('ready-to-show', () => {
    lyricsWindow.show();
    lyricsWindow.webContents.send('lyrics-window-created');
  });

  lyricsWindow.on('closed', () => {
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
}

// 启动服务器
async function startServer() {
  if (isDev) {
    // 开发环境 - 假设服务器已经在外部启动
    console.log('开发环境：服务器应在 http://localhost:10086 启动');
    // 通知加载窗口服务器已准备就绪
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.webContents.send('loading-progress', { step: 1, progress: 50 });
      setTimeout(() => {
        loadingWindow.webContents.send('server-ready');
      }, 1000);
    }
    return;
  }

  // 生产环境 - 启动打包后的服务器
  try {
    console.log('正在启动音乐服务...');

    // 通知加载窗口开始启动服务器
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.webContents.send('loading-progress', { step: 1, progress: 20 });
    }

    // 安全地获取工作目录
    let currentWorkingDir = '';
    try {
      currentWorkingDir = process.cwd();
    } catch {
      currentWorkingDir = process.resourcesPath || __dirname;
    }

    // 在打包后的应用中，使用预编译的二进制服务器
    let serverPath: string;

    if (app.isPackaged) {
      // 打包环境：使用二进制文件，无需Node.js环境
      serverPath = path.join(process.resourcesPath, 'server', 'bin', 'app_macos');
    } else {
      // 开发环境：使用JS文件需要Node.js
      serverPath = path.join(__dirname, '..', 'server', 'app.js');
    }

    if (!require('fs').existsSync(serverPath)) {
      console.error('❌ 服务器文件不存在:', serverPath);
      return;
    }

    console.log('✅ 启动音乐服务器...');

    // 通知加载窗口服务器文件找到
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.webContents.send('loading-progress', { step: 1, progress: 60 });
    }

    let spawnCommand: string;
    let spawnArgs: string[];

    if (app.isPackaged) {
      // 生产环境：直接运行二进制文件，无需Node.js
      spawnCommand = serverPath;
      spawnArgs = [];
    } else {
      // 开发环境：使用Node.js运行JS文件
      const { execSync } = require('child_process');
      try {
        spawnCommand = execSync('which node', { encoding: 'utf8' }).trim();
      } catch {
        spawnCommand = 'node';
      }
      spawnArgs = [serverPath];
    }

    // 设置.env文件路径，让服务器能够读取配置
    let envPath = '';
    if (app.isPackaged) {
      envPath = path.join(process.resourcesPath, 'server', '.env');
    }

    serverProcess = spawn(spawnCommand, spawnArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: '10086',
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        platform: 'lite', // 酷狗概念版
        CORS_ALLOW_ORIGIN: '*',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        // 如果.env文件存在，设置路径让应用能找到
        ...(envPath && require('fs').existsSync(envPath) ? { DOTENV_CONFIG_PATH: envPath } : {}),
      },
      cwd: app.isPackaged ? path.dirname(envPath || process.resourcesPath) : currentWorkingDir,
    });

    // 监听服务器输出
    if (serverProcess.stdout) {
      serverProcess.stdout.on('data', () => {
        // 通知加载窗口服务器正在启动
        if (loadingWindow && !loadingWindow.isDestroyed()) {
          loadingWindow.webContents.send('loading-progress', { step: 1, progress: 80 });
        }
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on('data', data => {
        console.error('服务器错误:', data.toString());
      });
    }

    serverProcess.on('error', err => {
      console.error('❌ 服务器启动失败:', err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`⚠️ 服务器进程退出 - 代码: ${code}, 信号: ${signal}`);
      serverProcess = null;
    });

    console.log('✅ 音乐服务已启动，PID:', serverProcess.pid);

    // 等待服务器完全启动
    await waitForServer();
  } catch (error) {
    console.error('❌ 启动服务器时出错:', error);
  }
}

// 等待服务器启动完成
async function waitForServer() {
  const maxRetries = 30; // 最多等待30秒
  let retries = 0;

  // 通知加载窗口开始检查服务器状态
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send('loading-progress', { step: 2, progress: 85 });
  }

  while (retries < maxRetries) {
    try {
      await fetch('http://localhost:10086/');
      console.log('✅ 音乐服务已就绪');

      // 通知加载窗口服务器已准备就绪
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.webContents.send('server-ready');
      }
      return;
    } catch {
      retries++;
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 更新进度
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        const progress = 85 + (retries / maxRetries) * 10;
        loadingWindow.webContents.send('loading-progress', { step: 2, progress });
      }
    }
  }

  console.error('❌ 服务器启动超时');
  // 即使超时也显示主窗口
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send('server-ready');
  }
}

function createWindow() {
  const windowOptions = {
    minWidth: 1080,
    width: 1080,
    minHeight: 768,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // 允许加载本地文件
      allowRunningInsecureContent: true, // 允许运行不安全内容
    },
    show: false,
    // remove the default titlebar
    titleBarStyle: 'hidden',
    // expose window controls in Windows/Linux
    ...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {}),
  } as any;

  mainWindow = new BrowserWindow(windowOptions);

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  // 配置 webRequest 拦截器处理跨域
  const session = mainWindow.webContents.session;
  session.webRequest.onHeadersReceived(
    (details: { responseHeaders: any }, callback: (arg0: { responseHeaders: any }) => void) => {
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
    },
  );

  mainWindow.loadURL(startUrl);

  mainWindow.webContents.on(
    'did-fail-load',
    (event: any, errorCode: any, errorDescription: any) => {
      console.error('Failed to load:', errorDescription);
    },
  );

  mainWindow.webContents.on('did-frame-finish-load', () => {
    // 页面加载完成
  });

  mainWindow.once('ready-to-show', () => {
    // 不立即显示主窗口，等待服务器启动完成
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 监听窗口关闭事件
  mainWindow.on('close', (event: any) => {
    // 检查是否是应用完全退出，如果不是则隐藏窗口
    if (!app.isQuitting && !mainWindow?.isDestroyed()) {
      event.preventDefault();
      if (process.platform === 'darwin') {
        // 在macOS上，保持dock图标显示
        mainWindow.hide();
        // 确保dock图标保持可见
        if (app.dock) {
          app.dock.show();
        }
      } else {
        mainWindow.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 在macOS上确保dock图标可见
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  // 先创建加载窗口
  createLoadingWindow();

  // 先创建主窗口（但不显示）
  createWindow();

  // 启动服务器
  if (!isDev) {
    await startServer();
  } else {
    // 开发环境也启动服务器检查
    await startServer();
  }

  // IPC 处理程序 - 加载完成，显示主窗口
  ipcMain.on('loading-complete', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    // 关闭加载窗口
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.close();
    }
  });

  // IPC 处理程序 - 防止系统休眠
  ipcMain.on('prevent-sleep', (event: any) => {
    const id = powerSaveBlocker.start('prevent-display-sleep');
    event.returnValue = id;
  });

  // IPC 处理程序 - 允许系统休眠
  ipcMain.on('allow-sleep', (_event: any, id: number) => {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
  });

  // IPC 处理程序 - 创建桌面歌词窗口
  ipcMain.on('create-lyrics-window', () => {
    createLyricsWindow();
  });

  // IPC 处理程序 - 关闭桌面歌词窗口
  ipcMain.on('close-lyrics-window', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.close();
    }
  });

  // IPC 处理程序 - 歌词数据更新
  ipcMain.on('lyrics-data-update', (_event: any, data: any) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('lyrics-data-update', data);
    }
  });

  // IPC 处理程序 - 歌词窗口控制事件
  ipcMain.on('lyrics-control', (_event: any, action: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-control', action);
    }
  });

  // IPC 处理程序 - 歌词窗口准备就绪
  ipcMain.on('lyrics-window-ready', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-window-created');
      // 请求主窗口发送当前歌曲信息
      mainWindow.webContents.send('request-current-song-info');
    }
  });

  // IPC 处理程序 - 播放歌曲变化
  ipcMain.on('play-song-change', (_event: any, title: any) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('play-song-change', title);
    }
  });

  // IPC 处理程序 - 播放状态变化
  ipcMain.on('play-status-change', (_event: any, status: any) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('play-status-change', status);
    }
  });

  // IPC 处理程序 - 桌面歌词选项变化
  ipcMain.on('desktop-lyric-option-change', (_event: any, options: any) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('desktop-lyric-option-change', options);
    }
  });

  // IPC 处理程序 - 切换桌面歌词锁定状态
  ipcMain.on('toggleDesktopLyricLock', (_event: any, lock: boolean) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('toggleDesktopLyricLock', lock);
    }
  });

  // IPC 处理程序 - 关闭桌面歌词
  ipcMain.on('closeDesktopLyric', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.close();
    }
  });

  // IPC 处理程序 - 显示应用主窗口
  ipcMain.on('win-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // IPC 处理程序 - 发送主窗口事件
  ipcMain.on('send-main-event', (_event: any, action: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player-control', action);
    }
  });

  // IPC 处理程序 - 获取桌面歌词选项
  ipcMain.handle('get-desktop-lyric-option', () => {
    // 返回默认选项，可以从配置文件读取
    return {
      fontSize: 30,
      mainColor: '#333333', // 改为深色文字，适合浅色背景
      shadowColor: 'rgba(255, 255, 255, 0.8)', // 白色阴影适合浅色背景
    };
  });

  // IPC 处理程序 - 设置桌面歌词选项
  ipcMain.on('set-desktop-lyric-option', (_event: any, options: any) => {
    console.log('[Main] 设置桌面歌词选项:', options);
    // 这里可以保存选项到配置文件
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.webContents.send('desktop-lyric-option-change', options);
    }
  });

  // IPC 处理程序 - 获取窗口边界
  ipcMain.handle('get-window-bounds', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      return lyricsWindow.getBounds();
    }
    return { x: 0, y: 0, width: 800, height: 200 };
  });

  // IPC 处理程序 - 获取屏幕尺寸
  ipcMain.handle('get-screen-size', () => {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
      width: primaryDisplay.workAreaSize.width,
      height: primaryDisplay.workAreaSize.height,
    };
  });

  // IPC 处理程序 - 更新窗口高度
  ipcMain.on('update-window-height', (_event: any, height: number) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      const bounds = lyricsWindow.getBounds();
      lyricsWindow.setBounds({ ...bounds, height: Math.max(100, height + 20) });
    }
  });

  // IPC 处理程序 - 移动窗口
  ipcMain.on('move-window', (_event: any, x: number, y: number, width: number, height: number) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setBounds({ x, y, width, height });
    }
  });

  // IPC 处理程序 - 设置窗口位置
  ipcMain.handle('set-window-position', (_event: any, position: { x: number; y: number }) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setPosition(position.x, position.y);
      return true;
    }
    return false;
  });

  // IPC 处理程序 - 设置窗口大小
  ipcMain.handle('set-window-size', (_event: any, size: { width: number; height: number }) => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setSize(size.width, size.height);
      return true;
    }
    return false;
  });
});

app.on('window-all-closed', () => {
  // 在 macOS 上，应用和菜单栏通常会保持活动状态
  // 直到用户明确使用 Cmd + Q 退出
  if (process.platform !== 'darwin') {
    // 关闭服务器进程
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      serverProcess = null;
    }
    app.quit();
  }
});

app.on('activate', () => {
  // 在 macOS 上点击 dock 图标时重新显示窗口
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

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
  // 设置退出标志，允许窗口正常关闭
  (app as any).isQuitting = true;

  // 确保歌词窗口被关闭
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.close();
    lyricsWindow = null;
  }
  // 确保服务器进程被关闭
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
