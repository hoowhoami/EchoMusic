// Run manually with: node tests/plugin-resources-electron-smoke.mjs
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const directory = await fs.mkdtemp(
  path.join(process.cwd(), '.planning', 'electron-resource-smoke-'),
);
const entry = path.join(directory, 'smoke.cjs');
const preload = path.join(directory, 'preload.cjs');
const renderer = path.join(directory, 'renderer.js');
await build({
  stdin: {
    contents:
      "import {contextBridge} from 'electron';import {pluginResourcesNative,managePluginGrants} from './src/preload/pluginResources';contextBridge.exposeInMainWorld('electron',{plugins:{resources:pluginResourcesNative,manageGrants:managePluginGrants}});",
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: preload,
});
await build({
  stdin: {
    contents: "export {createPluginResourceApi} from './src/renderer/plugins/runtime/resources';",
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'ResourceSmoke',
  outfile: renderer,
});

await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'ts',
    contents: `
import {app,protocol,session,BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {PluginResources,getPluginResources} from './src/main/plugins/resources';
import {registerPluginResourceHandlers} from './src/main/ipc/pluginResources';
import {getManagedNetworkSession,initializeNetworkPolicy} from './src/main/networkPolicy';
import {DEFAULT_NETWORK_SETTINGS} from './src/shared/network';
protocol.registerSchemesAsPrivileged([{scheme:'echo-plugin-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
const root=${JSON.stringify(directory)};
app.setPath('userData',path.join(root,'userdata'));
(async()=>{
  await app.whenReady();
  app.on('window-all-closed',()=>{});
  const bytes=Buffer.alloc(10*1024*1024,27);const requests=[];
  const proxy=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  await initializeNetworkPolicy({...DEFAULT_NETWORK_SETTINGS,proxyMode:'fixed_servers',proxyRules:'http=127.0.0.1:'+proxy.address().port,proxyBypassRules:'<-loopback>'});
  const plugin={id:'smoke',name:'Smoke',directory:path.join(root,'plugins','smoke'),manifest:{capabilities:{localFiles:true,downloads:true}},enabled:true};
  const service=new PluginResources({root,find:()=>plugin,current:p=>p===plugin,fetch:async(url,init)=>(await getManagedNetworkSession('echo-plugin-downloads')).fetch(url,init),selectDirectory:async()=>undefined,selectFiles:async()=>[]});
  const dir=await service.call('smoke','getPrivateDirectory',{kind:'data'});
  const task=await service.call('smoke','download',{url:'http://resource.invalid/large.bin',target:{directoryId:dir.id,relativePath:'large.bin'}});
  const owner=(await service.capture('smoke')).owner;await service.downloads.wait(owner,task.id);
  assert.deepEqual(await fs.readFile(path.join(dir.displayPath,'large.bin')),bytes);
  assert.deepEqual(requests,['http://resource.invalid/large.bin']);
  const file={kind:'directory-file',directoryId:dir.id,relativePath:'video.mp4'};
  await service.call('smoke','writeFile',{ref:file,data:'0123456789'});
  const lease=await service.call('smoke','openMedia',{ref:file});
  session.defaultSession.protocol.handle('echo-plugin-media',request=>service.mediaResponse(request));
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await win.loadURL('data:text/html,<html><body>Media protocol smoke</body></html>');
  const result=await win.webContents.executeJavaScript('(async()=>{const r=await fetch('+JSON.stringify(lease.url)+',{headers:{Range:"bytes=2-5"}});return {status:r.status,range:r.headers.get("content-range"),mime:r.headers.get("content-type"),body:await r.text()};})()');
  assert.deepEqual(result,{status:206,range:'bytes 2-5/10',mime:'video/mp4',body:'2345'});
  await service.call('smoke','releaseMedia',{id:lease.id});
  assert.equal((await session.defaultSession.fetch(lease.url)).status,404);
  win.destroy();
  session.defaultSession.protocol.unhandle('echo-plugin-media');
  globalThis.smokePlugin=plugin;
  registerPluginResourceHandlers({getMainWindow:()=>null});
  const bridgeWin=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,preload:${JSON.stringify(preload)}}});
  await bridgeWin.loadURL('data:text/html,<html><body>IPC resource smoke</body></html>');
  await bridgeWin.webContents.executeJavaScript(await fs.readFile(${JSON.stringify(renderer)},'utf8'));
  const bridged=await bridgeWin.webContents.executeJavaScript('(async()=>{const disposables=[];const api=ResourceSmoke.createPluginResourceApi("smoke",fn=>disposables.push(fn));globalThis.resourceSmokeApi=api;const d=await api.files.getPrivateDirectory({kind:"data"});const task=await api.download({url:"http://resource.invalid/bridge.bin",target:{directoryId:d.id,relativePath:"bridge.bin"}});const result=await task.wait();const media=await api.files.openMedia(result.file);const r=await fetch(media.url,{headers:{Range:"bytes=0-3"}});const bytes=Array.from(new Uint8Array(await r.arrayBuffer()));await api.call("releaseMedia",{id:media.id});return {size:result.bytes,status:r.status,bytes};})()');
  assert.deepEqual(bridged,{size:10*1024*1024,status:206,bytes:[27,27,27,27]});
  const resourceService=getPluginResources();
  const managedOwner=(await resourceService.capture('smoke')).owner;
  const grant=await resourceService.grants.create(managedOwner,path.join(dir.displayPath,'video.mp4'),'read',true,true);
  const managed=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants()');
  assert.equal(managed.ok,true);assert.equal(managed.value.length,1);assert.equal(managed.value[0].pluginId,'smoke');assert.equal(managed.value[0].grants.length,1);assert.equal(managed.value[0].grants[0].kind,'file');
  const activeRemoval=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+',"remove")');
  assert.equal(activeRemoval.ok,false);assert.equal(activeRemoval.error.code,'INVALID_ARGUMENT');
  const invalidAction=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+',"invalid")');
  assert.equal(invalidAction.ok,false);assert.equal(invalidAction.error.code,'INVALID_ARGUMENT');
  const revoked=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+')');
  assert.equal(revoked.ok,true);assert.equal(revoked.value[0].grants[0].revoked,true);
  resourceService['deps'].selectFiles=async()=>[];
  const canceledRestore=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+',"reauthorize")');
  assert.equal(canceledRestore.ok,true);assert.equal(canceledRestore.value[0].grants[0].revoked,true);
  resourceService['deps'].selectFiles=async(_plugin,request)=>{assert.equal(request.multiple,false);return [path.join(dir.displayPath,'video.mp4')];};
  const restored=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+',"reauthorize")');
  assert.equal(restored.ok,true);assert.equal(restored.value[0].grants[0].id,grant.fileId);assert.equal(restored.value[0].grants[0].revoked,false);
  await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+')');
  const removed=await bridgeWin.webContents.executeJavaScript('window.electron.plugins.manageGrants("smoke",'+JSON.stringify(grant.fileId)+',"remove")');
  assert.equal(removed.ok,true);assert.deepEqual(removed.value,[]);
  assert.equal(await fs.readFile(path.join(dir.displayPath,'video.mp4'),'utf8'),'0123456789');
  plugin.enabled=false;await globalThis.smokeRevoke(['smoke']);
  const code=await bridgeWin.webContents.executeJavaScript('resourceSmokeApi.downloads.list().then(()=>"unexpected",e=>e.code)');assert.equal(code,'PLUGIN_UNAVAILABLE');
  bridgeWin.destroy();await getPluginResources().downloads.shutdown();await service.downloads.shutdown();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
  console.log('PASS Electron '+process.versions.electron+': managed proxy download 10 MiB; renderer controlled media Range 206; lease revocation 404; sandbox preload/IPC/runtime download and generation revocation; unified grant listing/revocation/reauthorization/removal, canceled selection, active-record rejection, file preservation');app.exit(0);
})().catch(error=>{console.error(error);app.exit(1)});
`,
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  plugins: [
    {
      name: 'smoke-fixture',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/plugins$/ }, (args) =>
          args.importer.endsWith('/ipc/pluginResources.ts')
            ? { path: 'descriptor', namespace: 'fixture' }
            : undefined,
        );
        b.onResolve({ filter: /logger$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
        b.onResolve({ filter: /media\/audioMetadata$/ }, () => ({
          path: 'audio',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'logger'
              ? 'export const isDiagnosticModeActive=()=>false;export default {info(){},warn(){},error(){}};'
              : args.path === 'descriptor'
                ? 'export const getPluginDescriptor=()=>globalThis.smokePlugin;export const isPluginAccessCurrent=p=>p===globalThis.smokePlugin&&p.enabled;export const onPluginAccessRevoked=fn=>{globalThis.smokeRevoke=fn;};'
                : 'export const readAudioMetadata=async()=>({});',
        }));
      },
    },
  ],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Electron smoke timed out'));
    }, 45000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  process.exitCode = exit ?? 1;
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
