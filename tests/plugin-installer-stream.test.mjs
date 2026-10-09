import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: "export {extractZipWithStreamZip} from './src/main/plugins/installer';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'extract-fixture',
      setup(b) {
        b.onLoad({ filter: /plugins\/installer\.ts$/ }, async (args) => ({
          loader: 'ts',
          contents: (await fs.readFile(args.path, 'utf8')) + '\nexport {extractZipWithStreamZip};',
        }));
        b.onResolve({ filter: /logger$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export default {info(){},warn(){},error(){}};',
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const { extractZipWithStreamZip } = module.exports;
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
function zip(entries) {
  const files = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? 'contents');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const reported = entry.reportedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(reported, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(reported, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((entry.attr ?? 0) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    files.push(local, name, compressed);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
async function fixture(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-extract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'package.zip'),
    output = path.join(root, 'output');
  await fs.mkdir(output);
  await fs.writeFile(file, zip(entries));
  return { root, file, output };
}
test(
  'ZIP extraction streams a 10 MiB entry and closes all handles',
  { timeout: 15000 },
  async (t) => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 27);
    const f = await fixture(t, [{ name: 'plugin/assets/program.bin', data: bytes }]);
    await extractZipWithStreamZip(f.file, f.output);
    assert.deepEqual(await fs.readFile(path.join(f.output, 'plugin/assets/program.bin')), bytes);
    await fs.rm(f.file);
    await fs.rm(f.output, { recursive: true });
  },
);
for (const [name, entries] of [
  ['traversal', [{ name: '../outside.txt' }]],
  ['absolute path', [{ name: '/outside.txt' }]],
  ['case collision', [{ name: 'Dir/a' }, { name: 'dir/b' }]],
  ['symlink', [{ name: 'link', attr: 0xa1ff0000 }]],
  ['encrypted entry', [{ name: 'secret', flags: 1 }]],
  ['reported decompression budget', [{ name: 'large', reportedSize: 81 * 1024 * 1024 }]],
])
  test(`ZIP extraction rejects ${name} before writing files`, async (t) => {
    const f = await fixture(t, entries);
    await assert.rejects(extractZipWithStreamZip(f.file, f.output));
    assert.equal(await fs.stat(path.join(f.root, 'outside.txt')).catch(() => null), null);
    await fs.rm(f.file);
    await fs.rm(f.output, { recursive: true });
  });
test('lying decompressed size cannot install an unchecked entry', async (t) => {
  const f = await fixture(t, [{ name: 'wrong', data: Buffer.alloc(1024 * 1024), reportedSize: 1 }]);
  await assert.rejects(extractZipWithStreamZip(f.file, f.output));
  await fs.rm(f.file);
  await fs.rm(f.output, { recursive: true });
});
