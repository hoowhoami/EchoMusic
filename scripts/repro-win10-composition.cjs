// Run with Electron, not Node. This experiment does not read EchoMusic settings.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

if (process.platform !== 'win32') {
  console.error('This reproduction requires a Windows desktop.');
  app.exit(1);
} else {
  app.whenReady().then(async () => {
    const addonArg = process.argv.find((arg) => arg.startsWith('--addon='));
    const addonPath = addonArg
      ? path.resolve(addonArg.slice('--addon='.length))
      : path.resolve(__dirname, '../native/echo-platform-adaptor/echo-platform-adaptor.node');
    const native = require(addonPath);
    console.log({ electron: process.versions.electron, os: os.release(), addonPath });
    for (const transparent of [false, true]) {
      const name = transparent ? 'B: Electron clear (new)' : 'A: opaque bootstrap (old clear / new frost)';
      const win = new BrowserWindow({
        width: 480,
        height: 360,
        x: transparent ? 530 : 30,
        y: 100,
        show: false,
        frame: false,
        thickFrame: true, // Electron overrides this when transparent=true.
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 36 },
        transparent,
        ...(transparent ? {} : { backgroundMaterial: 'acrylic' }),
        backgroundColor: '#00000000',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      const handle = win.getNativeWindowHandle();
      const address = handle.length === 8
        ? handle.readBigUInt64LE().toString()
        : String(handle.readUInt32LE());
      let nativeMode = 0;
      function apply(mode) {
        const ok = mode === -1
          ? nativeMode === 0 || native.setWindowComposition(address, 0)
          : native.setWindowComposition(address, mode);
        if (ok) nativeMode = Math.max(0, mode);
        win.setBackgroundColor(ok && mode !== 0 ? '#00000000' : '#303030');
        win.setTitle(`${name} | mode=${mode}, API=${ok}`);
        console.log({
          name, mode, apiAccepted: ok,
          actual: native.getWindowCompositionDiagnostics?.(address),
          // API results are not a measurement of desktop visibility.
        });
      }
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const modes = { '0': 0, '1': -1, '2': 8, '3': 7, '4': 6 };
        if (Object.hasOwn(modes, input.key)) {
          event.preventDefault();
          apply(modes[input.key]);
        }
      });
      const html = `<!doctype html><meta charset="utf-8"><style>
        html,body { margin:0; background:transparent; color:white; font:16px sans-serif }
        header { height:36px; app-region:drag; background:#303030 }
        article { margin:20px; padding:12px; background:#303030 }
      </style><header></header><article><b>${name}</b><p>0: solid · 1: Electron clear · 2: Acrylic · 3: old BlurBehind · 4: old DWM clear</p>
        <p>Put a patterned window behind this window. The area below this card must show it.
        Clear must retain detail; blur must soften it.</p>
        <p>Click this card to focus before using the keys. Also test resize, minimize and restore.</p>
      </article>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      apply(-1);
      win.show();
    }
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}
