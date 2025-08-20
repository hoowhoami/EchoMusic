//
//  SearchModels.swift
//  EchoMusic
//
//  Created on 2025/8/20.
//

import Foundation

// MARK: - AnyCodable 类型
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        // 尝试解码为不同的类型
        if let intValue = try? container.decode(Int.self) {
            value = intValue
        } else if let stringValue = try? container.decode(String.self) {
            value = stringValue
        } else if let boolValue = try? container.decode(Bool.self) {
            value = boolValue
        } else if let doubleValue = try? container.decode(Double.self) {
            value = doubleValue
        } else if let dictValue = try? container.decode([String: JSONValue].self) {
            value = dictValue
        } else if let arrayValue = try? container.decode([JSONValue].self) {
            value = arrayValue
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        switch value {
        case let intValue as Int:
            try container.encode(intValue)
        case let stringValue as String:
            try container.encode(stringValue)
        case let boolValue as Bool:
            try container.encode(boolValue)
        case let doubleValue as Double:
            try container.encode(doubleValue)
        case let dictValue as [String: JSONValue]:
            try container.encode(dictValue)
        case let arrayValue as [JSONValue]:
            try container.encode(arrayValue)
        default:
            throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: container.codingPath, debugDescription: "Unsupported type"))
        }
    }
}

// MARK: - JSONValue 类型
enum JSONValue: Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case dictionary([String: JSONValue])
    case null
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let intValue = try? container.decode(Int.self) {
            self = .int(intValue)
        } else if let doubleValue = try? container.decode(Double.self) {
            self = .double(doubleValue)
        } else if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let arrayValue = try? container.decode([JSONValue].self) {
            self = .array(arrayValue)
        } else if let dictValue = try? container.decode([String: JSONValue].self) {
            self = .dictionary(dictValue)
        } else if container.decodeNil() {
            self = .null
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid JSON value")
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .dictionary(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

// MARK: - 搜索类型枚举
enum SearchType: String, CaseIterable {
    case song = "song"          // 单曲
    case album = "album"        // 专辑
    case artist = "author"      // 歌手
    case playlist = "special"   // 歌单
    case mv = "mv"              // MV
    case lyric = "lyric"        // 歌词
    
    var displayName: String {
        switch self {
        case .song: return "单曲"
        case .album: return "专辑"
        case .artist: return "歌手"
        case .playlist: return "歌单"
        case .mv: return "MV"
        case .lyric: return "歌词"
        }
    }
}

// MARK: - 搜索结果模型
struct SearchResult: Codable {
    let status: Int
    let error_code: Int
    let error_msg: String?
    var data: SearchData?
    
    enum CodingKeys: String, CodingKey {
        case status
        case error_code
        case error_msg
        case data
    }
}

struct SearchData: Codable {
    var lists: [AnyCodable]?
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
    
    // 便利方法来获取特定类型的搜索结果
    var songs: [Song]? {
        return lists?.compactMap { item in
            if let dict = item.value as? [String: Any] {
                return Song(from: dict)
            }
            return nil
        }
    }
    
    var albums: [Album]? {
        return lists?.compactMap { item in
            if let dict = item.value as? [String: Any] {
                return Album(from: dict)
            }
            return nil
        }
    }
    
    var artists: [Artist]? {
        return lists?.compactMap { item in
            if let dict = item.value as? [String: Any] {
                return Artist(from: dict)
            }
            return nil
        }
    }
    
    var playlists: [Playlist]? {
        return lists?.compactMap { item in
            if let dict = item.value as? [String: Any] {
                return Playlist(from: dict)
            }
            return nil
        }
    }
    
    var mvs: [MV]? {
        return lists?.compactMap { item in
            if let dict = item.value as? [String: Any] {
                return MV(from: dict)
            }
            return nil
        }
    }
}

struct SearchContent: Codable {
    let songs: [Song]?
    let albums: [Album]?
    let artists: [Artist]?
    let playlists: [Playlist]?
    let mvs: [MV]?
    
    enum CodingKeys: String, CodingKey {
        case songs = "songs"
        case albums = "albums"
        case artists = "artists"
        case playlists = "playlists"
        case mvs = "mvs"
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
    
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case artist = "artist"
        case cover = "cover"
        case publishTime = "publishTime"
        case size = "size"
        case description = "description"
        case songs = "songs"
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

// MARK: - MV模型
struct MV: Codable, Identifiable {
    let id: Int
    let name: String?
    let artistName: String?
    let cover: String?
    let playCount: Int?
    let duration: Int?
    let briefDesc: String?
    let artists: [Artist]?
    
    enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case artistName = "artistName"
        case cover = "cover"
        case playCount = "playCount"
        case duration = "duration"
        case briefDesc = "briefDesc"
        case artists = "artists"
    }
    
    // 便利构造器，用于从字典创建
    init?(from dict: [String: Any]) {
        guard let id = dict["id"] as? Int else { return nil }
        self.id = id
        self.name = dict["name"] as? String
        self.artistName = dict["artistName"] as? String
        self.cover = dict["cover"] as? String
        self.playCount = dict["playCount"] as? Int
        self.duration = dict["duration"] as? Int
        self.briefDesc = dict["briefDesc"] as? String
        self.artists = nil // 搜索结果中通常不包含艺术家列表
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
}
