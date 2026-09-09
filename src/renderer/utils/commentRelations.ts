import type { Comment } from '@/models/comment';

const id = (value: unknown): string => {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) ? text : '';
};

// cmtlist 的 pid 指向主评论；hot_replylist 的 pid 则是楼层回复 ID。
export const mainCommentParentId = (comment: Comment) => {
  // 歌手回复可能同时带楼层 tid 与被回复对象 pid，优先使用接口明确给出的根楼层。
  const tid = id(comment.raw?.tid);
  if (tid && tid !== String(comment.id)) return tid;
  return id(comment.raw?.pid);
};
export const floorOriginalId = (comment: Comment) => id(comment.raw?.ori_cmt_id);

export function groupCommentRelations(comments: Comment[]) {
  const byId = new Map(comments.map((comment) => [String(comment.id), comment]));
  const replies = new Map<string, Comment[]>();
  const roots = comments.filter((comment) => {
    let parentId = mainCommentParentId(comment);
    if (!parentId) return true;
    const visited = new Set([String(comment.id)]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return true; // 分页尚未加载父评论时保留内容。
      const next = mainCommentParentId(parent);
      if (!next) {
        replies.set(parentId, [...(replies.get(parentId) ?? []), comment]);
        return false;
      }
      parentId = next;
    }
    return true;
  });
  return { roots, replies };
}

const replyTime = (comment: Comment): number => {
  const value = comment.time || comment.addTime || comment.addtime || '';
  // 酷狗返回北京时间；显式指定时区，避免系统时区和日期解析差异。
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '+08:00'
    : value;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

// 楼层接口记录优先，保留其真实 ID，后续回复需使用该 ID。
export function mergeFloorReplies(previews: Comment[], floors: Comment[]) {
  const originals = new Set(floors.map(floorOriginalId).filter(Boolean));
  const seen = new Set<string>();
  const unique = floors.filter((comment) => {
    const key = String(comment.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...unique, ...previews.filter((comment) => !originals.has(String(comment.id)))]
    .map((comment, index) => ({ comment, index, time: replyTime(comment) }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time < b.time ? -1 : 1))
    .map((item) => item.comment);
}

const splitReplyQuote = (content: string) => {
  const match = /\/\/@([^\r\n:：]+)[:：]([\s\S]*)/.exec(content);
  return match
    ? {
        body: content.slice(0, match.index).trimEnd(),
        userName: match[1],
        content: match[2],
      }
    : undefined;
};

/** Presentation only: never replace the original content or floor ID used by send. */
export function presentFloorReply(reply: Comment, floors: Comment[]) {
  const parentId = id(reply.raw?.pid);
  const parent = parentId && floors.find((item) => String(item.id) === parentId && item !== reply);
  const hasRelation = Boolean(
    parentId || Number(reply.raw?.is_reply) === 1 || floorOriginalId(reply),
  );
  const parsed = hasRelation ? splitReplyQuote(reply.content) : undefined;
  const quote = parent
    ? {
        userName: parent.userName,
        content: splitReplyQuote(parent.content)?.body ?? parent.content,
      }
    : parsed
      ? { userName: parsed.userName, content: parsed.content }
      : undefined;
  return { body: parsed?.body ?? reply.content, quote };
}
