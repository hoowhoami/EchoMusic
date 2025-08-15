//
//  LibraryModel.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/6.
//

import Foundation

// MARK: - 音乐库数据分类枚举

/// 音乐库内容类型
enum LibraryContentType: CaseIterable {
    case userCreatedPlaylists   // 我创建的歌单
    case collectedPlaylists     // 我收藏的歌单
    case collectedAlbums       // 我收藏的专辑
    
    var displayName: String {
        switch self {
        case .userCreatedPlaylists:
            return "我创建的歌单"
        case .collectedPlaylists:
            return "我收藏的歌单"
        case .collectedAlbums:
            return "我收藏的专辑"
        }
    }
}

/// 通用播放列表过滤器
struct PlaylistFilter {
    let contentType: LibraryContentType
    let currentUserId: Int?
    
    /// 判断播放列表是否属于指定类型
    func matches(_ playlist: UserPlaylistResponse.UserPlaylist) -> Bool {
        switch contentType {
        case .userCreatedPlaylists:
            // 我创建的歌单 = 创建者是我
            return playlist.list_create_userid == currentUserId
            
        case .collectedPlaylists:
            // 我收藏的歌单 = 创建者不是我 且 没有authors字段（不是专辑）
            return playlist.list_create_userid != currentUserId && !hasAuthors(playlist)
            
        case .collectedAlbums:
            // 我收藏的专辑 = 创建者不是我 且 有authors字段（是专辑）
            return playlist.list_create_userid != currentUserId && hasAuthors(playlist)
        }
    }
    
    /// 检查播放列表是否有authors字段（判断是否为专辑）
    private func hasAuthors(_ playlist: UserPlaylistResponse.UserPlaylist) -> Bool {
        // 这里需要根据实际数据结构判断，暂时用tags字段作为判断条件
        // 如果有专门的authors字段，应该使用那个字段
        return playlist.tags?.contains("专辑") == true || playlist.type == 2
    }
}

// MARK: - 听歌历史相关数据模型

/// 听歌历史响应模型
struct ListenHistoryResponse: Codable {
    let status: Int
    let error_code: Int
    let data: ListenHistoryData?
}

/// 听歌历史数据
struct ListenHistoryData: Codable {
    let lists: [ListenHistoryItem]?
}

/// 听歌历史项目
struct ListenHistoryItem: Codable, Identifiable {
    let id = UUID()
    let hash: String?
    let songname: String?
    let singername: String?
    let albumname: String?
    let album_img: String?
    let listen_time: String?
    let duration: Int?
    let mvhash: String?
    let filename: String?
    let bitrate: Int?
    let audio_id: String?
    let play_count: Int?
    let album_audio_id: String?
    let trans_params: TransParams?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.hash = c[safe: .hash]
        self.songname = c[safe: .songname]
        self.singername = c[safe: .singername]
        self.albumname = c[safe: .albumname]
        self.album_img = c[safe: .album_img]
        self.listen_time = c[safe: .listen_time]
        self.duration = c[safe: .duration]
        self.mvhash = c[safe: .mvhash]
        self.filename = c[safe: .filename]
        self.bitrate = c[safe: .bitrate]
        self.audio_id = c[safe: .audio_id]
        self.play_count = c[safe: .play_count]
        self.album_audio_id = c[safe: .album_audio_id]
        self.trans_params = c[safe: .trans_params]
    }
    
    private enum CodingKeys: String, CodingKey {
        case hash, songname, singername, albumname, album_img, listen_time
        case duration, mvhash, filename, bitrate, audio_id, play_count
        case album_audio_id, trans_params
    }
}

/// 歌曲转换参数
struct TransParams: Codable {
    let cpy_level: Int?
    let hash: String?
    let pay: Int?
    let cid: String?
    let album_audio_id: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.cpy_level = c[safe: .cpy_level]
        self.hash = c[safe: .hash]
        self.pay = c[safe: .pay]
        self.cid = c[safe: .cid]
        self.album_audio_id = c[safe: .album_audio_id]
    }
}

// MARK: - 用户歌单响应模型
struct UserPlaylistResponse: Codable {
    let status: Int
    let error_code: Int
    let data: UserPlaylistData?
    
    struct UserPlaylistData: Codable {
        let phone_flag: Int?
        let total_ver: Int?
        let userid: Int?
        let album_count: Int?
        let list_count: Int?
        let collect_count: Int?
        let info: [UserPlaylist]?
    }
    
    struct UserPlaylist: Codable {
        let listid: Int?
        let name: String?
        let intro: String?
        let pic: String?
        let count: Int?
        let m_count: Int?
        let tags: String?
        let status: Int?
        let create_user_pic: String?
        let per_num: Int?
        let pub_new: Int?
        let is_drop: Int?
        let list_create_userid: Int?
        let is_publish: Int?
        let musiclib_tags: [MusicLibTag]?
        let pub_time: Int?
        let is_featured: Int?
        let list_ver: Int?
        let type: Int?
        let list_create_listid: Int?
        let radio_id: Int?
        let source: Int?
        let is_del: Int?
        let create_time: Int?
        let kq_talent: Int?
        let is_edit: Int?
        let update_time: Int?
        let per_count: Int?
        let sound_quality: String?
        let sort: Int?
        let is_mine: Int?
        let is_def: Int?
        let list_create_gid: String?
        let global_collection_id: String?
        let is_per: Int?
        let list_create_username: String?
        let is_pri: Int?
        let is_custom_pic: Int?
        let pub_type: Int?
        
        // 新增的字段
        let jump_copy: Int?
        let sound: PlaylistSound?
        let cutd: Int?
        let from_listid: Int?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 最新的超级简洁写法 - 类型推断！
            self.listid = c[safe: .listid]
            self.name = c[safe: .name]
            self.intro = c[safe: .intro]
            self.pic = c[safe: .pic]
            self.count = c[safe: .count]
            self.m_count = c[safe: .m_count]
            self.tags = c[safe: .tags]
            self.status = c[safe: .status]
            self.create_user_pic = c[safe: .create_user_pic]
            self.per_num = c[safe: .per_num]
            self.pub_new = c[safe: .pub_new]
            self.is_drop = c[safe: .is_drop]
            self.list_create_userid = c[safe: .list_create_userid]
            self.is_publish = c[safe: .is_publish]
            self.musiclib_tags = c[safe: .musiclib_tags]
            self.pub_time = c[safe: .pub_time]
            self.is_featured = c[safe: .is_featured]
            self.list_ver = c[safe: .list_ver]
            self.type = c[safe: .type]
            self.list_create_listid = c[safe: .list_create_listid]
            self.radio_id = c[safe: .radio_id]
            self.source = c[safe: .source]
            self.is_del = c[safe: .is_del]
            self.create_time = c[safe: .create_time]
            self.kq_talent = c[safe: .kq_talent]
            self.is_edit = c[safe: .is_edit]
            self.update_time = c[safe: .update_time]
            self.per_count = c[safe: .per_count]
            self.sound_quality = c[safe: .sound_quality]
            self.sort = c[safe: .sort]
            self.is_mine = c[safe: .is_mine]
            self.is_def = c[safe: .is_def]
            self.list_create_gid = c[safe: .list_create_gid]
            self.global_collection_id = c[safe: .global_collection_id]
            self.is_per = c[safe: .is_per]
            self.list_create_username = c[safe: .list_create_username]
            self.is_pri = c[safe: .is_pri]
            self.is_custom_pic = c[safe: .is_custom_pic]
            self.pub_type = c[safe: .pub_type]
            
            // 新增字段 - 同样简洁！
            self.jump_copy = c[safe: .jump_copy]
            self.sound = c[safe: .sound]
            self.cutd = c[safe: .cutd]
            self.from_listid = c[safe: .from_listid]
        }
        
        private enum CodingKeys: String, CodingKey {
            case listid, name, intro, pic, count, m_count, tags, status
            case create_user_pic, per_num, pub_new, is_drop, list_create_userid
            case is_publish, musiclib_tags, pub_time, is_featured, list_ver, type
            case list_create_listid, radio_id, source, is_del, create_time
            case kq_talent, is_edit, update_time, per_count, sound_quality
            case sort, is_mine, is_def, list_create_gid, global_collection_id
            case is_per, list_create_username, is_pri, is_custom_pic, pub_type
            case jump_copy, sound, cutd, from_listid
        }
    }
}

// MARK: - 歌单标签模型
struct MusicLibTag: Codable {
    let tag_id: Int?
    let parent_id: Int?
    let tag_name: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.tag_id = c[safe: .tag_id]
        self.parent_id = c[safe: .parent_id]
        self.tag_name = c[safe: .tag_name]
    }
}

// MARK: - 歌单音效模型
struct PlaylistSound: Codable {
    let type: Int?
    let args: String?
    let id: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.type = c[safe: .type]
        self.args = c[safe: .args]
        self.id = c[safe: .id]
    }
}

// MARK: - 歌单详情响应模型
struct PlaylistDetailResponse: Codable {
    let status: Int
    let error_code: Int
    let data: [PlaylistDetailInfo]?
}

struct PlaylistDetailInfo: Codable {
    let tags: String?
    let status: Int?
    let create_user_pic: String?
    let is_pri: Int?
    let pub_new: Int?
    let is_drop: Int?
    let list_create_userid: Int?
    let is_publish: Int?
    let musiclib_tags: [MusicLibTag]?
    let pub_type: Int?
    let is_featured: Int?
    let publish_date: String?
    let collect_total: Int?
    let list_ver: Int?
    let intro: String?
    let type: Int?
    let list_create_listid: Int?
    let radio_id: Int?
    let source: Int?
    let sound: PlaylistSound?
    let listid: Int?
    let is_def: Int?
    let parent_global_collection_id: String?
    let sound_quality: String?
    let per_count: Int?
    let plist: [String]?
    let kq_talent: Int?
    let create_time: Int?
    let is_per: Int?
    let is_edit: Int?
    let update_time: Int?
    let code: Int?
    let count: Int?
    let sort: Int?
    let is_mine: Int?
    let musiclib_id: Int?
    let per_num: Int?
    let create_user_gender: Int?
    let number: Int?
    let pic: String?
    let list_create_username: String?
    let name: String?
    let is_custom_pic: Int?
    let global_collection_id: String?
    let heat: Int?
    let list_create_gid: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 使用安全解码方式
        self.tags = c[safe: .tags]
        self.status = c[safe: .status]
        self.create_user_pic = c[safe: .create_user_pic]
        self.is_pri = c[safe: .is_pri]
        self.pub_new = c[safe: .pub_new]
        self.is_drop = c[safe: .is_drop]
        self.list_create_userid = c[safe: .list_create_userid]
        self.is_publish = c[safe: .is_publish]
        self.musiclib_tags = c[safe: .musiclib_tags]
        self.pub_type = c[safe: .pub_type]
        self.is_featured = c[safe: .is_featured]
        self.publish_date = c[safe: .publish_date]
        self.collect_total = c[safe: .collect_total]
        self.list_ver = c[safe: .list_ver]
        self.intro = c[safe: .intro]
        self.type = c[safe: .type]
        self.list_create_listid = c[safe: .list_create_listid]
        self.radio_id = c[safe: .radio_id]
        self.source = c[safe: .source]
        self.sound = c[safe: .sound]
        self.listid = c[safe: .listid]
        self.is_def = c[safe: .is_def]
        self.parent_global_collection_id = c[safe: .parent_global_collection_id]
        self.sound_quality = c[safe: .sound_quality]
        self.per_count = c[safe: .per_count]
        self.plist = c[safe: .plist]
        self.kq_talent = c[safe: .kq_talent]
        self.create_time = c[safe: .create_time]
        self.is_per = c[safe: .is_per]
        self.is_edit = c[safe: .is_edit]
        self.update_time = c[safe: .update_time]
        self.code = c[safe: .code]
        self.count = c[safe: .count]
        self.sort = c[safe: .sort]
        self.is_mine = c[safe: .is_mine]
        self.musiclib_id = c[safe: .musiclib_id]
        self.per_num = c[safe: .per_num]
        self.create_user_gender = c[safe: .create_user_gender]
        self.number = c[safe: .number]
        self.pic = c[safe: .pic]
        self.list_create_username = c[safe: .list_create_username]
        self.name = c[safe: .name]
        self.is_custom_pic = c[safe: .is_custom_pic]
        self.global_collection_id = c[safe: .global_collection_id]
        self.heat = c[safe: .heat]
        self.list_create_gid = c[safe: .list_create_gid]
    }
    
    private enum CodingKeys: String, CodingKey {
        case tags, status, create_user_pic, is_pri, pub_new, is_drop
        case list_create_userid, is_publish, musiclib_tags, pub_type
        case is_featured, publish_date, collect_total, list_ver, intro
        case type, list_create_listid, radio_id, source, sound, listid
        case is_def, parent_global_collection_id, sound_quality
        case per_count, plist, kq_talent, create_time, is_per, is_edit
        case update_time, code, count, sort, is_mine, musiclib_id
        case per_num, create_user_gender, number, pic
        case list_create_username, name, is_custom_pic
        case global_collection_id, heat, list_create_gid
    }
    
    // 计算属性，便于访问创建者信息
    var creator: String? {
        return list_create_username
    }
}

// MARK: - 歌单歌曲列表响应模型
struct PlaylistTracksResponse: Codable {
    let status: Int
    let error_code: Int
    let data: PlaylistTracksData?
}

struct PlaylistTracksData: Codable {
    let begin_idx: Int?
    let pagesize: Int?
    let count: Int?
    let userid: Int?
    let songs: [PlaylistTrackInfo]?
    let list_info: PlaylistDetailInfo?
    let popularization: [String: String]?
}

struct PlaylistTrackInfo: Codable, Identifiable {
    let id = UUID()
    let hash: String?
    let name: String?
    let audio_id: Int?
    let size: Int?
    let publish_date: String?
    let brief: String?
    let mvtype: Int?
    let add_mixsongid: Int?
    let album_id: String?
    let bpm: Int?
    let mvhash: String?
    let extname: String?
    let language: String?
    let collecttime: Int?
    let csong: Int?
    let remark: String?
    let level: Int?
    let media_old_cpy: Int?
    let rcflag: Int?
    let feetype: Int?
    let has_obbligato: Int?
    let timelen: Int?
    let sort: Int?
    let trans_param: PlaylistTransParam?
    let medistype: String?
    let user_id: Int?
    let bitrate: Int?
    let audio_group_id: String?
    let privilege: Int?
    let cover: String?
    let mixsongid: Int?
    let fileid: Int?
    let heat: Int?
    let mvdata: [PlaylistMVData]?
    let relate_goods: [PlaylistRelateGood]?
    let download: [PlaylistDownloadInfo]?
    let tagmap: [String: Int]?
    let albuminfo: PlaylistAlbumInfo?
    let singerinfo: [PlaylistSingerInfo]?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅的类型推断语法
        self.hash = c[safe: .hash]
        self.name = c[safe: .name]
        self.audio_id = c[safe: .audio_id]
        self.size = c[safe: .size]
        self.publish_date = c[safe: .publish_date]
        self.brief = c[safe: .brief]
        self.mvtype = c[safe: .mvtype]
        self.add_mixsongid = c[safe: .add_mixsongid]
        self.album_id = c[safe: .album_id]
        self.bpm = c[safe: .bpm]
        self.mvhash = c[safe: .mvhash]
        self.extname = c[safe: .extname]
        self.language = c[safe: .language]
        self.collecttime = c[safe: .collecttime]
        self.csong = c[safe: .csong]
        self.remark = c[safe: .remark]
        self.level = c[safe: .level]
        self.media_old_cpy = c[safe: .media_old_cpy]
        self.rcflag = c[safe: .rcflag]
        self.feetype = c[safe: .feetype]
        self.has_obbligato = c[safe: .has_obbligato]
        self.timelen = c[safe: .timelen]
        self.sort = c[safe: .sort]
        self.trans_param = c[safe: .trans_param]
        self.medistype = c[safe: .medistype]
        self.user_id = c[safe: .user_id]
        self.bitrate = c[safe: .bitrate]
        self.audio_group_id = c[safe: .audio_group_id]
        self.privilege = c[safe: .privilege]
        self.cover = c[safe: .cover]
        self.mixsongid = c[safe: .mixsongid]
        self.fileid = c[safe: .fileid]
        self.heat = c[safe: .heat]
        self.mvdata = c[safe: .mvdata]
        self.relate_goods = c[safe: .relate_goods]
        self.download = c[safe: .download]
        self.tagmap = c[safe: .tagmap]
        self.albuminfo = c[safe: .albuminfo]
        self.singerinfo = c[safe: .singerinfo]
    }
    
    // 计算属性，用于向后兼容
    var songname: String? { return name }
    var singername: String? {
        return singerinfo?.map { $0.name ?? "" }.joined(separator: ", ")
    }
    var albumname: String? { return albuminfo?.name }
    var album_img: String? { return cover }
    var duration: Int? { return timelen != nil ? timelen! / 1000 : nil }
    
    private enum CodingKeys: String, CodingKey {
        case hash, name, audio_id, size, publish_date, brief, mvtype
        case add_mixsongid, album_id, bpm, mvhash, extname, language
        case collecttime, csong, remark, level, media_old_cpy
        case rcflag, feetype, has_obbligato, timelen, sort, trans_param
        case medistype, user_id, bitrate, audio_group_id, privilege
        case cover, mixsongid, fileid, heat, mvdata, relate_goods
        case download, tagmap, albuminfo, singerinfo
    }
    
    // 便利初始化器，用于预览和测试
    init(name: String? = nil,
         singername: String? = nil,
         albumname: String? = nil,
         duration: Int? = nil,
         cover: String? = nil,
         privilege: Int? = nil,
         relate_goods: [String]? = nil) {
        self.name = name
        self.hash = nil
        self.audio_id = nil
        self.size = nil
        self.publish_date = nil
        self.brief = nil
        self.mvtype = nil
        self.add_mixsongid = nil
        self.album_id = nil
        self.bpm = nil
        self.mvhash = nil
        self.extname = nil
        self.language = nil
        self.collecttime = nil
        self.csong = nil
        self.remark = nil
        self.level = nil
        self.media_old_cpy = nil
        self.rcflag = nil
        self.feetype = nil
        self.has_obbligato = nil
        self.timelen = duration
        self.sort = nil
        self.trans_param = nil
        self.medistype = nil
        self.user_id = nil
        self.bitrate = nil
        self.audio_group_id = nil
        self.privilege = privilege
        self.cover = cover
        self.mixsongid = nil
        self.fileid = nil
        self.heat = nil
        self.mvdata = nil
        self.relate_goods = relate_goods?.map { _ in PlaylistRelateGood(size: nil, hash: nil, level: nil, privilege: nil, bitrate: nil) }
        self.download = nil
        self.tagmap = nil
        self.albuminfo = albumname != nil ? PlaylistAlbumInfo(name: albumname, id: nil, publish: nil) : nil
        self.singerinfo = singername != nil ? [PlaylistSingerInfo(name: singername, id: nil)] : nil
    }
}

struct PlaylistMVData: Codable {
    let typ: Int?
}

struct PlaylistRelateGood: Codable {
    let size: Int?
    let hash: String?
    let level: Int?
    let privilege: Int?
    let bitrate: Int?
}

struct PlaylistDownloadInfo: Codable {
    let status: Int?
    let hash: String?
    let fail_process: Int?
    let pay_type: Int?
}

struct PlaylistAlbumInfo: Codable {
    let name: String?
    let id: Int?
    let publish: Int?
}

struct PlaylistSingerInfo: Codable {
    let id: Int?
    let publish: Int?
    let name: String?
    let avatar: String?
    let type: Int?
    
    // 便利初始化器，用于预览和测试
    init(name: String? = nil, id: Int? = nil) {
        self.name = name
        self.id = id
        self.publish = nil
        self.avatar = nil
        self.type = nil
    }
}

struct PlaylistTransParam: Codable {
    let ogg_128_hash: String?
    let classmap: [String: Int]?
    let language: String?
    let cpy_attr0: Int?
    let musicpack_advance: Int?
    let display: Int?
    let display_rate: Int?
    let ogg_320_filesize: Int?
    let hash_multitrack: String?
    let qualitymap: [String: Int]?
    let cpy_grade: Int?
    let hash_offset: PlaylistHashOffset?
    let cid: Int?
    let ogg_128_filesize: Int?
    let ogg_320_hash: String?
    let ipmap: [String: Int]?
    let appid_block: String?
    let pay_block_tpl: Int?
    let union_cover: String?
    let cpy_level: Int?
}

struct PlaylistHashOffset: Codable {
    let clip_hash: String?
    let start_byte: Int?
    let file_type: Int?
    let end_byte: Int?
    let end_ms: Int?
    let start_ms: Int?
    let offset_hash: String?
}

// MARK: - 用户关注响应模型
struct UserFollowResponse: Codable {
    let status: Int
    let error_code: Int
    let data: UserFollowData?
    
    struct UserFollowData: Codable {
        let total: Int?
        let lists: [FollowArtist]?
    }
    
    struct FollowArtist: Codable {
        let userid: Int?
        let username: String?
        let nickname: String?
        let pic: String?
        let singerid: String?
        let source: Int?
        let follow_time: String?
        let sex: Int?
        let birthday: String?
        let intro: String?
        let fans_count: Int?
        let follow_count: Int?
        
        // 自定义初始化器，用于图片URL处理
        init(userid: Int? = nil,
             username: String? = nil,
             nickname: String? = nil,
             pic: String? = nil,
             singerid: String? = nil,
             source: Int? = nil,
             follow_time: String? = nil,
             sex: Int? = nil,
             birthday: String? = nil,
             intro: String? = nil,
             fans_count: Int? = nil,
             follow_count: Int? = nil) {
            self.userid = userid
            self.username = username
            self.nickname = nickname
            self.pic = pic
            self.singerid = singerid
            self.source = source
            self.follow_time = follow_time
            self.sex = sex
            self.birthday = birthday
            self.intro = intro
            self.fans_count = fans_count
            self.follow_count = follow_count
        }
    }
}
