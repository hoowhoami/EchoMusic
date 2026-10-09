import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (!(name in dependencies)) throw new Error(`unexpected session dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};

export const userSession = compile('../../src/renderer/utils/userSession.ts');
export const userSessionWatch = compile('../../src/renderer/utils/watchUserSession.ts', {
  vue,
  './userSession': userSession,
});
