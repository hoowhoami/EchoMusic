import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const qqApi = 'https://api.bot.qq.com';
const required = {
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  qq: ['QQ_BOT_APP_ID', 'QQ_BOT_APP_SECRET', 'QQ_GROUP_OPENID'],
};
const escapeHtml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function changelogSummary(markdown, tag) {
  const version = tag.replace(/^v/, '');
  const sections = new Map();
  let lines;
  let fence;
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^##\s+\[?v?([^\]\s]+)\]?(?:\s|$)/.exec(line);
    if (heading) {
      lines = [];
      sections.set(heading[1], lines);
    } else lines?.push(line);
  }
  const selected = sections.get(version) || sections.get(version.split(/[-+]/)[0]);
  if (!selected) return '完整更新内容请查看 Release';
  const limits = { 新增: 2, 优化: 1, 修复: 2 };
  const counts = { 新增: 0, 优化: 0, 修复: 0 };
  const highlights = [];
  let category;
  for (const line of selected) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) category = heading[1];
    const bullet = /^-\s+(.+)/.exec(line);
    if (!bullet || !Object.hasOwn(counts, category)) continue;
    counts[category]++;
    if (counts[category] <= limits[category]) {
      const text = Array.from(bullet[1]);
      highlights.push(`• ${text.slice(0, 180).join('')}${text.length > 180 ? '…' : ''}`);
    }
  }
  if (!Object.values(counts).some(Boolean)) return '完整更新内容请查看 Release';
  return [`新增 ${counts.新增} · 优化 ${counts.优化} · 修复 ${counts.修复}`, ...highlights].join(
    '\n',
  );
}

export async function notifyRelease(
  channel,
  { env = process.env, fetchImpl = fetch, log = console.log } = {},
) {
  const names = required[channel];
  if (!names) throw new Error('Expected notification channel: telegram or qq');
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length === names.length && !(channel === 'qq' && env.QQ_GROUP_OPENID_2?.trim())) {
    log(`::warning::${channel} notification skipped: configure ${names.join(', ')}`);
    return;
  }
  if (missing.length) throw new Error(`Missing notification secrets: ${missing.join(', ')}`);
  const tag = env.RELEASE_TAG || env.GITHUB_REF_NAME;
  const repository = env.GITHUB_REPOSITORY;
  const product = env.RELEASE_PRODUCT;
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(tag || ''))
    throw new Error('Missing or invalid release tag');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ''))
    throw new Error('Missing or invalid release repository');
  if (!['EchoMusic', 'EchoMusicNext'].includes(product))
    throw new Error('Missing or invalid release product');
  const summary = changelogSummary(
    fs.readFileSync(env.ECHO_CHANGELOG_FILE || 'CHANGELOG.md', 'utf8'),
    tag,
  );
  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  const secrets = Object.entries(env)
    .filter(([name]) => /TOKEN|SECRET|OPENID|CHAT_ID|TOPIC_ID/.test(name))
    .map(([, value]) => value)
    .filter(Boolean);
  const safe = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/[\r\n]/g, ' ').slice(0, 300);
  };
  async function post(label, url, payload, headers = {}) {
    let response;
    try {
      // Never retry message POSTs: a timed-out request may already be delivered.
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Fetch errors can include Telegram's token-bearing request URL.
      throw new Error(`${label}: network request failed or timed out`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`${label}: HTTP ${response.status}, invalid JSON response`);
    }
    const code = data?.err_code ?? data?.code ?? 0;
    if (!response.ok || !data || typeof data !== 'object' || String(code) !== '0')
      throw new Error(
        `${label}: HTTP ${response.status}, code ${safe(code)}: ${safe(data?.message || data?.description || 'API rejected request')}`,
      );
    return data;
  }
  if (channel === 'telegram') {
    const payload = {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🎉 <b>${product} ${tag} 已发布</b>\n\n📋 <b>更新摘要</b>\n${escapeHtml(summary)}\n\n⬇️ <a href="${releaseUrl}">下载与完整更新</a>`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (env.TELEGRAM_TOPIC_ID?.trim()) {
      const topic = Number(env.TELEGRAM_TOPIC_ID);
      if (!Number.isSafeInteger(topic) || topic <= 0)
        throw new Error('TELEGRAM_TOPIC_ID must be a positive integer');
      payload.message_thread_id = topic;
    }
    const result = await post(
      'Telegram sendMessage',
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload,
    );
    if (result.ok !== true)
      throw new Error(
        `Telegram sendMessage: ${safe(result.description || 'API rejected request')}`,
      );
  } else {
    const result = await post('QQ access token', `${qqApi}/app/getAppAccessToken`, {
      appId: env.QQ_BOT_APP_ID,
      clientSecret: env.QQ_BOT_APP_SECRET,
    });
    if (typeof result.access_token !== 'string' || !result.access_token)
      throw new Error('QQ access token: response is missing access_token');
    secrets.push(result.access_token);
    const groupOpenids = [
      ...new Set(
        [env.QQ_GROUP_OPENID, env.QQ_GROUP_OPENID_2].map((value) => value?.trim()).filter(Boolean),
      ),
    ];
    secrets.push(...groupOpenids);
    const failures = [];
    for (const [index, groupOpenid] of groupOpenids.entries()) {
      const label = `QQ group message (${index + 1}/${groupOpenids.length})`;
      try {
        const sent = await post(
          label,
          `${qqApi}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
          {
            // Omit msg_id/event_id: release announcements are proactive messages.
            msg_type: 0,
            content: `🎉 ${product} ${tag} 已发布\n\n📋 更新摘要\n${summary}\n\n⬇️ 下载与完整更新\n${releaseUrl}`,
          },
          { Authorization: `QQBot ${result.access_token}` },
        );
        if (!sent.id) throw new Error(`${label}: response is missing message id`);
        log(`${label}: sent`);
      } catch (error) {
        // Attempt every group once, even when another group rejects the announcement.
        failures.push(safe(error.message));
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
  log(`${channel} release notification sent`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await notifyRelease(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
