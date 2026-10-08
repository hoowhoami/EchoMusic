// Run the native Chromium layout regression with:
// ECHO_UI_GEOMETRY_TEST=1 node --test tests/page-scrollbar-geometry.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { build } from 'esbuild';
import { compileScript, compileStyle, parse, registerTS } from '@vue/compiler-sfc';

const require = createRequire(import.meta.url);
registerTS(() => require('typescript'));

test(
  'sticky headers clip content without moving the page scrollbar or disturbing dragging',
  { skip: process.env.ECHO_UI_GEOMETRY_TEST !== '1' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'echo-page-scrollbar-'));
    try {
      const styles = [];
      const result = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
            import {createApp,h,ref} from 'vue';
            import Page from '@/components/ui/PageScrollContainer.vue';
            import Header from '@/components/ui/PageStickyHeader.vue';
            import Sliver from '@/components/music/DetailPageSliverHeader.vue';
            const Content={setup(){
              const gap=ref(100),description=ref(''),sliver=ref(null);
              window.gap=gap;window.description=description;window.descriptionClicks=0;
              return()=>h('div',[
                h(Sliver,{ref:sliver,typeLabel:'CLOUD',title:'Title',coverUrl:'',expandedHeight:176,description:description.value,onDescriptionClick:()=>window.descriptionClicks++},{cover:()=>h('div',{style:{width:'150px',height:'150px'}}),details:()=>h('div','Capacity')}),
                h('div',{style:{height:gap.value+'px'}},'Introduction'),
                h(Header,{style:{height:'94px',top:(sliver.value?.currentHeight??176)+'px'}},()=>h('div','Songs')),
                h('div',{style:{height:'30000px'}}),
              ]);
            }};
            createApp({render:()=>h(Page,{hideBackToTop:true},()=>h(Content))}).mount('#app');
          `,
        },
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        alias: { '@': resolve('src/renderer') },
        plugins: [
          {
            name: 'vue-layout-fixture',
            setup(builder) {
              builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
                const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path });
                const id = `fixture-${styles.length}`;
                for (const style of descriptor.styles) {
                  if (style.content.includes('@reference')) continue;
                  styles.push(
                    compileStyle({
                      source: style.content,
                      filename: path,
                      id: `data-v-${id}`,
                      scoped: style.scoped,
                    }).code,
                  );
                }
                return {
                  contents:
                    compileScript(descriptor, {
                      id,
                      genDefaultAs: 'Component',
                      inlineTemplate: true,
                      fs: {
                        fileExists: existsSync,
                        readFile: (file) => readFileSync(file, 'utf8'),
                      },
                    }).content + `;Component.__scopeId='data-v-${id}';export default Component;`,
                  loader: 'ts',
                  resolveDir: dirname(path),
                };
              });
            },
          },
        ],
      });
      await writeFile(join(dir, 'ui.js'), result.outputFiles[0].text);
      await writeFile(
        join(dir, 'index.html'),
        `<style>${styles.join('\n')}
          body{margin:0}#app{height:600px;display:flex;flex-direction:column}
          .page-sticky-item{position:absolute;top:0}
          .page-sticky-item>div{position:relative!important;top:auto!important}
          .scrollbar-thumb{background:#888}
          .absolute{position:absolute}.relative{position:relative}.inset-x-0{left:0;right:0}.flex{display:flex}.flex-col{flex-direction:column}.h-full{height:100%}
          .flex-1{flex:1 1 0%}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.truncate{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        </style><div id="app"></div><script src="ui.js"></script>`,
      );
      await writeFile(
        join(dir, 'check.cjs'),
        `const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');
        app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(join(dir, 'user'))});
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{offscreen:true,backgroundThrottling:false}});
          await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
          const js=s=>win.webContents.executeJavaScript(s);
          const wait=()=>js('new Promise(r=>setTimeout(r,60))');
          await wait();
          await js("document.querySelector('.scroll-area').dispatchEvent(new MouseEvent('mouseenter'))");
          for(const gap of [100,0,200]){
            await js('window.gap.value='+gap);
            await wait();
            for(const top of [0,80,118,119,120,121,218,219,220,221,500,120,0]){
              await js("document.querySelector('.scrollbar-wrap').scrollTop="+top);
              await wait();
              const state=await js("(()=>{const wrap=document.querySelector('.scrollbar-wrap'),track=document.querySelector('.scrollbar'),thumb=document.querySelector('.scrollbar-thumb');return{top:wrap.scrollTop,inset:+wrap.dataset.echoStickyInset,areaClip:getComputedStyle(document.querySelector('.scroll-area')).clipPath,contentClip:getComputedStyle(wrap).clipPath,trackTop:track.getBoundingClientRect().top,trackHeight:track.getBoundingClientRect().height,thumbTop:thumb.getBoundingClientRect().top}})()");
              assert.equal(state.top,top);
              assert.equal(state.trackTop,0);
              assert.equal(state.trackHeight,600);
              assert.equal(state.areaClip,'none');
              assert.equal(state.contentClip,'inset('+state.inset+'px 0px 0px)');
              assert.ok(Math.abs(state.thumbTop-(6+top/(30370+gap-600)*558))<1);
            }
          }
          await js("window.description.value='A short introduction'");
          await wait();
          assert.equal(await js("document.querySelector('.sliver-header-description button')"),null,'a fully visible introduction needs no details button');
          for(const description of ['A long introduction that can be opened in full. '.repeat(12),'', '   ']){
            await js('window.description.value='+JSON.stringify(description));
            await wait();
            const height=await js("parseFloat(document.querySelector('.sliver-header-spacer').style.height)");
            assert.equal(height,description.trim()?148:120);
            assert.equal(await js("document.querySelector('.scrollbar').getBoundingClientRect().top"),0);
            if(description.trim()){
              assert.ok(await js("!!document.querySelector('.sliver-header-root .sliver-header-description')"));
              await js("document.querySelector('.sliver-header-description button').click()");
              assert.equal(await js('window.descriptionClicks'),1);
              win.setContentSize(6000,600);
              await wait();
              assert.equal(await js("document.querySelector('.sliver-header-description button')"),null,'widening the page removes the button once the entire introduction fits');
              win.setContentSize(800,600);
              await wait();
              assert.ok(await js("!!document.querySelector('.sliver-header-description button')"),'narrowing the page restores the details button');
              await js("document.querySelector('.scrollbar-wrap').scrollTop=148");
              await wait();
              assert.equal(await js("document.querySelector('.sliver-header-description').parentElement.style.opacity"),'0');
            }
          }
          await js("document.querySelector('.scrollbar-wrap').scrollTop=0;const thumb=document.querySelector('.scrollbar-thumb'),r=thumb.getBoundingClientRect();window.grab=r.top+r.height/2;thumb.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientY:window.grab}));document.dispatchEvent(new MouseEvent('mousemove',{clientY:window.grab+60}));");
          await wait();
          const first=await js("document.querySelector('.scrollbar-wrap').scrollTop");
          await js("document.dispatchEvent(new MouseEvent('mousemove',{clientY:window.grab+70}))");
          await wait();
          const second=await js("document.querySelector('.scrollbar-wrap').scrollTop");
          assert.ok(second>first);
          assert.ok(Math.abs((second-first)/first-1/6)<.01,'drag speed remains stable after headers collapse');
          assert.ok(await js("Math.abs(document.querySelector('.scrollbar-thumb').getBoundingClientRect().top-window.grab-55)<1"),'thumb remains under the pointer');
          await js("document.dispatchEvent(new MouseEvent('mouseup'))");
          win.destroy();app.quit();
        }).catch(e=>{console.error(e);app.exit(1)});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const { stdout, stderr } = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(dir, 'check.cjs')],
        { env, timeout: 60_000 },
      );
      assert.equal(stdout.trim(), '', stdout);
      assert.ok(!stderr.includes('AssertionError'), stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
