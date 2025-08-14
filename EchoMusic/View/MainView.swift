//
//  MainView.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import SwiftUI

// 主视图
struct MainView: View {
    /// 当前选中的导航项
    @State private var selectedItem: NavigationItemType = .home
    
    /// 控制侧边栏可见性的状态变量
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    
    /// 歌单详情页状态管理
    @State private var showingPlaylistDetail = false
    @State private var currentPlaylist: UserPlaylistResponse.UserPlaylist?
    @State private var currentPlaylistType: PlaylistType?

    @EnvironmentObject private var appSettings: AppSetting
    @EnvironmentObject private var userService: UserService

    var body: some View {
        // 1. 主体左右分栏布局（系统原生SplitView）
        NavigationSplitView(columnVisibility: $columnVisibility) {
            // 左侧边栏
            SidebarView(selectedItem: $selectedItem)
                .frame(minWidth: 180)
                .navigationTitle("") // 不设置标题
                .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 300)
                .onChange(of: selectedItem) { newValue in
                    addToNavigationHistory(newValue)
                    // 当导航项改变时，清空所有子页面状态
                    subPageManager.clearAllSubPages()
                    // 发送主导航变化通知
                    NotificationCenter.default.post(
                        name: NSNotification.Name("MainNavigationChanged"),
                        object: nil,
                        userInfo: ["selectedItem": newValue]
                    )
                }
                .toolbar {
                    // 左侧工具按钮
                    ToolbarItem(placement: .navigation) {
                        
                        HStack(spacing: 8) {
                            Button(action: { navigateBack() }) {
                                Image(systemName: "chevron.left")
                            }
                            .help("后退")
                            .disabled(!canNavigateBack)
                            
                            Button(action: { navigateForward() }) {
                                Image(systemName: "chevron.right")
                            }
                            .help("前进")
                            .disabled(!canNavigateForward)
                            
                            Button(action: {
                                Task {
                                    await refreshCurrentContent()
                                }
                            }) {
                                if isRefreshing {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.clockwise")
                                }
                            }
                            .help("刷新")
                            .disabled(isRefreshing)
                        }
                    }
                }
                
        } detail: {
            // 右侧主内容
            Group {
                if showingPlaylistDetail, let playlist = currentPlaylist, let playlistType = currentPlaylistType {
                    // 显示歌单详情页
                    PlaylistDetailView(
                        playlist: playlist,
                        sourceSection: playlistTypeToLibrarySection(playlistType),
                        onBack: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showingPlaylistDetail = false
                                currentPlaylist = nil
                                currentPlaylistType = nil
                            }
                        }
                    )
                } else {
                    // 显示正常内容
                    ContentView(selectedItem: selectedItem)
                }
            }
            .environmentObject(subPageManager)
                .navigationTitle("")
                .toolbar {
                    
                    // 中间搜索框
                    ToolbarItem(placement: .automatic) {
                        TextField("搜索音乐、歌手、歌单", text: $searchText)
                            .textFieldStyle(RoundedBorderTextFieldStyle())
                            .frame(width: 200)
                            .onSubmit {
                                performSearch()
                            }
                    }
                }
            
            PlayerView()
                .frame(height: 80)
                .background(Color(NSColor.windowBackgroundColor))
                .border(Color(NSColor.separatorColor), width: 1)
            
        }
        .frame(minWidth: 1000, minHeight: 680)
        .preferredColorScheme(appSettings.appearanceMode.colorScheme)
        .onAppear {
            // 初始化导航历史
            if navigationHistory.isEmpty {
                navigationHistory = [selectedItem]
                currentHistoryIndex = 0
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCompleted"))) { _ in
            // 监听刷新完成通知
            isRefreshing = false
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("OpenPlaylistDetailDirectly"))) { notification in
            // 监听直接打开歌单详情的通知
            if let playlist = notification.userInfo?["playlist"] as? UserPlaylistResponse.UserPlaylist,
               let playlistType = notification.userInfo?["playlistType"] as? PlaylistType {
                withAnimation(.easeInOut(duration: 0.2)) {
                    currentPlaylist = playlist
                    currentPlaylistType = playlistType
                    showingPlaylistDetail = true
                }
            }
        }
        
    }

    
    // MARK: - State
    @State private var searchText = ""
    @State private var isRefreshing = false
    
    /// 导航历史栈
    @State private var navigationHistory: [NavigationItemType] = []
    /// 当前历史索引
    @State private var currentHistoryIndex = -1
    /// 标记是否正在通过历史导航（防止重复添加历史）
    @State private var isNavigatingThroughHistory = false
    /// 子页面导航管理器
    @StateObject private var subPageManager = SubPageNavigationManager()
    
    private func performSearch() {
        guard !searchText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        print("搜索: \(searchText)")
        searchText = ""
    }
    
    /// 刷新当前内容
    private func refreshCurrentContent() async {
        // 设置刷新状态
        await MainActor.run {
            isRefreshing = true
        }
        
        // 发送刷新通知，让当前显示的内容视图进行刷新
        NotificationCenter.default.post(
            name: NSNotification.Name("RefreshCurrentContent"),
            object: nil,
            userInfo: ["selectedItem": selectedItem]
        )
        
        // 设置超时保护，防止按钮永远处于加载状态
        Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10秒超时
            await MainActor.run {
                if isRefreshing {
                    isRefreshing = false
                }
            }
        }
    }
    
    // MARK: - Actions
    private func navigateBack() {
        // 首先尝试退出子页面
        if subPageManager.hasActiveSubPage {
            subPageManager.exitCurrentSubPage()
            return
        }
        
        // 如果没有子页面，执行正常的历史导航
        guard currentHistoryIndex > 0 else { return }
        
        isNavigatingThroughHistory = true
        currentHistoryIndex -= 1
        selectedItem = navigationHistory[currentHistoryIndex]
    }

    private func navigateForward() {
        guard currentHistoryIndex < navigationHistory.count - 1 else { return }
        
        isNavigatingThroughHistory = true
        currentHistoryIndex += 1
        selectedItem = navigationHistory[currentHistoryIndex]
    }
    
    /// 添加导航历史
    private func addToNavigationHistory(_ newItem: NavigationItemType) {
        // 如果是通过导航按钮切换的，不添加到历史
        if isNavigatingThroughHistory {
            isNavigatingThroughHistory = false
            return
        }
        
        // 如果新项与当前历史项不同，则添加到历史
        let currentItem = currentHistoryIndex >= 0 && currentHistoryIndex < navigationHistory.count ? navigationHistory[currentHistoryIndex] : nil
        if newItem != currentItem {
            // 移除当前索引之后的历史（前进历史）
            if currentHistoryIndex >= 0 && currentHistoryIndex < navigationHistory.count - 1 {
                navigationHistory = Array(navigationHistory.prefix(currentHistoryIndex + 1))
            }
            // 添加新的导航项
            navigationHistory.append(newItem)
            currentHistoryIndex = navigationHistory.count - 1
        }
    }
    
    /// 是否可以后退
    private var canNavigateBack: Bool {
        let canBack = currentHistoryIndex > 0
        return canBack
    }
    
    /// 是否可以前进
    private var canNavigateForward: Bool {
        let canForward = currentHistoryIndex < navigationHistory.count - 1 && currentHistoryIndex >= 0
        return canForward
    }
    
    /// 将PlaylistType转换为LibrarySection
    private func playlistTypeToLibrarySection(_ playlistType: PlaylistType) -> LibrarySection {
        switch playlistType {
        case .created:
            return .myCreatedPlaylists
        case .collected:
            return .myCollectedPlaylists
        case .albums:
            return .myCollectedAlbums
        }
    }
    
}


// MARK: - NavigationItemType Extension
extension NavigationItemType {
    var title: String {
        return self.rawValue
    }
}
