import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userIdentity } from './helpers/user-identity.mjs';
const { getUserIdentity, getAccountIdentity } = userIdentity;
const labels = (identity) => identity.badges.map((badge) => badge.label);

test('account detail and student info combine without turning visibility or unrelated grades into identity', () => {
  const identity = getAccountIdentity({
    extendsInfo: {
      detail: {
        auth_info: '歌词制作达人',
        auth_info_talent: '歌词制作达人',
        kq_talent: 32,
        biz_status: 1,
      },
      identity: {
        student_status: 1,
        student_school: '测试学校',
        student_expire_time: '2027-01-01',
        tags: '流行、摇滚,流行',
      },
    },
  });
  assert.deepEqual(labels(identity), ['学生', '认证', '歌词制作达人']);
  assert.match(identity.avatarIcon, /20180627153930257837/);
  assert.equal(identity.studentSchool, '测试学校');
  assert.deepEqual(identity.tags, ['流行', '摇滚']);
  assert.deepEqual(
    labels(getUserIdentity({ student_visible: 1, iden: 8, identity: 47, svip_level: 8 })),
    [],
  );
  assert.equal(getUserIdentity({ kq_talent: -1, student_status: 0 }).avatarIcon, '');
});

test('live follow field shapes preserve multiple talent bits and singer identity', () => {
  const identity = getUserIdentity({ kq_talent: 66, is_star: 1, iden_type: 1, vip_type: 0 }, true);
  assert.deepEqual(labels(identity), ['歌手', '评论达人', '音频主播']);
  assert.match(identity.avatarIcon, /20180627153852371280/);
  assert.equal(getUserIdentity({ kq_talent: 0, is_star: -1 }).avatarIcon, '');
});

test('social VIP fields use super bit and classic deluxe value with music-pack fallback', () => {
  assert.deepEqual(labels(getUserIdentity({ vip_type: 6, user_type: 13, m_type: 1 }, true)), [
    '豪华VIP',
  ]);
  assert.deepEqual(labels(getUserIdentity({ vip_type: 6, user_type: 16 }, true)), ['超级VIP']);
  assert.deepEqual(labels(getUserIdentity({ m_type: 1 }, true)), ['音乐包']);
  assert.deepEqual(
    labels(getUserIdentity({ busi_vip: [{ product_type: 'svip', is_vip: 1 }] }, true)),
    ['概念VIP'],
  );
  assert.deepEqual(labels(getUserIdentity({ svip_level: 8, user_type: 0 }, true)), []);
});

test('comment identity icon remains authoritative and empty refreshed student state clears old labels', () => {
  const identity = getUserIdentity({
    vinfo9: { pic: 'https://example.com/mark.png', auth_info: '音乐制作人', actor_status: 1 },
  });
  assert.equal(identity.avatarIcon, 'https://example.com/mark.png');
  assert.deepEqual(labels(identity), ['演员', '音乐制作人']);
  const account = getAccountIdentity({
    extendsInfo: {
      detail: { student_status: 1 },
      identity: { student_status: 0, student_school: '', tags: '' },
    },
  });
  assert.deepEqual(labels(account), []);
  assert.equal(account.studentSchool, '');
});

test('explicit talent description takes precedence over fallback bit labels', () => {
  const identity = getUserIdentity({ kq_talent: 32, auth_info: '酷狗超人：曲库达人' });
  assert.deepEqual(labels(identity), ['酷狗超人：曲库达人']);
  assert.match(identity.avatarIcon, /20180627153930257837/);
});
