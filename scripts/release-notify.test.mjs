import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changelogSummary, notifyRelease } from './release-notify.mjs';

const markdown = `## [1.2.3-beta.1] - 2026-11-11
### 新增
- A < B & C
- 第二项
- 第三项
### 优化
- 性能
### 修复
- 一个修复
- 另一个修复
- 第三个修复
## [1.2.3]
### 修复
- 基础版本
## [1.2.2]
### 新增
- 旧内容
`;

test('summary selects the exact prerelease and caps highlights while counting all entries', () => {
  const summary = changelogSummary(markdown, 'v1.2.3-beta.1');
  assert.match(summary, /^新增 3 · 优化 1 · 修复 3/);
  assert.equal(summary.split('\n').length, 6);
  assert.ok(!summary.includes('第三项'));
  assert.ok(!summary.includes('基础版本'));
  assert.ok(!summary.includes('旧内容'));
  assert.match(changelogSummary(markdown, 'v1.2.3-beta.2'), /基础版本/);
  assert.equal(changelogSummary(markdown, 'v9.0.0'), '完整更新内容请查看 Release');
});

test('summary ignores fenced examples and bounds long Unicode highlights', () => {
  const summary = changelogSummary(
    '## [1.0.0]\n### 新增\n```\n## [2.0.0]\n- 假条目\n```\n- ' + '🎉'.repeat(400),
    'v1.0.0',
  );
  assert.match(summary, /^新增 1/);
  assert.equal(Array.from(summary.split('\n')[1]).length, 183);
});

async function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-notify-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const changelog = path.join(directory, 'CHANGELOG.md');
  fs.writeFileSync(changelog, markdown);
  return {
    RELEASE_PRODUCT: 'EchoMusicNext',
    RELEASE_TAG: 'v1.2.3-beta.1',
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: 'hoowhoami/EchoMusicNext',
    ECHO_CHANGELOG_FILE: changelog,
    ...overrides,
  };
}
const telegram = { TELEGRAM_BOT_TOKEN: 'private-token', TELEGRAM_CHAT_ID: '-100123' };
const qq = {
  QQ_BOT_APP_ID: 'test-app',
  QQ_BOT_APP_SECRET: 'private-secret',
  QQ_GROUP_OPENID: 'group-openid',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('Telegram escapes HTML and uses the published tag for manual publication', async (t) => {
  const env = await setup(t, { ...telegram, TELEGRAM_TOPIC_ID: '42' });
  let count = 0;
  await notifyRelease('telegram', {
    env,
    log() {},
    fetchImpl: async (url, options) => {
      count++;
      assert.equal(url, 'https://api.telegram.org/botprivate-token/sendMessage');
      const body = JSON.parse(options.body);
      assert.equal(body.message_thread_id, 42);
      assert.equal(body.parse_mode, 'HTML');
      assert.match(body.text, /A &lt; B &amp; C/);
      assert.match(body.text, /EchoMusicNext v1.2.3-beta.1/);
      assert.match(body.text, /releases\/tag\/v1.2.3-beta.1/);
      assert.ok(!body.text.includes('/tag/main'));
      return json({ ok: true });
    },
  });
  assert.equal(count, 1);
});

test('QQ authenticates then sends an official proactive group message', async (t) => {
  const env = await setup(t, {
    ...qq,
    RELEASE_PRODUCT: 'EchoMusic',
    GITHUB_REPOSITORY: 'hoowhoami/EchoMusic',
  });
  const calls = [];
  await notifyRelease('qq', {
    env,
    log() {},
    fetchImpl: async (url, options) => {
      calls.push(url);
      const body = JSON.parse(options.body);
      if (calls.length === 1) {
        assert.equal(url, 'https://api.bot.qq.com/app/getAppAccessToken');
        assert.deepEqual(body, { appId: 'test-app', clientSecret: 'private-secret' });
        return json({ access_token: 'ephemeral-token', expires_in: 7200 });
      }
      assert.equal(url, 'https://api.bot.qq.com/v2/groups/group-openid/messages');
      assert.equal(options.headers.Authorization, 'QQBot ephemeral-token');
      assert.equal(body.msg_type, 0);
      assert.equal(body.msg_id, undefined);
      assert.equal(body.event_id, undefined);
      assert.match(body.content, /EchoMusic v1.2.3-beta.1/);
      assert.match(body.content, /A < B & C/);
      return json({ id: 'message-id' });
    },
  });
  assert.equal(calls.length, 2);
});

test('unconfigured channels skip; partial configuration and invalid topics fail before network access', async (t) => {
  const fetchImpl = () => assert.fail('unexpected network request');
  const logs = [];
  await notifyRelease('qq', { env: {}, fetchImpl, log: (line) => logs.push(line) });
  assert.match(logs[0], /notification skipped/);
  await assert.rejects(
    notifyRelease('qq', { env: { QQ_BOT_APP_ID: 'test-app' }, fetchImpl }),
    /QQ_BOT_APP_SECRET, QQ_GROUP_OPENID/,
  );
  await assert.rejects(
    notifyRelease('telegram', {
      env: await setup(t, { ...telegram, TELEGRAM_TOPIC_ID: 'oops' }),
      fetchImpl,
    }),
    /positive integer/,
  );
});

test('API and transport failures do not retry writes or disclose secrets', async (t) => {
  const env = await setup(t, { ...telegram, ...qq });
  await assert.rejects(
    notifyRelease('qq', {
      env,
      fetchImpl: async () => json({ code: 100016, message: 'private-secret invalid' }),
    }),
    (error) => error.message.includes('100016') && !error.message.includes('private-secret'),
  );
  await assert.rejects(
    notifyRelease('telegram', {
      env,
      fetchImpl: async () => json({ ok: false, description: 'denied' }),
    }),
    /denied/,
  );
  let count = 0;
  await assert.rejects(
    notifyRelease('telegram', {
      env,
      fetchImpl: async () => {
        count++;
        throw new Error('private-token');
      },
    }),
    (error) => !error.message.includes('private-token'),
  );
  assert.equal(count, 1);
  await assert.rejects(
    notifyRelease('qq', { env, fetchImpl: async () => json({}) }),
    /missing access_token/,
  );
  count = 0;
  await assert.rejects(
    notifyRelease('qq', {
      env,
      fetchImpl: async () =>
        ++count === 1
          ? json({ access_token: 'ephemeral-token' })
          : json(
              { err_code: 304046, message: 'proactive messages disabled; ephemeral-token' },
              403,
            ),
    }),
    (error) => error.message.includes('304046') && !error.message.includes('ephemeral-token'),
  );
  assert.equal(count, 2);
  await assert.rejects(
    notifyRelease('telegram', {
      env,
      fetchImpl: async () => new Response('<html>error</html>', { status: 502 }),
    }),
    /HTTP 502, invalid JSON/,
  );
});

test('QQ sends once per distinct group and reuses one access token', async (t) => {
  for (const [secondGroup, expectedGroups] of [
    [' second-group ', ['group-openid', 'second-group']],
    [' group-openid ', ['group-openid']],
    ['   ', ['group-openid']],
  ]) {
    const calls = [];
    await notifyRelease('qq', {
      env: await setup(t, { ...qq, QQ_GROUP_OPENID_2: secondGroup }),
      log() {},
      fetchImpl: async (url, options) => {
        calls.push(url);
        if (calls.length === 1) return json({ access_token: 'ephemeral-token' });
        assert.equal(options.headers.Authorization, 'QQBot ephemeral-token');
        return json({ id: 'message-id' });
      },
    });
    assert.deepEqual(calls, [
      'https://api.bot.qq.com/app/getAppAccessToken',
      ...expectedGroups.map((group) => `https://api.bot.qq.com/v2/groups/${group}/messages`),
    ]);
  }
});

test('QQ attempts the other group after failure without retries or leaking identifiers', async (t) => {
  for (const failedGroup of [1, 2]) {
    const calls = [];
    const logs = [];
    await assert.rejects(
      notifyRelease('qq', {
        env: await setup(t, { ...qq, QQ_GROUP_OPENID_2: ' second-group ' }),
        log: (line) => logs.push(line),
        fetchImpl: async (url) => {
          calls.push(url);
          if (calls.length === 1) return json({ access_token: 'ephemeral-token' });
          if (calls.length - 1 === failedGroup)
            return json(
              {
                err_code: 304046,
                message: 'group-openid second-group ephemeral-token private-secret denied',
              },
              403,
            );
          return json({ id: 'message-id' });
        },
      }),
      (error) => {
        assert.match(error.message, /304046/);
        for (const value of ['group-openid', 'second-group', 'ephemeral-token', 'private-secret'])
          assert.ok(!error.message.includes(value));
        return true;
      },
    );
    assert.equal(calls.length, 3);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /: sent$/);
  }
});

test('configuring only the optional QQ group fails before network access', async () => {
  await assert.rejects(
    notifyRelease('qq', {
      env: { QQ_GROUP_OPENID_2: 'second-group' },
      fetchImpl: () => assert.fail('unexpected network request'),
    }),
    /Missing notification secrets: QQ_BOT_APP_ID, QQ_BOT_APP_SECRET, QQ_GROUP_OPENID/,
  );
});
