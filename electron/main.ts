import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
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
});

app.on('window-all-closed', () => {
  // 关闭服务器进程
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // 确保服务器进程被关闭
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
