import { userIdentity } from './helpers/user-identity.mjs';
import { userSession } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as profileStats from '../src/shared/profileStats.ts';
import * as accountVip from '../src/renderer/utils/accountVip.ts';

const { descriptor } = parse(
  readFileSync('src/renderer/layouts/SidebarAccountPopover.vue', 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'account-popover' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
function fixture(t, detail = {}, vip = {}) {
  const calls = [];
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 1,
    info: { userid: 1, extendsInfo: { detail, vip } },
    fetchUserInfoOnce: () => calls.push('info'),
    fetchGradeInfo: () => calls.push('grade'),
    logout: () => calls.push('logout'),
  });
  const route = vue.reactive({ fullPath: '/main/home' });
  const deps = {
    '@/utils/userSession': userSession,
    vue,
    'vue-router': {
      useRoute: () => route,
      useRouter: () => ({ push: (path) => calls.push(path) }),
    },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/loginDevices': {
      useLoginDeviceStore: () => ({ reset: () => calls.push('reset-devices') }),
    },
    '../../shared/profileStats': profileStats,
    '@/utils/accountVip': accountVip,
    '@/utils/userIdentity': userIdentity,
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => deps[name] ?? {}, mod, mod.exports);
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const api = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  return { api, user, route, calls };
}

test('account summary preserves zero counts, hides missing values and uses existing grade semantics', (t) => {
  const { api } = fixture(
    t,
    {
      friends: 0,
      follows: 25,
      p_grade: 5,
      p_current_point: 620,
      p_next_grade: 6,
      p_next_grade_point: 1000,
    },
    {
      busi_vip: [
        { product_type: 'svip', is_vip: 1, vip_end_time: '2026-12-31T12:00:00' },
        { product_type: 'tvip', is_vip: 0 },
      ],
    },
  );
  assert.deepEqual(api.stats.value, [
    { label: '好友', value: '0' },
    { label: '关注', value: '25' },
  ]);
  assert.equal(api.grade.value.percent, 62);
  assert.equal(api.grade.value.remaining, 380);
  assert.deepEqual(api.memberships.value, [
    { type: 'svip', label: '概念会员', expires: '2026-12-31 到期' },
  ]);
});

test('membership expiry lists all active tiers in priority order using their own date fields', (t) => {
  const { api } = fixture(
    t,
    {},
    {
      user_type: 29,
      vip_type: 6,
      su_vip_end_time: '2027-10-09T12:00:00',
      vip_end_time: '2026-11-10T12:00:00',
      busi_vip: [
        { product_type: 'tvip', is_vip: 1, vip_end_time: '2026-12-12T12:00:00' },
        { product_type: 'svip', is_vip: '1', vip_end_time: '2026-12-11T12:00:00' },
      ],
    },
  );
  assert.deepEqual(api.memberships.value, [
    { type: 'suvip', label: '超级VIP', expires: '2027-10-09 到期' },
    { type: 'dvip', label: '豪华VIP', expires: '2026-11-10 到期' },
    { type: 'svip', label: '概念会员', expires: '2026-12-11 到期' },
    { type: 'tvip', label: '畅听会员', expires: '2026-12-12 到期' },
  ]);
});

test('deluxe alone never shows super expiry and unknown dates do not invent an expiry', (t) => {
  const { api, user } = fixture(
    t,
    {},
    {
      user_type: 13,
      vip_type: 6,
      su_vip_end_time: '2027-10-09T12:00:00',
      vip_end_time: 'invalid-date',
    },
  );
  assert.deepEqual(api.memberships.value, [{ type: 'dvip', label: '豪华VIP', expires: '已开通' }]);
  user.info.extendsInfo.vip = { user_type: 16 };
  assert.deepEqual(api.memberships.value, [{ type: 'suvip', label: '超级VIP', expires: '已开通' }]);
});

test('membership display follows refreshed profile data and clears when the account is removed', (t) => {
  const { api, user } = fixture(t, {}, { user_type: 16, vip_type: 6 });
  assert.equal(api.memberships.value.length, 2);
  user.info = {
    userid: 2,
    extendsInfo: {
      vip: {
        vip_type: 6,
        user_type: 0,
        vip_end_time: '2026-12-31T12:00:00',
      },
    },
  };
  assert.deepEqual(api.memberships.value, [
    { type: 'dvip', label: '豪华VIP', expires: '2026-12-31 到期' },
  ]);
  user.info = null;
  assert.deepEqual(api.memberships.value, []);
});

test('account or route changes close account surfaces; logged out opens do not fetch', async (t) => {
  const { api, user, route, calls } = fixture(t);
  api.open.value = true;
  await vue.nextTick();
  assert.deepEqual(calls, ['info', 'grade']);
  api.requestLogout();
  assert.equal(api.confirmLogout.value, true);
  user.accountRevision++;
  await vue.nextTick();
  assert.equal(api.confirmLogout.value, false);
  api.open.value = true;
  await vue.nextTick();
  route.fullPath = '/main/profile';
  await vue.nextTick();
  assert.equal(api.open.value, false);
  user.isLoggedIn = false;
  calls.length = 0;
  api.open.value = true;
  await vue.nextTick();
  assert.deepEqual(calls, []);
});

test('logout waits for confirmation and profile navigation closes the popover', (t) => {
  const { api, calls } = fixture(t);
  api.requestLogout();
  assert.deepEqual(calls, []);
  api.logout();
  assert.deepEqual(calls, ['reset-devices', 'logout', '/main']);
  calls.length = 0;
  api.open.value = true;
  api.navigate('/main/profile');
  assert.equal(api.open.value, false);
  assert.deepEqual(calls, ['/main/profile']);
});

test('popover identity follows the current account, student info and logout', (t) => {
  const { api, user } = fixture(t, { kq_talent: 32, auth_info: '歌词制作达人' }, { user_type: 16 });
  user.info.extendsInfo.identity = { student_status: 1, tags: '流行、安静' };
  assert.deepEqual(
    api.identity.value.badges.map((badge) => badge.label),
    ['学生', '歌词制作达人'],
  );
  assert.deepEqual(api.identity.value.tags, ['流行', '安静']);
  assert.match(api.identity.value.avatarIcon, /20180627153930257837/);
  user.info = { userid: 2, extendsInfo: { detail: { kq_talent: 0 } } };
  assert.deepEqual(api.identity.value.badges, []);
  assert.equal(api.identity.value.avatarIcon, '');
  user.isLoggedIn = false;
  assert.equal(api.identity.value.membership, null);
});
