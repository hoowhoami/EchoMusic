//
//  Song.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//
import SwiftUI

/// 音质选项枚举
enum AudioQuality: String, CaseIterable {
    case _128 = "128" // 128 码率 mp3
    case _320 = "320" // 320 码率 mp3
    case flac // flac 格式音频
    case high // 无损格式音频
    case viper_clear // 蝰蛇超清音质
    
    var displayName: String {
        switch self {
        case ._128: return "128Kbps"
        case ._320: return "320Kbps"
        case .flac: return "flac"
        case .high: return "high"
        case .viper_clear: return "viper"
        }
    }
    
    var description: String {
        switch self {
        case ._128: return "128码率mp3"
        case ._320: return "320码率mp3"
        case .flac: return "flac音频"
        case .high: return "无损音频"
        case .viper_clear: return "蝰蛇超清音质"
        }
    }
}

/// 歌曲URL响应模型
struct SongURLResponse: Codable {
    let status: Int?
    let url: [String]?
    let backupUrl: [String]?
    let hash: String?
    let std_hash: String?
    let fileName: String?
    let fileSize: Int?
    let bitRate: Int?
    let timeLength: Int?
    let extName: String?
    let volume: Double?
    let trans_param: TransParam?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.url = c[safe: .url]
        self.backupUrl = c[safe: .backupUrl]
        self.hash = c[safe: .hash]
        self.std_hash = c[safe: .std_hash]
        self.fileName = c[safe: .fileName]
        self.fileSize = c[safe: .fileSize]
        self.bitRate = c[safe: .bitRate]
        self.timeLength = c[safe: .timeLength]
        self.extName = c[safe: .extName]
        self.volume = c[safe: .volume]
        self.trans_param = c[safe: .trans_param]
    }
    
    private enum CodingKeys: String, CodingKey {
        case status, url, backupUrl, hash
        case std_hash, fileName, fileSize, bitRate, timeLength, extName, volume, trans_param
    }
}

struct TransParam: Codable {
    let union_cover: String?
    let language: String?
    let qualitymap: QualityMap?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.union_cover = c[safe: .union_cover]
        self.language = c[safe: .language]
        self.qualitymap = c[safe: .qualitymap]
    }
    
    private enum CodingKeys: String, CodingKey {
        case union_cover, language, qualitymap
    }
}

struct QualityMap: Codable {
    let attr0: Int?
    let attr1: Int?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.attr0 = c[safe: .attr0]
        self.attr1 = c[safe: .attr1]
    }
}

/// 歌曲数据模型
struct Song: Identifiable, Codable, Equatable {
    // 使用hash作为唯一标识
    var id: String { return hash ?? "" }
    
    let title: String? // 歌曲名
    let originalTitle: String? // 原始歌曲名
    let artist: String? // 歌手
    let album: String? // 专辑
    let cover: String? // 封面图名称（本地 Assets 或网络地址）
    let hash: String? // 歌曲哈希值，用于去重和唯一标识
    let duration: Int? // 歌曲时长（秒）
    let albumId: String? // 专辑ID（用于获取URL）
    let albumAudioId: String? // 专辑音频ID
    
    // 音质标识
    let isVip: Bool? // VIP标识
    let isHq: Bool? // HQ高音质标识
    let isSq: Bool? // SQ超品音质标识
    
    // 播放相关的运行时属性（不保存到持久化）
    var playableURL: String? // 当前可播放的URL
    var currentQuality: AudioQuality? // 当前音质
    
    // 用于去重的比较，基于 hash 或者 title + artist
    static func == (lhs: Song, rhs: Song) -> Bool {
        // 优先使用hash进行比较
        if let lhsHash = lhs.hash, let rhsHash = rhs.hash {
            return lhsHash == rhsHash
        }
        // 如果没有hash，则使用 title + artist 比较
        return lhs.title == rhs.title && lhs.artist == rhs.artist
    }
    
    // 安全解码初始化器
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.hash = c[safe: .hash]
        self.title = c[safe: .title]
        self.originalTitle = c[safe: .originalTitle]
        self.artist = c[safe: .artist]
        self.album = c[safe: .album]
        self.cover = c[safe: .cover]
        self.duration = c[safe: .duration]
        self.albumId = c[safe: .albumId]
        self.albumAudioId = c[safe: .albumAudioId]
        self.isVip = c[safe: .isVip]
        self.isHq = c[safe: .isHq]
        self.isSq = c[safe: .isSq]
        
        self.playableURL = nil
        self.currentQuality = nil
    }

    init(from track: PlaylistTrackInfo) {
        // 处理歌曲名称：如果包含 " - "，则取后半部分作为歌曲名
        let nameParts = (track.name ?? "未知歌曲").components(separatedBy: " - ")
        self.originalTitle = track.name ?? "未知歌曲"
        self.title = nameParts.count > 1 ? nameParts[1] : (track.name ?? "未知歌曲")
        
        self.artist = track.singername ?? "未知歌手"
        self.album = track.albumname ?? "未知专辑"
        // 保持原始URL，在需要时通过ImageURLHelper处理
        self.cover = track.album_img ?? ""
        self.hash = track.hash
        self.duration = track.duration
        self.albumId = track.album_id
        self.albumAudioId = track.audio_group_id
        
        // 根据音质数据设置标识
        self.isSq = (track.relate_goods?.count ?? 0) > 2
        self.isHq = (track.relate_goods?.count ?? 0) > 1
        self.isVip = track.privilege == 10
        
        self.playableURL = nil
        self.currentQuality = nil
    }
    
    // 原有的初始化器
    init(title: String, artist: String, album: String, cover: String, hash: String? = nil, duration: Int? = nil, albumId: String? = nil, albumAudioId: String? = nil, isVip: Bool = false, isHq: Bool = false, isSq: Bool = false) {
        self.title = title
        self.originalTitle = title
        self.artist = artist
        self.album = album
        self.cover = cover
        self.hash = hash
        self.duration = duration
        self.albumId = albumId
        self.albumAudioId = albumAudioId
        self.isVip = isVip
        self.isHq = isHq
        self.isSq = isSq
        self.playableURL = nil
        self.currentQuality = nil
    }
    
    /// 获取处理后的封面图片URL
    /// - Parameter size: 期望的图片尺寸
    /// - Returns: 处理后的URL
    func getCoverImageURL(size: ImageSize = .medium) -> URL? {
        return ImageURLHelper.processImageURL(cover, size: size)
    }
    
    private enum CodingKeys: String, CodingKey {
        case title, originalTitle, artist, album, cover, hash, duration, albumId, albumAudioId, isVip, isHq, isSq
        // playableURL和currentQuality不参与编码，因为它们是运行时属性
    }
}
