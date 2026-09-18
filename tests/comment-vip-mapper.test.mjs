import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [new URL('../src/renderer/utils/mappers/playlist.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { mapCommentItem } = module.exports;

test('mapCommentItem attaches VIP chips from vip_type', () => {
  const comment = mapCommentItem({
    comment_id: 9,
    user_name: '阿强',
    content: '好听',
    vip_type: 1,
    m_type: 0,
    y_type: 0,
  });
  assert.equal(comment.badges?.[0].kind, 'vip');
  assert.equal(comment.badges?.[0].label, 'VIP');
});

test('mapCommentItem puts 达人 on the avatar from vinfo9.pic', () => {
  const comment = mapCommentItem({
    comment_id: 10,
    content: '赞',
    vinfo9: {
      cmt_talent_status: 1,
      pic: 'http://imge.kugou.com/commendpic/20180627/20180627153930257837.png',
    },
  });
  assert.equal(comment.badges, undefined);
  assert.equal(
    comment.talentIcon,
    'https://imge.kugou.com/commendpic/20180627/20180627153930257837.png',
  );
});

test('mapCommentItem puts 演唱者 on the avatar from vinfo9.pic', () => {
  const comment = mapCommentItem({
    comment_id: 12,
    content: '来了',
    vinfo9: {
      star_v_status: 1,
      user_label: '演唱者',
      pic: 'http://imge.kugou.com/commendpic/20180627/20180627153852371280.png',
    },
  });
  assert.equal(comment.badges, undefined);
  assert.equal(
    comment.talentIcon,
    'https://imge.kugou.com/commendpic/20180627/20180627153852371280.png',
  );
});

test('plain comment has no badges field', () => {
  const comment = mapCommentItem({ comment_id: 11, content: '嗨' });
  assert.equal(comment.badges, undefined);
});
