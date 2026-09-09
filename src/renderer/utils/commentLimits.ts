// EchoMusic 的输入限制；不代表酷狗服务端的协议上限。
export const BARRAGE_MAX_LENGTH = 100;
export const COMMENT_MAX_LENGTH = 200;
export const countCommentCharacters = (text: string) => Array.from(text).length;
export function assertCommentLength(text: string, barrage = false) {
  const limit = barrage ? BARRAGE_MAX_LENGTH : COMMENT_MAX_LENGTH;
  if (countCommentCharacters(text) > limit) {
    throw new Error(`${barrage ? '弹幕' : '评论'}最多 ${limit} 字，请精简后再发送`);
  }
}
