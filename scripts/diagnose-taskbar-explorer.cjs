// Windows-only, isolated probe. Run with Node so the supervisor survives Electron.
// Does not restart Explorer, read EchoMusic settings, or suppress shutdown messages.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const mode = option('mode', 'embedded');
const help = `Windows taskbar / Explorer probe:
  node scripts/diagnose-taskbar-explorer.cjs --mode=embedded
  node scripts/diagnose-taskbar-explorer.cjs --mode=unembedded
Optional: --electron=<electron.exe> --addon=<echo-platform-adaptor.node>
  --inject-end-session sends WM_ENDSESSION only to the probe lyric HWND;
  it does not restart Explorer or end the Windows session.
For a real restart, use Task Manager to restart Windows Explorer manually.
Close the probe's main window to finish a surviving run.`;

if (process.argv.includes('--help')) {
  console.log(help);
} else if (process.platform !== 'win32') {
  console.error('This probe requires a Windows desktop.\n' + help);
  process.exitCode = 1;
} else if (!['embedded', 'unembedded'].includes(mode)) {
  console.error('mode must be embedded or unembedded');
  process.exitCode = 1;
} else if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-taskbar-explorer-'));
  const executable = option('electron', require('electron'));
  const environment = { ...process.env, ECHO_TASKBAR_PROBE_DIRECTORY: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  console.log(`Diagnostic files: ${directory}\n${help}`);
  const child = spawn(executable, [__filename, ...process.argv.slice(2)], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, filename, output] of [
    [child.stdout, 'stdout.log', process.stdout],
    [child.stderr, 'stderr.log', process.stderr],
  ]) {
    stream.on('data', (chunk) => {
      fs.appendFileSync(path.join(directory, filename), chunk);
      output.write(chunk);
    });
  }
  child.on('error', (error) => {
    fs.writeFileSync(path.join(directory, 'launch-error.txt'), error.stack ?? String(error));
    console.error(error);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    const result = {
      executable,
      mode,
      code,
      hexCode: code === null ? null : `0x${(code >>> 0).toString(16)}`,
      signal,
      time: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(directory, 'exit.json'), JSON.stringify(result, null, 2));
    console.log(`Probe exited: ${JSON.stringify(result)}\nDiagnostic files: ${directory}`);
    process.exitCode = code === 0 ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, screen, crashReporter } = require('electron');
  const directory = process.env.ECHO_TASKBAR_PROBE_DIRECTORY;
  if (!directory) throw new Error('Launch this probe with Node, not directly with Electron.');
  fs.mkdirSync(path.join(directory, 'dumps'));
  fs.mkdirSync(path.join(directory, 'user-data'));
  app.setPath('userData', path.join(directory, 'user-data'));
  app.setPath('crashDumps', path.join(directory, 'dumps'));
  crashReporter.start({ uploadToServer: false });
  const record = (event, details = {}) => {
    // Electron may TerminateCurrentProcessImmediately inside the current WndProc.
    fs.appendFileSync(
      path.join(directory, 'events.jsonl'),
      JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n',
    );
  };
  const pointer = (buffer) =>
    buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
  const inspect = (window, name, onDestroy = () => {}) => {
    const hwnd = pointer(window.getNativeWindowHandle()).toString();
    record('window-created', { name, hwnd });
    for (const [message, label] of [
      [0x0010, 'WM_CLOSE'],
      [0x0011, 'WM_QUERYENDSESSION'],
      [0x0016, 'WM_ENDSESSION'],
      [0x0002, 'WM_DESTROY'],
      [0x0082, 'WM_NCDESTROY'],
    ]) {
      window.hookWindowMessage(message, (wParam, lParam) => {
        if (message === 0x0002) onDestroy();
        record(label, {
          name,
          hwnd,
          wParam: `0x${pointer(wParam).toString(16)}`,
          lParam: `0x${pointer(lParam).toString(16)}`,
        });
      });
    }
    for (const event of ['query-session-end', 'session-end', 'close', 'closed']) {
      window.on(event, (details) => record(event, { name, reasons: details?.reasons }));
    }
    window.webContents.on('render-process-gone', (_, details) =>
      record('render-process-gone', { name, details }),
    );
    return hwnd;
  };
  record('start', { mode, versions: process.versions, os: os.release(), pid: process.pid });
  for (const event of ['before-quit', 'will-quit', 'quit', 'window-all-closed']) {
    app.on(event, () => record(event));
  }
  app.on('child-process-gone', (_, details) => record('child-process-gone', { details }));
  process.on('uncaughtException', (error) => {
    record('uncaughtException', { stack: error.stack });
    app.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    record('unhandledRejection', { stack: error?.stack ?? String(error) });
    app.exit(1);
  });
  let session;
  let injected = false;
  const inject = (hwnd) => {
    if (injected || !process.argv.includes('--inject-end-session')) return;
    injected = true;
    record('synthetic-end-session', { hwnd, wParam: '0x1', lParam: '0x1' });
    // Fixed code and a decimal HWND generated locally; no shell interpolation.
    const code = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
      public class ProbeMessages { [DllImport("user32.dll")] public static extern
      IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l); }';
      [ProbeMessages]::SendMessageW([IntPtr]::new(${hwnd}), 0x16, [IntPtr]::new(1), [IntPtr]::new(1))`;
    const sender = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code]);
    sender.on('error', (error) => record('injection-error', { message: error.message }));
    sender.stderr.on('data', (data) => record('injection-stderr', { message: data.toString() }));
    sender.on('close', (code) => record('injection-exit', { code }));
  };
  app.on('before-quit', () => session?.stop());
  app
    .whenReady()
    .then(async () => {
      const main = new BrowserWindow({ width: 620, height: 260 });
      inspect(main, 'main');
      main.on('closed', () => app.quit());
      await main.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<meta charset="utf-8"><h2>EchoMusic taskbar probe: ${mode}</h2>
       <p>在任务管理器中重启 Windows 资源管理器。存活时，关闭此窗口结束记录。</p>
       <p>诊断文件：${directory.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`,
        )}`,
      );
      const lyric = new BrowserWindow({
        width: Math.max(screen.getPrimaryDisplay().bounds.width, 800),
        height: 200,
        minWidth: 0,
        minHeight: 0,
        title: 'EchoMusic taskbar probe',
        type: 'toolbar',
        frame: false,
        thickFrame: false,
        transparent: true,
        backgroundColor: '#00000000',
        show: false,
        resizable: false,
        movable: false,
        hasShadow: false,
        skipTaskbar: true,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        webPreferences: { sandbox: false, backgroundThrottling: true, zoomFactor: 1 },
      });
      let destroyed = false;
      const hwnd = inspect(lyric, 'lyric', () => {
        destroyed = true;
      });
      lyric.on('closed', () => session?.stop());
      const ready = new Promise((resolve) => {
        lyric.once('ready-to-show', resolve);
        lyric.once('closed', resolve);
      });
      await lyric.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          '<style>body{margin:0;color:white;background:#303030;font:14px sans-serif}</style>任务栏歌词诊断',
        )}`,
      );
      await ready;
      if (destroyed || lyric.isDestroyed()) return;
      if (mode === 'unembedded') {
        lyric.setBounds({ x: 0, y: 100, width: 240, height: 48 });
        lyric.showInactive();
        record('ready', { hwnd, embedded: false });
        inject(hwnd);
      } else {
        const addonPath = path.resolve(
          option(
            'addon',
            path.join(__dirname, '../native/echo-platform-adaptor/echo-platform-adaptor.node'),
          ),
        );
        record('addon', { addonPath });
        const native = require(addonPath);
        session = new native.TaskbarLyricSession(hwnd, 240, (layout) => {
          record('layout', { layout });
          if (destroyed || lyric.isDestroyed()) return;
          const area = layout.right.width >= 240 ? layout.right : layout.left;
          if (!layout.available || area.width < 240) return lyric.hide();
          const scale = layout.scaleFactor;
          lyric.setBounds({
            x: Math.round(area.x / scale),
            y: Math.round(area.y / scale),
            width: Math.round(240 / scale),
            height: Math.round(area.height / scale),
          });
          lyric.showInactive();
          record('ready', { hwnd, embedded: true });
          inject(hwnd);
        });
      }
    })
    .catch((error) => {
      record('setup-error', { stack: error.stack });
      session?.stop();
      app.exit(1);
    });
}
