/**
 * 播放引擎上报的媒体时间轴能力（来自 native PlayerEvent.capabilities）。
 *
 * - `live`    直播流（HLS live 等）：时长未知、不可 seek，暂停恢复需重新拉流
 * - `finite`  有限时长（常规曲目）
 * - `unknown` 引擎无法判定（保持既有行为）
 */
export type MediaTimelineKind = 'live' | 'finite' | 'unknown';

export interface MediaCapabilitiesInfo {
  timelineKind: MediaTimelineKind;
  seekable: boolean;
}
