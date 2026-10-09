import { buildSync } from 'esbuild';

const module = { exports: {} };
const source = buildSync({
  entryPoints: [new URL('../../src/renderer/utils/userIdentity.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
new Function('module', 'exports', source)(module, module.exports);
export const userIdentity = module.exports;
