// Run manually: node tests/history-share-electron-smoke.mjs
// Renders the real statistics template and exercises capturePage without changing the clipboard.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { Icon } from '@iconify/vue';

const require = createRequire(import.meta.url);
const source = await readFile('src/renderer/views/History.vue', 'utf8');
const { descriptor } = parse(source);
const findStats = (node) =>
  node.props?.some((prop) => prop.name === 'ref' && prop.value?.content === 'historyStatsRef')
    ? node
    : node.children?.map(findStats).find(Boolean);
const statsNode = findStats(parseTemplate(descriptor.template.content));
assert.ok(statsNode);
const evaluate = (code) => {
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(code, { loader: 'ts', format: 'cjs' }).code,
  )(require, mod, mod.exports);
  return mod.exports;
};
const icons = evaluate(await readFile('src/renderer/icons.ts', 'utf8'));
const { render } = evaluate(
  compileTemplate({ source: statsNode.loc.source, filename: 'History.vue', id: 'history-capture' })
    .code,
);
const stats = {
  statCards: [
    {
      label: '累计播放',
      value: '4,533',
      caption: '500 首本地历史',
      icon: icons.iconPlay,
      tone: 'primary',
    },
    {
      label: '估算时长',
      value: '11 天',
      caption: '按歌曲时长与次数估算',
      icon: icons.iconClock,
      tone: 'cyan',
    },
    {
      label: '活跃天数',
      value: '15 天',
      caption: '覆盖最近 23 天',
      icon: icons.iconPulse,
      tone: 'emerald',
    },
    {
      label: '复听占比',
      value: '37%',
      caption: '185 首听过多次',
      icon: icons.iconStar,
      tone: 'amber',
    },
  ],
  recentDays: [0, 67, 38, 76, 0, 0, 37].map((value, i) => ({
    key: i,
    label: i === 6 ? '今天' : `周${i + 1}`,
    dateLabel: `10/${6 + i}`,
    value,
    ratio: value / 76,
  })),
  timeBuckets: ['凌晨', '上午', '下午', '夜晚'].map((label, i) => ({
    label,
    hint: `${i * 6}:00-${i * 6 + 5}:59`,
    value: [54, 80, 219, 147][i],
    ratio: [54, 80, 219, 147][i] / 219,
  })),
  topArtists: Array.from({ length: 6 }, (_, i) => ({
    name: `测试歌手 ${i + 1}`,
    songs: 6 - i,
    plays: 374 - i * 40,
  })),
  topSongs: Array.from({ length: 6 }, (_, i) => ({
    key: i,
    title: `测试歌曲 ${i + 1}`,
    artist: `测试歌手 ${i + 1}`,
    plays: 269 - i * 20,
    lastPlayedLabel: '10月9日 16:45',
  })),
  topAlbum: { name: '测试专辑', plays: 269, songs: 1 },
};
const app = createSSRApp({
  setup: () => ({ historyStats: stats, iconMusic: icons.iconMusic, iconStar: icons.iconStar }),
  render,
});
app.component('Icon', (props) => h(Icon, { ...props, ssr: true }));
const markup = await renderToString(app);
const css = descriptor.styles[0].content.replace(/^@reference[^;]*;/m, '');
const start = source.indexOf('const createStatsCaptureStage =');
const end = source.indexOf('const handleShareStats =', start);
assert.ok(start > 0 && end > start);
const captureCode = transformSync(source.slice(start, end), { loader: 'ts' }).code;
const html = `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:var(--color-text-main)}
:root{--surface-main-base:rgba(250,250,250,.65);--color-bg-main:rgba(250,250,250,.05);--color-text-main:#18181b;--color-text-secondary:#52525b;--border-subtle:#0002;--control-muted-bg:#00000008;--radius-popover:12px;--radius-card:10px;--color-primary:#0891b2;--color-primary-text:#0891b2;--text-primary-text:#0891b2;--color-primary-gradient-end:#06b6d4}
${css}</style></head><body><div style="position:fixed;inset:0;font-size:80px;color:magenta">原页面背景／侧边栏／播放栏</div><div id="original" style="opacity:.4">${markup}</div></body></html>`;
const renderer = `const historyStatsRef={value:document.querySelector('#original .history-stats')};const themeStore={isDark:false};const waitForPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));window.electron={share:{captureRectToClipboard:async rect=>{window.captureRect=rect;return true;}}};${captureCode}
window.makeCapture=async dark=>{themeStore.isDark=dark;window.stage=createStatsCaptureStage({title:'测试用户 的听歌统计',updatedAt:'2026-10-12 17:13'});await captureStageToClipboard(window.stage);return window.captureRect;};window.paint=waitForPaint;undefined;`;
const directory = await mkdtemp(path.join(tmpdir(), 'echo-history-capture-'));
const entry = path.join(directory, 'smoke.cjs');
const electronScript = `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,useContentSize:true,width:1100,height:900,webPreferences:{backgroundThrottling:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(html)}));
 await win.webContents.executeJavaScript(${JSON.stringify(renderer)});
 const take=async color=>{await win.webContents.executeJavaScript('document.body.style.background='+JSON.stringify(color)+';window.paint()');return win.webContents.capturePage(rect);};
 let rect;
 for(const [name,dark,width,height] of [['light',false,1100,900],['dark',true,800,600]]){
  win.setContentSize(width,height);await win.webContents.executeJavaScript('window.paint()');
  await win.webContents.executeJavaScript('document.documentElement.style.setProperty("--surface-main-base",'+JSON.stringify(dark?'rgba(35,35,40,.65)':'rgba(250,250,250,.65)')+');document.documentElement.style.setProperty("--color-text-main",'+JSON.stringify(dark?'#fafafa':'#18181b')+');document.documentElement.style.setProperty("--color-text-secondary",'+JSON.stringify(dark?'#c4c4c8':'#52525b')+');');
  rect=await win.webContents.executeJavaScript('window.makeCapture('+dark+')');
  assert.ok(rect.x>=16&&rect.y>=16&&rect.x+rect.width<=width-16&&rect.y+rect.height<=height-16);
  const first=await take('#ff00ff');const second=await take('#00ff00');
  assert.deepEqual(first.toBitmap(),second.toBitmap(),'original page must not bleed into '+name+' export');
  const bytes=second.toBitmap();for(let i=3;i<bytes.length;i+=4)assert.equal(bytes[i],255,'export must be opaque');
  fs.writeFileSync('/tmp/echo-history-share-'+name+'.png',second.toPNG());
  if(name==='light'){
   await win.webContents.executeJavaScript('window.stage.style.background="var(--color-bg-main)";window.paint()');
   const oldFirst=await take('#ff00ff');const oldSecond=await take('#00ff00');
   assert.notDeepEqual(oldFirst.toBitmap(),oldSecond.toBitmap(),'fixture must reproduce original transparency bug');
  }
  await win.webContents.executeJavaScript('window.stage.remove()');
  console.log('PASS '+name+' opaque statistics capture '+rect.width+'x'+rect.height);
 }
 win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});`;
await writeFile(entry, electronScript);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('capture smoke timed out'));
    }, 45000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
