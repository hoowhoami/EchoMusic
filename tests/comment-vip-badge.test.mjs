import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [new URL('../src/renderer/utils/commentVip.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const {
  resolveVipKind,
  resolveMusicKind,
  resolveCompactVipKind,
  resolveYoungPlateId,
  shouldShowVipPlate,
  resolveCommentVipKind,
  commentVipChips,
  extractCommentVipFields,
  commentChipsFromRaw,
  commentTalentIconFromRaw,
  COMMENT_TALENT_ICON,
} = module.exports;

test('fallback vip_type / y_type kinds match o.q tail', () => {
  assert.equal(resolveVipKind(0, 0, 2), 6);
  assert.equal(resolveVipKind(0, 0, 3), 6);
  assert.equal(resolveVipKind(1, 0, 0), 1);
  assert.equal(resolveVipKind(1, 1, 0), 2);
  assert.equal(resolveVipKind(6, 0, 0), 2);
  assert.equal(resolveVipKind(0, 0, 0), -1);
});

test('o.p maps music package + year combo', () => {
  assert.equal(resolveMusicKind(0, 1), 5);
  assert.equal(resolveMusicKind(0, 3), 5);
  assert.equal(resolveMusicKind(1, 0), 3);
  assert.equal(resolveMusicKind(3, 0), 4);
  assert.equal(resolveMusicKind(0, 0), -2);
});

test('compact ImageView path promotes VIP+music with y_type=1 to year VIP', () => {
  assert.equal(resolveCompactVipKind(1, 1, 1), 6);
  assert.equal(resolveVipKind(1, 1, 1), 2);
});

test('J() shows plate for young products, VIP, music-pack, or super-VIP', () => {
  const none = { userType: -1, userYType: -1, svipLevel: -1, busiVip: [] };
  assert.equal(shouldShowVipPlate(2, -2, none), true);
  assert.equal(shouldShowVipPlate(-1, 5, none), true);
  assert.equal(shouldShowVipPlate(-1, -2, none), false);
  assert.equal(shouldShowVipPlate(9, -2, none), true);
  assert.equal(shouldShowVipPlate(11, -2, none), true);
  assert.equal(shouldShowVipPlate(7, -2, none), true);
});

test('super VIP is user_type bit 16, not svip_level', () => {
  const base = { userYType: -1, svipLevel: 8, busiVip: [] };
  assert.equal(resolveCommentVipKind(1, 0, 0, { ...base, userType: 16 }), 'svip');
  assert.equal(resolveCommentVipKind(1, 0, 0, { ...base, userType: 16, userYType: 16 }), 'svip-year');
  assert.equal(resolveCommentVipKind(1, 0, 0, { ...base, userType: 0 }), 'vip');
  assert.equal(resolveCommentVipKind(1, 0, 0, { ...base, userType: 3 }), 'vip');
});

test('music pack year uses y_type=1 even without vip_type', () => {
  assert.equal(resolveCommentVipKind(0, 0, 1), 'music-year');
  assert.equal(resolveCommentVipKind(0, 1, 0), 'music');
});

test('non-member with no identity has no chips', () => {
  assert.deepEqual(commentChipsFromRaw({ comment_id: 1, content: 'hi' }), []);
});

test('extracts vip_type/m_type/y_type and vinfo9 talent/student', () => {
  const fields = extractCommentVipFields({
    vip_type: 1,
    m_type: 0,
    y_type: 0,
    vinfo9: { cmt_talent_status: 1, student_status: 1, user_label: '达人' },
  });
  assert.equal(fields.vipType, 1);
  assert.equal(fields.identity.talent, true);
  assert.equal(fields.identity.student, true);
  const chips = commentVipChips(fields);
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['VIP', '学生'],
  );
});

test('达人 is an avatar icon from vinfo9.pic, not a username chip', () => {
  assert.deepEqual(
    commentChipsFromRaw({
      vinfo9: { cmt_talent_status: 1, user_label: '达人' },
    }),
    [],
  );
  assert.equal(
    commentTalentIconFromRaw({ vinfo9: { cmt_talent_status: 1 } }),
    COMMENT_TALENT_ICON,
  );
  assert.equal(
    commentTalentIconFromRaw({
      vinfo9: {
        cmt_talent_status: 1,
        pic: 'http://imge.kugou.com/commendpic/20180627/20180627153930257837.png',
      },
    }),
    COMMENT_TALENT_ICON,
  );
});

test('演唱者 uses vinfo9.pic on the avatar and skips the 演唱者 chip', () => {
  const singerPic = 'https://imge.kugou.com/commendpic/20180627/20180627153852371280.png';
  assert.equal(
    commentTalentIconFromRaw({
      vinfo9: {
        star_v_status: 1,
        user_label: '演唱者',
        pic: 'http://imge.kugou.com/commendpic/20180627/20180627153852371280.png',
      },
    }),
    singerPic,
  );
  assert.deepEqual(
    commentChipsFromRaw({
      vinfo9: {
        star_v_status: 1,
        user_label: '演唱者',
        pic: singerPic,
      },
    }),
    [],
  );
});

test('auth_info like 歌词制作达人 stays a username chip', () => {
  assert.deepEqual(
    commentChipsFromRaw({
      vinfo9: {
        cmt_talent_status: 1,
        auth_info: '歌词制作达人',
        pic: COMMENT_TALENT_ICON,
      },
    }).map((chip) => chip.label),
    ['歌词制作达人'],
  );
});

test('super VIP plate is a single 超级VIP chip from user_type bit 16', () => {
  assert.deepEqual(
    commentChipsFromRaw({
      vip_type: 1,
      vipinfo: { user_type: 16, svip_level: 5, user_y_type: 0 },
    }).map((chip) => chip.label),
    ['超级VIP'],
  );
});

test('svip_level alone does not become 超级VIP; vip_type still shows VIP', () => {
  assert.deepEqual(
    commentChipsFromRaw({
      vip_type: 1,
      vipinfo: { user_type: 0, svip_level: 5 },
    }).map((chip) => chip.label),
    ['VIP'],
  );
});

test('year music pack is 年费音乐包; regular pack is 音乐包', () => {
  assert.deepEqual(
    commentChipsFromRaw({ y_type: 1 }).map((chip) => chip.label),
    ['年费音乐包'],
  );
  assert.deepEqual(
    commentChipsFromRaw({ m_type: 1 }).map((chip) => chip.label),
    ['音乐包'],
  );
});

test('Young plate is mutually exclusive: super bit > 概念 svip > 畅听 tvip', () => {
  assert.equal(
    resolveYoungPlateId(1, 0, 0, {
      userType: 16,
      userYType: 0,
      svipLevel: 5,
      busiVip: [
        { productType: 'svip', isVip: true, yType: 0 },
        { productType: 'tvip', isVip: true, yType: 0 },
      ],
    }),
    9,
  );
  assert.deepEqual(
    commentChipsFromRaw({
      vip_type: 1,
      busi_vip: [
        { product_type: 'svip', is_vip: 1, y_type: 0 },
        { product_type: 'tvip', is_vip: 1 },
      ],
    }).map((chip) => chip.label),
    ['概念VIP'],
  );
  assert.deepEqual(
    commentChipsFromRaw({
      busi_vip: [{ product_type: 'tvip', is_vip: 1 }],
    }).map((chip) => chip.label),
    ['畅听VIP'],
  );
});
