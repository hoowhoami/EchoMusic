//
//  NavigationItemType.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

/// 左侧导航栏选项枚举
enum NavigationItemType: String, CaseIterable, Identifiable {
    // 在线音乐
    case home = "推荐"
    case discover = "发现"
    
    // 我的音乐
    case myCloud = "云盘"
    case recentPlay = "最近"
    case playlists = "我的歌单"
    
    // 用户相关
    case userProfile = "用户详情"
    
    var id: String { rawValue }
    
    /// 导航项对应的 SF Symbol 图标
    var icon: String {
        switch self {
        case .home: return "house.fill"
        case .discover: return "globe.americas.fill"
        case .myCloud: return "icloud.fill"
        case .recentPlay: return "clock.fill"
        case .playlists: return "music.note.list"
        case .userProfile: return "person.circle"
        }
    }
    
    /// 获取所有在线音乐类型
    static var onlineMusicItems: [NavigationItemType] {
        return [.home, .discover]
    }
    
    /// 获取所有我的音乐类型
    static var myMusicItems: [NavigationItemType] {
        return [.myCloud, .recentPlay]
    }
    
    /// 是否需要登录才能访问
    var requiresLogin: Bool {
        switch self {
        case .myCloud, .recentPlay, .playlists:
            return true
        default:
            return false
        }
    }
}

/// 歌单类型枚举
enum PlaylistType: String, CaseIterable, Identifiable {
    case created = "创建的歌单"
    case collected = "收藏的歌单"
    case albums = "收藏的专辑"
    
    var id: String { rawValue }
    
    var icon: String {
        switch self {
        case .created: return "music.note.list"
        case .collected: return "heart.text.square"
        case .albums: return "opticaldisc"
        }
    }
}
