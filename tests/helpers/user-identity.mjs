import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const module = { exports: {} };
const source = buildSync({
  entryPoints: [
    fileURLToPath(new URL('../../src/renderer/utils/userIdentity.ts', import.meta.url)),
  ],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
new Function('module', 'exports', source)(module, module.exports);
export const userIdentity = module.exports;
