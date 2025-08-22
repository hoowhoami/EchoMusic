//
//  SearchModels.swift
//  EchoMusic
//
//  Created on 2025/8/20.
//

import Foundation


// MARK: - 搜索类型枚举
enum SearchType: String, CaseIterable {
    case song = "song"          // 单曲
    case album = "album"        // 专辑
    case artist = "author"      // 歌手
    case playlist = "special"   // 歌单
    
    var displayName: String {
        switch self {
        case .song: return "单曲"
        case .album: return "专辑"
        case .artist: return "歌手"
        case .playlist: return "歌单"
        }
    }
}

// MARK: - 歌曲搜索结果模型
struct SearchSongResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    var data: SearchSongData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        
        // Try to decode each field with safe access
        self.status = try container.decodeIfPresent(Int.self, forKey: .status) ?? 0
        self.error_code = try container.decodeIfPresent(Int.self, forKey: .error_code) ?? 0
        self.error_msg = try container.decodeIfPresent(String.self, forKey: .error_msg)
        self.data = try container.decodeIfPresent(SearchSongData.self, forKey: .data)
    }
}

// MARK: - 搜索返回的歌曲模型（专门用于搜索API响应）
struct SearchSong: Codable, Identifiable {
    // 使用audioId作为唯一标识
    var id: Int { return Audioid ?? 0 }
    
    // 基本信息字段
    let Audioid: Int?
    let FileHash: String?
    let OriSongName: String?
    let FileName: String?
    let Duration: Int?
    let AlbumID: String?
    let AlbumName: String?
    let MixSongID: Int?
    
    // 歌手信息
    let SingerName: String?
    let Singers: [SearchSinger]?
    
    // 图片信息
    let Image: String?
    
    // 音质信息
    let HQ: QualityInfo?
    let SQ: QualityInfo?
    let Res: QualityInfo?
    
    // 其他信息
    let PayType: Int?
    let AlbumPrivilege: Int?
    let Bitrate: Int?
    let ExtName: String?
    let mvdata: [MvData]?
    let Suffix: String?
    let PublishDate: String?
    let OwnerCount: Int?
    let HeatLevel: Int?
    let TagContent: String?
    let TagDetails: [TagDetail]?
    let Grp: [SearchSong]?
    let trans_param: TransParam?
    let recommend_type: Int?
    
    // 便利属性
    var title: String? {
        if let fileName = FileName {
            // FileName格式通常是 "歌手 - 歌曲名"
            let components = fileName.components(separatedBy: " - ")
            if components.count >= 2 {
                return components[1]
            }
            return fileName
        }
        return OriSongName
    }
    
    var artist: String? {
        return SingerName
    }
    
    var album: String? {
        return AlbumName
    }
    
    var cover: String? {
        return Image
    }
    
    var hash: String? {
        return FileHash
    }
    
    var duration: Int? {
        return Duration
    }
    
    var albumId: String? {
        return AlbumID
    }
    
    var albumAudioId: Int? {
        return Audioid
    }
    
    var mixSongId: Int? {
        return MixSongID
    }
    
    var isVip: Bool? {
        return PayType == 3
    }
    
    var isSq: Bool? {
        return SQ != nil
    }
    
    var isHq: Bool? {
        return HQ != nil
    }
    
    enum CodingKeys: String, CodingKey {
        case Audioid
        case FileHash
        case OriSongName
        case FileName
        case Duration
        case AlbumID
        case AlbumName
        case MixSongID
        case SingerName
        case Singers
        case Image
        case HQ
        case SQ
        case Res
        case PayType
        case AlbumPrivilege
        case Bitrate
        case ExtName
        case mvdata
        case Suffix
        case PublishDate
        case OwnerCount
        case HeatLevel
        case TagContent
        case TagDetails
        case Grp
        case trans_param
        case recommend_type
    }
    
    // 转换为Song对象
    func toSong() -> Song {
        return Song(
            title: title ?? "未知歌曲",
            artist: artist ?? "未知歌手",
            album: album ?? "未知专辑",
            cover: cover ?? "",
            hash: hash,
            duration: duration,
            albumId: albumId,
            albumAudioId: albumAudioId,
            mixSongId: mixSongId,
            addMixSongId: nil,
            isVip: isVip ?? false,
            isHq: isHq ?? false,
            isSq: isSq ?? false
        )
    }
}

struct SearchSinger: Codable {
    let name: String?
    let ip_id: Int?
    let id: Int?
    
    enum CodingKeys: String, CodingKey {
        case name
        case ip_id
        case id
    }
}

struct QualityInfo: Codable {
    let FileSize: Int?
    let Hash: String?
    let Privilege: Int?
    
    enum CodingKeys: String, CodingKey {
        case FileSize
        case Hash
        case Privilege
    }
}

struct MvData: Codable {
    let typ: Int?
    let trk: String?
    let hash: String?
    let id: String?
    
    enum CodingKeys: String, CodingKey {
        case typ
        case trk
        case hash
        case id
    }
}

struct TagDetail: Codable {
    let content: String?
    let version: Int?
    let type: Int?
    
    enum CodingKeys: String, CodingKey {
        case content
        case version
        case type
    }
}

struct TransParam: Codable {
    let union_cover: String?
    let language: String?
    let classmap: [String: Int]?
    let cpy_attr0: Int?
    let musicpack_advance: Int?
    let display: Int?
    let display_rate: Int?
    let qualitymap: QualityMap?
    let ogg_128_hash: String?
    let ogg_128_filesize: Int?
    let ogg_320_hash: String?
    let ogg_320_filesize: Int?
    let cid: Int?
    let ipmap: Int?
    let hash_multitrack: String?
    let pay_block_tpl: Int?
    let cpy_grade: Int?
    let cpy_level: Int?
    let songname_suffix: String?
    let hash_offset: HashOffset?
    
    enum CodingKeys: String, CodingKey {
        case union_cover
        case language
        case classmap
        case cpy_attr0
        case musicpack_advance
        case display
        case display_rate
        case qualitymap
        case ogg_128_hash
        case ogg_128_filesize
        case ogg_320_hash
        case ogg_320_filesize
        case cid
        case ipmap
        case hash_multitrack
        case pay_block_tpl
        case cpy_grade
        case cpy_level
        case songname_suffix
        case hash_offset
    }
}

struct HashOffset: Codable {
    let clip_hash: String?
    let start_byte: Int?
    let end_ms: Int?
    let end_byte: Int?
    let file_type: Int?
    let start_ms: Int?
    let offset_hash: String?
    
    enum CodingKeys: String, CodingKey {
        case clip_hash
        case start_byte
        case end_ms
        case end_byte
        case file_type
        case start_ms
        case offset_hash
    }
}

struct QualityMap: Codable {
    let attr0: Int?
    let attr1: Int?
    
    enum CodingKeys: String, CodingKey {
        case attr0
        case attr1
    }
}

struct SearchSongData: Codable {
    var lists: [SearchSong]?
    let correctiontip: String?
    let pagesize: Int?
    let isshareresult: Int?
    let istagresult: Int?
    let page: Int?
    let correctiontype: Int?
    let correctionrelate: String?
    let AlgPath: String?
    let from: Int?
    var total: Int?
    let istag: Int?
    
    enum CodingKeys: String, CodingKey {
        case lists
        case correctiontip
        case pagesize
        case isshareresult
        case istagresult
        case page
        case correctiontype
        case correctionrelate
        case AlgPath
        case from
        case total
        case istag
    }
}

// MARK: - 歌单搜索结果模型
struct SearchPlaylistResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    var data: SearchPlaylistData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
}

struct SearchPlaylistData: Codable {
    var lists: [Playlist]?
    let correctiontip: String?
    let pagesize: Int?
    let isshareresult: Int?
    let istagresult: Int?
    let page: Int?
    let correctiontype: Int?
    let correctionrelate: String?
    let AlgPath: String?
    let from: Int?
    var total: Int?
    let istag: Int?
    
    enum CodingKeys: String, CodingKey {
        case lists
        case correctiontip
        case pagesize
        case isshareresult
        case istagresult
        case page
        case correctiontype
        case correctionrelate
        case AlgPath
        case from
        case total
        case istag
    }
}

// MARK: - 专辑搜索结果模型
struct SearchAlbumResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    var data: SearchAlbumData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
}

struct SearchAlbumData: Codable {
    var lists: [Album]?
    let correctiontip: String?
    let pagesize: Int?
    let isshareresult: Int?
    let istagresult: Int?
    let page: Int?
    let correctiontype: Int?
    let correctionrelate: String?
    let AlgPath: String?
    let from: Int?
    var total: Int?
    let istag: Int?
    
    enum CodingKeys: String, CodingKey {
        case lists
        case correctiontip
        case pagesize
        case isshareresult
        case istagresult
        case page
        case correctiontype
        case correctionrelate
        case AlgPath
        case from
        case total
        case istag
    }
}

// MARK: - 歌手搜索结果模型
struct SearchArtistResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    var data: SearchArtistData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
}

struct SearchArtistData: Codable {
    var lists: [Artist]?
    let correctiontip: String?
    let pagesize: Int?
    let isshareresult: Int?
    let istagresult: Int?
    let page: Int?
    let correctiontype: Int?
    let correctionrelate: String?
    let AlgPath: String?
    let from: Int?
    var total: Int?
    let istag: Int?
    
    enum CodingKeys: String, CodingKey {
        case lists
        case correctiontip
        case pagesize
        case isshareresult
        case istagresult
        case page
        case correctiontype
        case correctionrelate
        case AlgPath
        case from
        case total
        case istag
    }
}

// MARK: - 综合搜索结果模型
struct ComplexSearchResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    let data: ComplexSearchData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
}

struct ComplexSearchData: Codable {
    let songs: [Song]?
    let artists: [Artist]?
    let playlists: [Playlist]?
    let albums: [Album]?
    
    enum CodingKeys: String, CodingKey {
        case songs = "songs"
        case artists = "artists"
        case playlists = "playlists"
        case albums = "albums"
    }
}

struct ComplexSearchContent: Codable {
    let songs: [Song]?
    let artists: [Artist]?
    let playlists: [Playlist]?
    let albums: [Album]?
    
    enum CodingKeys: String, CodingKey {
        case songs = "songs"
        case artists = "artists"
        case playlists = "playlists"
        case albums = "albums"
    }
}


// MARK: - 搜索建议模型
struct SearchSuggestResult: Codable {
    let status: Int
    let error_code: Int
    let data: [SuggestSection]?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case data
    }
}

struct SuggestSection: Codable {
    let RecordCount: Int
    let LableName: String?
    let RecordDatas: [SuggestItem]?
    
    enum CodingKeys: String, CodingKey {
        case RecordCount
        case LableName
        case RecordDatas
    }
}

struct SuggestItem: Codable {
    let HintInfo: String?
    let Hot: Int?
    let IsRadio: Int?
    let Use: String?
    let la: Int?
    let IsKlist: Int?
    let HintInfo2: String?
    let MatchCount: Int?
    let tags_v2: [String]?
    
    enum CodingKeys: String, CodingKey {
        case HintInfo
        case Hot
        case IsRadio
        case Use
        case la
        case IsKlist
        case HintInfo2
        case MatchCount
        case tags_v2
    }
}

// MARK: - 热搜模型
struct HotSearchResult: Codable {
    let status: Int
    let errcode: Int
    let data: HotSearchData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case errcode
        case data
    }
}

struct HotSearchData: Codable {
    let timestamp: Int
    let list: [HotSearchList]?
    
    enum CodingKeys: String, CodingKey {
        case timestamp
        case list
    }
}

struct HotSearchList: Codable {
    let name: String?
    let keywords: [HotSearchItem]?
    
    enum CodingKeys: String, CodingKey {
        case name
        case keywords
    }
}

struct HotSearchItem: Codable, Equatable {
    let keyword: String?
    let reason: String?
    let json_url: String?
    let jumpurl: String?
    let is_cover_word: Int?
    let type: Int?
    let icon: Int?
    
    enum CodingKeys: String, CodingKey {
        case keyword
        case reason
        case json_url
        case jumpurl
        case is_cover_word
        case type
        case icon
    }
}

// MARK: - 默认搜索关键词模型
struct DefaultSearchResult: Codable {
    let status: Int
    let errcode: Int
    let errmsg: String?
    let data: DefaultSearchData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case errcode
        case errmsg
        case data
    }
}

struct DefaultSearchData: Codable {
    let timestamp: Int?
    let ads: [AdItem]?
    let fallback: [FallbackItem]?
    
    enum CodingKeys: String, CodingKey {
        case timestamp
        case ads
        case fallback
    }
}

struct AdItem: Codable {
    let end_time: String?
    let id: Int?
    let is_preview: Int?
    let jumpType: String?
    let main_title: String?
    let show_times: Int?
    let start_time: String?
    let sub_title: String?
    let title: String?
    let type: Int?
    let unifiedUrl: String?
    
    enum CodingKeys: String, CodingKey {
        case end_time
        case id
        case is_preview
        case jumpType
        case main_title
        case show_times
        case start_time
        case sub_title
        case title
        case type
        case unifiedUrl
    }
}

struct FallbackItem: Codable {
    let end_time: String?
    let id: Int?
    let main_title: String?
    let jumpType: String?
    let title: String?
    let sub_title: String?
    let show_times: Int?
    let unifiedUrl: String?
    let start_time: String?
    let type: Int?
    let is_preview: Int?
    let freemode_data: FreemodeData?
    
    enum CodingKeys: String, CodingKey {
        case end_time
        case id
        case main_title
        case jumpType
        case title
        case sub_title
        case show_times
        case unifiedUrl
        case start_time
        case type
        case is_preview
        case freemode_data
    }
}

struct FreemodeData: Codable {
    let id: Int?
    let url: String?
    let back2searchresult: Int?
    
    enum CodingKeys: String, CodingKey {
        case id
        case url
        case back2searchresult
    }
}

// MARK: - 专辑模型
struct Album: Codable, Identifiable {
    let id: Int
    let name: String?
    let artist: Artist?
    let cover: String?
    let publishTime: Int?
    let size: Int?
    let description: String?
    let songs: [Song]?
    
    // 专辑特有字段
    let grade: Int?
    let intro: String?
    let company: String?
    let quality: Int?
    let collectCount: Int?
    let language: String?
    let privilege: Int?
    let songCount: Int?
    let category: Int?
    let shortIntro: String?
    let playCount: Int?
    
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case artist = "artist"
        case cover = "cover"
        case publishTime = "publishTime"
        case size = "size"
        case description = "description"
        case songs = "songs"
        case grade, intro, company, quality
        case collectCount = "collect_count"
        case language, privilege
        case songCount = "songcount"
        case category, shortIntro = "short_intro"
        case playCount = "play_count"
    }
    
    // 便利构造器，用于从字典创建
    init?(from dict: [String: Any]) {
        guard let id = dict["id"] as? Int else { return nil }
        self.id = id
        self.name = dict["name"] as? String
        self.artist = (dict["artist"] as? [String: Any]).flatMap { Artist(from: $0) }
        self.cover = dict["cover"] as? String
        self.publishTime = dict["publishTime"] as? Int
        self.size = dict["size"] as? Int
        self.description = dict["description"] as? String
        self.songs = nil // 搜索结果中通常不包含歌曲列表
        
        // 专辑特有字段
        self.grade = dict["grade"] as? Int
        self.intro = dict["intro"] as? String
        self.company = dict["company"] as? String
        self.quality = dict["quality"] as? Int
        self.collectCount = dict["collect_count"] as? Int
        self.language = dict["language"] as? String
        self.privilege = dict["privilege"] as? Int
        self.songCount = dict["songcount"] as? Int
        self.category = dict["category"] as? Int
        self.shortIntro = dict["short_intro"] as? String
        self.playCount = dict["play_count"] as? Int
    }
    
    // 将日期字符串转换为时间戳
    private static func dateFromString(_ dateString: String?) -> Int? {
        guard let dateString = dateString else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        if let date = formatter.date(from: dateString) {
            return Int(date.timeIntervalSince1970 * 1000)
        }
        return nil
    }
}

// MARK: - 歌手模型
struct Artist: Codable, Identifiable {
    let id: Int
    let name: String?
    let cover: String?
    let albumSize: Int?
    let musicSize: Int?
    let fansSize: Int?
    let followed: Bool?
    
    // 支持从API响应直接创建的便利构造器
    init?(name: String?, cover: String?, albumSize: Int?, musicSize: Int?, fansSize: Int?, followed: Bool?) {
        // 如果没有id，使用name的hash值作为id
        guard let name = name else { return nil }
        self.id = abs(name.hashValue)
        self.name = name
        self.cover = cover
        self.albumSize = albumSize
        self.musicSize = musicSize
        self.fansSize = fansSize
        self.followed = followed
    }
    
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case cover = "cover"
        case albumSize = "albumSize"
        case musicSize = "musicSize"
        case fansSize = "fansSize"
        case followed = "followed"
    }
    
    // 便利构造器，用于从字典创建
    init?(from dict: [String: Any]) {
        guard let id = dict["id"] as? Int else { return nil }
        self.id = id
        self.name = dict["name"] as? String
        self.cover = dict["cover"] as? String
        self.albumSize = dict["albumSize"] as? Int
        self.musicSize = dict["musicSize"] as? Int
        self.fansSize = dict["fansSize"] as? Int
        self.followed = dict["followed"] as? Bool
    }
    
}

// MARK: - 歌单模型
struct Playlist: Codable, Identifiable {
    let id: Int
    let name: String?
    let coverImgUrl: String?
    let playCount: Int?
    let trackCount: Int?
    let creator: SearchUser?
    let description: String?
    let subscribed: Bool?
    let commentCount: Int?
    let shareCount: Int?
    let tracks: [Song]?
    
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case coverImgUrl = "coverImgUrl"
        case playCount = "playCount"
        case trackCount = "trackCount"
        case creator = "creator"
        case description = "description"
        case subscribed = "subscribed"
        case commentCount = "commentCount"
        case shareCount = "shareCount"
        case tracks = "tracks"
    }
    
    // 便利构造器，用于从字典创建
    init?(from dict: [String: Any]) {
        guard let id = dict["id"] as? Int else { return nil }
        self.id = id
        self.name = dict["name"] as? String
        self.coverImgUrl = dict["coverImgUrl"] as? String
        self.playCount = dict["playCount"] as? Int
        self.trackCount = dict["trackCount"] as? Int
        self.creator = (dict["creator"] as? [String: Any]).flatMap { SearchUser(from: $0) }
        self.description = dict["description"] as? String
        self.subscribed = dict["subscribed"] as? Bool
        self.commentCount = dict["commentCount"] as? Int
        self.shareCount = dict["shareCount"] as? Int
        self.tracks = nil // 搜索结果中通常不包含歌曲列表
    }
    
}


// MARK: - 搜索用户模型
struct SearchUser: Codable, Identifiable {
    let id: Int
    let nickname: String?
    let avatarUrl: String?
    let signature: String?
    let followed: Bool?
    
    enum CodingKeys: String, CodingKey {
        case id = "userId"
        case nickname = "nickname"
        case avatarUrl = "avatarUrl"
        case signature = "signature"
        case followed = "followed"
    }
    
    // 便利构造器，用于从字典创建
    init?(from dict: [String: Any]) {
        guard let id = dict["userId"] as? Int else { return nil }
        self.id = id
        self.nickname = dict["nickname"] as? String
        self.avatarUrl = dict["avatarUrl"] as? String
        self.signature = dict["signature"] as? String
        self.followed = dict["followed"] as? Bool
    }
    
    // 便利构造器，用于直接创建
    init(userId: Int, nickname: String?, avatarUrl: String?, signature: String?, followed: Bool?) {
        self.id = userId
        self.nickname = nickname
        self.avatarUrl = avatarUrl
        self.signature = signature
        self.followed = followed
    }
}
