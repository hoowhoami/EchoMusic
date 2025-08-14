//
//  Player.swift
//  EchoMusic
//
//  Created on 2025/8/5.
//
import SwiftUI

/// 播放模式枚举
enum PlayMode: String, CaseIterable {
    case sequence = "repeat"           // 顺序播放
    case repeatOne = "repeat.1"        // 单曲循环
    case shuffle = "shuffle"           // 随机播放

    var displayName: String {
        switch self {
        case .sequence: return "顺序播放"
        case .repeatOne: return "单曲循环"
        case .shuffle: return "随机播放"
        }
    }
}

/// 播放器状态模型
class Player: ObservableObject {
    /// 当前播放歌曲（可选，无歌曲时为 nil）
    @Published
    var currentSong: Song?
    /// 是否正在播放
    @Published
    var isPlaying: Bool = false
    /// 当前播放时间（秒）
    @Published
    var currentTime: Double = 0
    /// 歌曲总时长（秒）
    @Published
    var duration: Double = 0
    /// 音量（0.0 - 1.0）
    @Published
    var volume: Double = 0.7
    /// 播放速度（0.5 - 2.0）
    @Published
    var playbackSpeed: Double = 1.0
    /// 播放模式
    @Published
    var playMode: PlayMode = .sequence
    /// 播放列表
    @Published
    var playlist: [Song] = []
    /// 当前播放索引
    @Published
    var currentIndex: Int = 0
    /// 播放错误信息
    @Published
    var errorMessage: String?
    /// 是否显示错误
    @Published
    var hasError: Bool = false
    
    init() {}
    
    /// 设置错误信息
    func setError(_ message: String) {
        errorMessage = message
        hasError = true
    }
    
    /// 清除错误信息
    func clearError() {
        errorMessage = nil
        hasError = false
    }
}