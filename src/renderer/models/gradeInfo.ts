/**
 * 听歌等级信息（GET /user/grade/info）
 *
 * 服务端 user_grade_info.js 支持两种模式：
 *  - 查询（默认）：返回以下字段，用于刷新等级/积分展示
 *  - 上报：传入 d_sec + diff_sec，同步本地累计听歌时长（仅 lite/v2 协议记账）
 */
export interface GradeInfoData {
  /** 服务端累计听歌秒数 */
  d_sec?: number;
  /** 本次查询会话时长 */
  duration?: number;
  /** 当前等级 */
  p_grade?: number;
  /** 当前等级积分 */
  p_current_point?: number;
  /** 升级所需积分 */
  p_grade_point?: number;
  /** 下一等级 */
  p_next_grade?: number;
  /** 下一等级所需积分 */
  p_next_grade_point?: number;
  /** 服务端时间 */
  servertime?: string;
}

export interface GradeInfoResponse {
  status?: number;
  error_code?: number;
  data?: GradeInfoData | Record<string, unknown>;
  [key: string]: unknown;
}
