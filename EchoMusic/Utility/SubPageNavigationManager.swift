//
//  SubPageNavigationManager.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/14.
//

import SwiftUI
import Combine

/// 子页面导航管理器
/// 用于管理应用中各种子页面的导航状态，提供统一的返回逻辑
class SubPageNavigationManager: ObservableObject {
    /// 当前活跃的子页面栈
    @Published private var subPageStack: [SubPageInfo] = []
    
    /// 订阅管理
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        setupNotificationListeners()
    }
    
    /// 检查是否有活跃的子页面
    var hasActiveSubPage: Bool {
        return !subPageStack.isEmpty
    }
    
    /// 获取当前顶层子页面
    var currentSubPage: SubPageInfo? {
        return subPageStack.last
    }
    
    /// 进入子页面
    func enterSubPage(_ info: SubPageInfo) {
        subPageStack.append(info)
    }
    
    /// 退出当前子页面
    @discardableResult
    func exitCurrentSubPage() -> Bool {
        guard let currentPage = subPageStack.popLast() else {
            return false
        }
        
        // 发送退出通知
        NotificationCenter.default.post(
            name: NSNotification.Name(currentPage.exitNotificationName),
            object: nil
        )
        
        return true
    }
    
    /// 退出指定类型的子页面
    func exitSubPage(ofType type: SubPageType) {
        subPageStack.removeAll { $0.type == type }
    }
    
    /// 清空所有子页面（当主导航改变时）
    func clearAllSubPages() {
        subPageStack.removeAll()
    }
    
    /// 设置通知监听器
    private func setupNotificationListeners() {
        // 监听子页面进入事件
        NotificationCenter.default.publisher(for: NSNotification.Name("SubPageEntered"))
            .sink { [weak self] notification in
                if let subPageInfo = notification.userInfo?["subPageInfo"] as? SubPageInfo {
                    self?.enterSubPage(subPageInfo)
                }
            }
            .store(in: &cancellables)
        
        // 监听主导航变化
        NotificationCenter.default.publisher(for: NSNotification.Name("MainNavigationChanged"))
            .sink { [weak self] _ in
                self?.clearAllSubPages()
            }
            .store(in: &cancellables)
    }
}

/// 子页面信息
struct SubPageInfo {
    let type: SubPageType
    let title: String
    let exitNotificationName: String
    let metadata: [String: Any]?
    
    init(type: SubPageType, title: String, metadata: [String: Any]? = nil) {
        self.type = type
        self.title = title
        self.exitNotificationName = "Exit\(type.rawValue)"
        self.metadata = metadata
    }
}

/// 子页面类型枚举
enum SubPageType: String, CaseIterable {
    case playlistDetail = "PlaylistDetail"
    case albumDetail = "AlbumDetail"
    case artistDetail = "ArtistDetail"
    case searchResult = "SearchResult"
    case songDetail = "SongDetail"
    
    var displayName: String {
        switch self {
        case .playlistDetail:
            return "歌单详情"
        case .albumDetail:
            return "专辑详情"
        case .artistDetail:
            return "歌手详情"
        case .searchResult:
            return "搜索结果"
        case .songDetail:
            return "歌曲详情"
        }
    }
}