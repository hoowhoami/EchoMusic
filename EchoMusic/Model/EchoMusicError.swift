//
//  EchoMusicError.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/17.
//

import Foundation

/// EchoMusic 通用错误枚举
/// 统一处理音乐服务和播放器相关的所有错误
enum EchoMusicError: LocalizedError {
    case invalidHash
    case urlNotAvailable
    case needBuy
    case networkError(String)
    case copyrightRestricted
    case unknownError
    
    var errorDescription: String? {
        switch self {
        case .invalidHash:
            return "歌曲标识无效"
        case .urlNotAvailable:
            return "无法获取播放链接"
        case .needBuy:
            return "该歌曲/音质可能需要购买后才能播放"
        case .networkError(let message):
            return "网络错误: \(message)"
        case .copyrightRestricted:
            return "该歌曲暂无版权无法播放"
        case .unknownError:
            return "未知错误"
        }
    }
    
    /// 详细错误信息，用于开发调试或用户详细查看
    var detailedDescription: String {
        switch self {
        case .invalidHash:
            return "歌曲的唯一标识符(hash)无效或为空，无法请求播放链接。这通常是歌曲数据不完整导致的。"
        case .urlNotAvailable:
            return "服务器无法提供该歌曲的播放链接。可能原因：1) 歌曲已下架 2) 服务器暂时无法提供该音质 3) 文件格式不支持播放。"
        case .needBuy:
            return "该歌曲或所选音质需要付费购买才能播放。请尝试降低音质或购买该歌曲。"
        case .networkError(let message):
            return "网络连接出现问题：\(message)。请检查网络连接状态，或稍后重试。"
        case .copyrightRestricted:
            return "该歌曲因版权限制无法播放。这可能是由于地区限制或版权协议导致的。"
        case .unknownError:
            return "发生了未知错误。如果问题持续出现，请尝试重启应用或联系技术支持。"
        }
    }
    
    /// 用户友好的错误提示
    var userFriendlyMessage: String {
        switch self {
        case .invalidHash:
            return "歌曲信息异常"
        case .urlNotAvailable:
            return "歌曲暂时无法播放"
        case .needBuy:
            return "需要购买该歌曲"
        case .networkError(_):
            return "网络连接异常"
        case .copyrightRestricted:
            return "版权限制无法播放"
        case .unknownError:
            return "播放失败"
        }
    }
    
    /// 错误图标
    var iconName: String {
        switch self {
        case .invalidHash:
            return "exclamationmark.triangle.fill"
        case .urlNotAvailable:
            return "wifi.slash"
        case .needBuy:
            return "creditcard.fill"
        case .networkError(_):
            return "wifi.exclamationmark"
        case .copyrightRestricted:
            return "lock.fill"
        case .unknownError:
            return "xmark.circle.fill"
        }
    }
}