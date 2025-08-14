//
//  MusicService.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

/// 音乐服务 - 处理歌曲URL获取和网络请求
class MusicService: ObservableObject {
    static let shared = MusicService()
    
    /// URL缓存，避免重复请求
    private var urlCache: [String: String] = [:]
    
    private init() {}
    
    // MARK: - URL获取相关方法
    
    /// 处理URL，确保格式正确
    private func processURL(_ urlString: String) -> String {
        var processedURL = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        
        // 确保URL有协议前缀
        if !processedURL.hasPrefix("http://") && !processedURL.hasPrefix("https://") {
            processedURL = "http://" + processedURL
        }
        
        return processedURL
    }
    
    /// 获取歌曲播放URL
    /// - Parameters:
    ///   - song: 歌曲信息
    ///   - quality: 音质选择
    ///   - qualityCompatibility: 兼容模式设置
    ///   - freePart: 是否只获取试听部分
    /// - Returns: 播放URL字符串
    func getSongURL(for song: Song, quality: AudioQuality, qualityCompatibility: Bool, freePart: Bool = false) async throws -> String? {
        guard let hash = song.hash else {
            throw MusicServiceError.invalidHash
        }
        
        let cacheKey = "\(hash)_\(quality.rawValue)_\(freePart ? "free" : "full")_\(qualityCompatibility ? "compat" : "direct")"
        
        // 检查缓存
        if let cachedURL = urlCache[cacheKey] {
            return cachedURL
        }
        
        // 构建请求参数
        var params: [String: String] = [
            "hash": hash
        ]
        
        // 处理音质参数 (兼容模式关闭且选择的是lossless或hires)
        if !qualityCompatibility {
            switch quality {
            case .lossless:
                params["quality"] = "flac"
            case .hires:
                params["quality"] = "high"
            default:
                break
            }
        }
        
        // 传递 album_id 和 album_audio_id 参数可能导致某些歌曲获取不到播放地址
        
        // 处理试听模式或未登录用户
        if freePart || !UserService.shared.isLoggedIn {
            params["free_part"] = "1"
        }
        
        do {
            let response: SongURLResponse = try await NetworkService.shared.get(
                endpoint: "/song/url",
                params: params,
                responseType: SongURLResponse.self
            )
            
            // 判断格式
            if response.extName == "mp4" {
                throw MusicServiceError.urlNotAvailable
            }
            
            // 处理版权提示
            if response.status == 3 {
                throw MusicServiceError.copyrightRestricted
            }
            
            if response.status == 1 {
                // 优先使用主URL列表的第一个
                if let urls = response.url, !urls.isEmpty, let firstURL = urls.first, !firstURL.isEmpty {
                    let processedURL = processURL(firstURL)
                    // 缓存URL
                    urlCache[cacheKey] = processedURL
                    return processedURL
                }
                
                // 如果主URL不可用，尝试备用URL
                if let backupUrls = response.backupUrl, !backupUrls.isEmpty, let firstBackupURL = backupUrls.first, !firstBackupURL.isEmpty {
                    let processedURL = processURL(firstBackupURL)
                    // 缓存URL
                    urlCache[cacheKey] = processedURL
                    return processedURL
                }
                
                // 如果请求的音质不可用，尝试降级到普通音质
                if quality != .normal {
                    return try await getSongURL(for: song, quality: .normal, qualityCompatibility: qualityCompatibility, freePart: freePart)
                }
                throw MusicServiceError.urlNotAvailable
            } else {
                throw MusicServiceError.urlNotAvailable
            }
        } catch let error as NetworkError {
            throw MusicServiceError.networkError(error.localizedDescription)
        } catch {
            throw error
        }
    }
    
    /// 获取多个音质的URL（用于音质选择）
    func getAvailableQualities(for song: Song, qualityCompatibility: Bool) async -> [AudioQuality: String] {
        var availableURLs: [AudioQuality: String] = [:]
        
        // 按优先级测试音质
        let priorityQualities: [AudioQuality] = [.normal, .high, .lossless, .hires]
        
        for quality in priorityQualities {
            do {
                if let url = try await getSongURL(for: song, quality: quality, qualityCompatibility: qualityCompatibility) {
                    availableURLs[quality] = url
                }
            } catch {
                // 忽略单个音质获取失败
                continue
            }
        }
        
        return availableURLs
    }
    
    /// 清理URL缓存
    func clearURLCache() {
        urlCache.removeAll()
    }
}

// MARK: - 错误定义

enum MusicServiceError: LocalizedError {
    case invalidHash
    case urlNotAvailable
    case networkError(String)
    case copyrightRestricted
    case unknownError
    
    var errorDescription: String? {
        switch self {
        case .invalidHash:
            return "歌曲标识无效"
        case .urlNotAvailable:
            return "无法获取播放链接"
        case .networkError(let message):
            return "网络错误: \(message)"
        case .copyrightRestricted:
            return "该歌曲暂无版权，无法播放"
        case .unknownError:
            return "未知错误"
        }
    }
}
