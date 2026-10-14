// Run manually with: node tests/main-window-hidden-electron-smoke.mjs
// Uses an isolated profile and the real mounted-DOM handshake; no account or network setup.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-hidden-startup-'));
const entry = path.join(root, 'main.cjs');
const preload = path.join(root, 'preload.cjs');
const html = path.join(root, 'index.html');
const renderer = path.join(root, 'renderer.js');
const rendererSource = await fs.readFile('src/renderer/main.ts', 'utf8');
const mount = rendererSource.slice(rendererSource.indexOf('const mountApplication ='));
const preloadSource = await fs.readFile('src/preload/index.ts', 'utf8');
const notify = preloadSource.match(/  notifyPageMounted: [^\n]+/)[0];
await fs.writeFile(
  preload,
  `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('echoInitialDark',process.argv.includes('--smoke-dark'));
contextBridge.exposeInMainWorld('echoWindowBackground',JSON.parse(process.argv.find(a=>a.startsWith('--smoke-background=')).slice('--smoke-background='.length)));
contextBridge.exposeInMainWorld('electron',{${notify}});`,
);
await fs.writeFile(
  html,
  (await fs.readFile('index.html', 'utf8')).replace(
    '<script type="module" src="/src/renderer/main.ts"></script>',
    '<script src="./renderer.js"></script>',
  ),
);
await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'ts',
    contents: `import {createApp,h,nextTick} from 'vue';
const app=createApp({render:()=>h('main',{id:'rendered-route'},'EchoMusic Loading')});
const markStartup=()=>{};
const routeReady=new Promise(resolve=>window.releaseInitialRoute=resolve);
const router={isReady:()=>routeReady};
window.framesRan=0;requestAnimationFrame(()=>{window.framesRan++;requestAnimationFrame(()=>window.framesRan++)});
${mount}`,
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: renderer,
});
await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'ts',
    contents: `import {app,BrowserWindow,ipcMain} from 'electron';
import assert from 'node:assert/strict';
import {waitForMainWindowStartup} from './src/main/window/startup';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timeout=(promise,label)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error(label+' timed out')),4000);t.unref()})]);
app.setPath('userData',${JSON.stringify(path.join(root, 'userdata'))});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const results=[];
 for(const mode of ['normal-light','normal-dark','minimized-dark','minimized-transparent','early-restore']){
  const minimized=mode.startsWith('minimized');const early=mode==='early-restore';
  const dark=mode.includes('dark');const clear=mode.includes('transparent');
  const background={enabled:clear,frosted:false,transparency:100,transparentMode:'pure',color:'#334455'};
  const win=new BrowserWindow({show:false,paintWhenInitiallyHidden:false,width:600,height:400,transparent:clear,backgroundColor:clear?'#00000000':dark?'#26262a':'#f5f5f7',webPreferences:{preload:${JSON.stringify(preload)},backgroundThrottling:true,contextIsolation:true,sandbox:true,additionalArguments:[...(dark?['--smoke-dark']:[]),'--smoke-background='+JSON.stringify(background)]}});
  let mounted=false;let readyEvents=0;let shows=0;let hides=0;let visibilityAtMount='';
  win.on('ready-to-show',()=>readyEvents++);win.on('show',()=>shows++);win.on('hide',()=>hides++);
  const mountedObservation=new Promise(resolve=>{const listener=async event=>{if(event.sender!==win.webContents)return;ipcMain.removeListener('main-window:page-mounted',listener);visibilityAtMount=await win.webContents.executeJavaScript('document.visibilityState');resolve()};ipcMain.on('main-window:page-mounted',listener)});
  const startup=waitForMainWindowStartup(win,()=>{mounted=true;if(!minimized&&!early)win.show()});
  const earlyRestore=early?startup.then(()=>win.show()):null;
  await win.loadFile(${JSON.stringify(html)});await pause(100);
  assert.equal(win.isVisible(),false);assert.equal(mounted,false);assert.equal(readyEvents,0);
  assert.equal(await win.webContents.executeJavaScript('document.visibilityState'),'hidden');
  await win.webContents.executeJavaScript('window.releaseInitialRoute()');
  await timeout(startup,mode);await timeout(mountedObservation,mode+' mounted observation');
  if(earlyRestore)await earlyRestore;
  assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("#rendered-route")'),true);
  if(minimized){assert.equal(win.isVisible(),false);assert.equal(shows,0);assert.equal(readyEvents,0);assert.equal(await win.webContents.executeJavaScript('window.framesRan'),0);win.show()}
  await pause(150);
  assert.equal(win.isVisible(),true);assert.equal(shows,1);assert.equal(hides,0);
  const theme=await win.webContents.executeJavaScript('({dark:document.documentElement.classList.contains("dark"),background:getComputedStyle(document.documentElement).backgroundColor,opacity:document.documentElement.style.getPropertyValue("--app-background-opacity")})');
  assert.equal(theme.dark,dark);
  if(clear){assert.equal(theme.opacity,'0');assert.equal(theme.background,'rgba(0, 0, 0, 0)')}
  else assert.equal(theme.background,dark?'rgb(38, 38, 42)':'rgb(245, 245, 247)');
  win.hide();await pause(80);assert.equal(await win.webContents.executeJavaScript('document.visibilityState'),'hidden');
  win.show();await pause(80);assert.equal(win.isVisible(),true);assert.ok(shows>=1);assert.equal(hides,1);
  assert.equal(ipcMain.listenerCount('main-window:page-mounted'),0);
  results.push({mode,visibilityAtMount,shows,hides,theme});win.destroy();
 }
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,platform:process.platform,results},null,2));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});`,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: entry,
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Hidden startup smoke timed out'));
    }, 30000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
