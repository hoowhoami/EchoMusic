import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as object from '../src/shared/object.ts';
import * as tags from '../src/renderer/utils/playlistTags.ts';
function compile(path, deps) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const target = {
  id: 12,
  listid: 12,
  type: 0,
  source: 1,
  globalCollectionId: 'collection_3_7_12_0',
};
const raw = {
  listid: 12,
  type: 0,
  name: '旧名称',
  sort: 8,
  tags: '华语,流行',
  intro: '简介',
  source: 1,
};
const response = (row = raw, version = 9) => ({
  status: 1,
  data: { total_ver: version, info: [row], count: 1 },
});
function setup(api) {
  const order = compile('../src/renderer/services/playlistOrdering.ts', {
    '@/api/playlist': api,
    '../../shared/object': object,
  });
  return compile('../src/renderer/services/playlistEditing.ts', {
    '@/api/playlist': api,
    '../../shared/object': object,
    './playlistOrdering': order,
    '@/utils/playlistTags': tags,
    '@/utils/mappers': {
      mapPlaylistMeta: (row) => ({
        ...row,
        id: row.listid,
        isDefault: row.is_def === 1 || row.is_def === 2 || row.is_default === 1,
      }),
    },
  });
}

test('editing preserves current sort, tags and intro when renaming; writes use observed total_ver', async () => {
  let written;
  const api = setup({
    getUserPlaylists: async () => response(),
    updatePlaylistInfo: async (args) => {
      written = args;
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  const result = await api.savePlaylistEdit(
    snapshot,
    {
      draft: { name: '新名称', tags: snapshot.playlist.tags, intro: snapshot.playlist.intro },
    },
    () => true,
  );
  assert.deepEqual(written, {
    listid: 12,
    type: 0,
    total_ver: 9,
    name: '新名称',
    sort: 8,
    tags: '华语,流行',
    intro: '简介',
  });
  assert.equal(result.name, '新名称');
});

test('missing metadata is loaded from detail before an editable snapshot is returned', async () => {
  let query;
  const api = setup({
    getUserPlaylists: async () => response({ ...raw, intro: undefined, tags: undefined }),
    getPlaylistDetail: async (id) => {
      query = id;
      return { status: 1, data: [{ intro: '完整简介', tags: '电子' }] };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  assert.equal(query, target.globalCollectionId);
  assert.equal(snapshot.playlist.intro, '完整简介');
  assert.equal(snapshot.playlist.tags, '电子');
});

test('object tags from detail round-trip as names, and pasted separators are normalized on save', async () => {
  let written;
  const api = setup({
    getUserPlaylists: async () => response({ ...raw, tags: undefined }),
    getPlaylistDetail: async () => ({
      status: 1,
      data: [
        {
          tags: [
            { tag_id: 1, tag_name: '流行' },
            { id: 2, name: '粤语' },
          ],
        },
      ],
    }),
    updatePlaylistInfo: async (args) => {
      written = args;
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  assert.equal(snapshot.playlist.tags, '流行,粤语');
  const result = await api.savePlaylistEdit(
    snapshot,
    {
      draft: {
        name: snapshot.playlist.name,
        intro: snapshot.playlist.intro,
        tags: ' 流行， 粤语,流行\n 夜晚 ',
      },
    },
    () => true,
  );
  assert.equal(written.tags, '流行,粤语,夜晚');
  assert.equal(result.tags, written.tags);
  await api.savePlaylistEdit(
    snapshot,
    {
      draft: {
        name: snapshot.playlist.name,
        intro: snapshot.playlist.intro,
        tags: '',
      },
    },
    () => true,
  );
  assert.equal(written.tags, '');
});

test('missing sort, stale versions and account changes never write', async () => {
  let version = 9;
  let current = true;
  const api = setup({
    getUserPlaylists: async () => response(raw, version),
    updatePlaylistInfo: async () => assert.fail('Unexpected write'),
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  const change = { draft: { name: '新名称', tags: '', intro: '' } };
  version++;
  await assert.rejects(
    api.savePlaylistEdit(snapshot, change, () => true),
    /已变化/,
  );
  current = false;
  await assert.rejects(
    api.savePlaylistEdit(snapshot, change, () => current),
    /账号/,
  );
  const invalid = setup({ getUserPlaylists: async () => response({ ...raw, sort: undefined }) });
  await assert.rejects(
    invalid.loadPlaylistEdit(target, () => true),
    /顺序/,
  );
});

const coverFile = { data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };

test('cover save uploads encoded bytes then writes custom pic without changing metadata', async () => {
  let written;
  const calls = [];
  const api = setup({
    getUserPlaylists: async () => {
      calls.push('version');
      return response();
    },
    uploadPlaylistCover: async (...args) => {
      calls.push('upload');
      assert.deepEqual(args, [coverFile.data]);
      return { status: 1, FileName: '20260914.png' };
    },
    updatePlaylistInfo: async (args) => {
      calls.push('update');
      written = args;
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  calls.length = 0;
  const result = await api.savePlaylistEdit(
    snapshot,
    { draft: { name: raw.name, tags: raw.tags, intro: raw.intro }, cover: coverFile },
    () => true,
  );
  assert.deepEqual(calls, ['version', 'upload', 'version', 'update']);
  assert.deepEqual(written, {
    listid: 12,
    type: 0,
    total_ver: 9,
    sort: 8,
    tags: '华语,流行',
    intro: '简介',
    pic: 'custom/20260914.png',
  });
  assert.equal(result.pic, 'https://imge.kugou.com/custom/400/20260914.png');
  assert.equal(result.hasCustomCover, true);
  assert.equal(result.name, '旧名称');
});

test('failed uploads and invalid filenames never update the playlist', async () => {
  for (const result of [{ status: 0 }, { status: 1 }, { status: 1, FileName: '../bad.png' }]) {
    const api = setup({
      getUserPlaylists: async () => response(),
      uploadPlaylistCover: async () => result,
      updatePlaylistInfo: async () => assert.fail('Unexpected write'),
    });
    const snapshot = await api.loadPlaylistEdit(target, () => true);
    await assert.rejects(
      api.savePlaylistEdit(
        snapshot,
        { draft: { name: raw.name, tags: raw.tags, intro: raw.intro }, cover: coverFile },
        () => true,
      ),
      /上传失败/,
    );
  }
});

test('account or list changes during upload stop the cover write', async () => {
  for (const changeAccount of [false, true]) {
    let version = 9,
      current = true;
    const api = setup({
      getUserPlaylists: async () => response(raw, version),
      uploadPlaylistCover: async () => {
        if (changeAccount) current = false;
        else version++;
        return { status: 1, FileName: '20260914.png' };
      },
      updatePlaylistInfo: async () => assert.fail('Unexpected write'),
    });
    const snapshot = await api.loadPlaylistEdit(target, () => current);
    await assert.rejects(
      api.savePlaylistEdit(
        snapshot,
        { draft: { name: raw.name, tags: raw.tags, intro: raw.intro }, cover: coverFile },
        () => current,
      ),
      /已变化/,
    );
  }
});

test('cover selection validates image format and nonempty bounded files', () => {
  const api = setup({});
  for (const file of [
    { name: '封面.JPEG', type: '', size: 10 },
    { name: '封面.png', type: 'image/png', size: 10 },
    { name: '封面.webp', type: 'image/webp', size: 10 },
  ])
    assert.doesNotThrow(() => api.validatePlaylistCoverFile(file));
  for (const file of [
    { name: 'file.svg', type: 'image/svg+xml', size: 10 },
    { name: 'file.png', type: 'image/png', size: 0 },
    { name: 'file.png', type: 'image/png', size: 8 * 1024 * 1024 + 1 },
  ])
    assert.throws(() => api.validatePlaylistCoverFile(file));
});

test('failed saves preserve drafts and snapshots', async () => {
  let written;
  const api = setup({
    getUserPlaylists: async () => response(),
    updatePlaylistInfo: async (args) => {
      written = args;
      return { status: 0 };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  const draft = { name: '新名称', tags: '', intro: '' };
  await assert.rejects(
    api.savePlaylistEdit(snapshot, { draft }, () => true),
    /修改内容已保留/,
  );
  assert.equal(written.name, draft.name);
  assert.equal(snapshot.playlist.tags, '华语,流行');
  assert.deepEqual(draft, { name: '新名称', tags: '', intro: '' });
});

test('system playlists cannot open editing or submit info and cover changes', async () => {
  const noRequests = setup({
    getUserPlaylists: async () => assert.fail('Protected playlists must not reach the API'),
    updatePlaylistInfo: async () => assert.fail('Unexpected info write'),
    uploadPlaylistCover: async () => assert.fail('Unexpected upload'),
  });
  for (const name of ['我喜欢', '默认收藏', '账号喜欢的音乐']) {
    const protectedPlaylist = { ...target, name, isDefault: true };
    assert.equal(noRequests.canEditPlaylist(protectedPlaylist), false);
    // Names alone must not block an ordinary playlist with the same name.
    assert.equal(noRequests.canEditPlaylist({ ...target, name, isDefault: false }), true);
    await assert.rejects(
      noRequests.loadPlaylistEdit(protectedPlaylist, () => true),
      /不支持修改/,
    );
    const snapshot = { playlist: protectedPlaylist, listid: 12, type: 0, totalVer: 9, sort: 8 };
    for (const change of [
      { draft: { name: '新名称', tags: '', intro: '' } },
      { draft: { name: raw.name, tags: raw.tags, intro: raw.intro }, cover: coverFile },
    ]) {
      await assert.rejects(
        noRequests.savePlaylistEdit(snapshot, change, () => true),
        /不支持修改/,
      );
    }
  }
});

test('fresh system flags override a stale editable target before loading additional metadata', async () => {
  for (const flags of [{ is_def: 1 }, { is_def: 2 }, { is_default: 1 }]) {
    const api = setup({
      getUserPlaylists: async () => response({ ...raw, ...flags, tags: undefined }),
      getPlaylistDetail: async () =>
        assert.fail('Protected playlists must be rejected immediately'),
    });
    await assert.rejects(
      api.loadPlaylistEdit(target, () => true),
      /不支持修改/,
    );
  }
});

test('combined edits upload once and save metadata and chosen cover in one update', async () => {
  const writes = [];
  let uploads = 0;
  const api = setup({
    getUserPlaylists: async () => response(),
    uploadPlaylistCover: async () => {
      uploads++;
      return { status: 1, FileName: 'new.png' };
    },
    updatePlaylistInfo: async (args) => {
      writes.push(args);
      return { status: 1 };
    },
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  const result = await api.savePlaylistEdit(
    snapshot,
    {
      draft: { name: '新名称', tags: '爵士', intro: '新简介' },
      cover: coverFile,
    },
    () => true,
  );
  assert.equal(uploads, 1);
  assert.deepEqual(writes, [
    {
      listid: 12,
      type: 0,
      total_ver: 9,
      sort: 8,
      name: '新名称',
      tags: '爵士',
      intro: '新简介',
      pic: 'custom/new.png',
    },
  ]);
  assert.equal(result.name, '新名称');
  assert.equal(result.tags, '爵士');
  assert.equal(result.intro, '新简介');
  assert.equal(result.hasCustomCover, true);
});

test('metadata edits preserve automatic and manual covers without submitting pic or uploading', async () => {
  for (const hasCustomCover of [false, true]) {
    let written;
    const pic = hasCustomCover
      ? 'https://imge.kugou.com/custom/400/old.png'
      : 'automatic-cover.jpg';
    const api = setup({
      getUserPlaylists: async () => response({ ...raw, pic, hasCustomCover }),
      uploadPlaylistCover: async () => assert.fail('No explicit cover selection'),
      updatePlaylistInfo: async (args) => {
        written = args;
        return { status: 1 };
      },
    });
    const snapshot = await api.loadPlaylistEdit(target, () => true);
    const result = await api.savePlaylistEdit(
      snapshot,
      {
        draft: { name: '新名称', tags: '', intro: '' },
      },
      () => true,
    );
    assert.equal(Object.hasOwn(written, 'pic'), false);
    assert.equal(result.pic, pic);
    assert.equal(result.hasCustomCover, hasCustomCover);
  }
});

test('empty cover replacement cannot clear an existing cover or partially save metadata', async () => {
  const api = setup({
    getUserPlaylists: async () => response({ ...raw, pic: 'custom/old.png', hasCustomCover: true }),
    uploadPlaylistCover: async () => assert.fail('Invalid cover must not upload'),
    updatePlaylistInfo: async () => assert.fail('Invalid cover must not save metadata'),
  });
  const snapshot = await api.loadPlaylistEdit(target, () => true);
  for (const cover of [null, { data: new ArrayBuffer(0) }]) {
    await assert.rejects(
      api.savePlaylistEdit(
        snapshot,
        {
          draft: { name: '新名称', tags: '', intro: '' },
          cover,
        },
        () => true,
      ),
      /重新选择封面/,
    );
  }
  assert.equal(snapshot.playlist.pic, 'custom/old.png');
});
