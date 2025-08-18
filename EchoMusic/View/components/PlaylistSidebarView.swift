//
//  PlaylistSidebarView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 独立的歌单侧边栏视图组件
/// 负责显示所有歌单并处理歌单选择逻辑
struct PlaylistSidebarView: View {
    @Binding var selectedItem: NavigationItemType
    @State private var selectedPlaylist: UserPlaylistResponse.UserPlaylist?
    @State private var selectedPlaylistType: PlaylistType?
    @State private var expandedSections: Set<PlaylistType> = [.created]
    @State private var showNewPlaylistDialog = false
    
    // 删除相关状态
    @State private var showDeleteConfirmation = false
    @State private var playlistToDelete: UserPlaylistResponse.UserPlaylist?
    @State private var deletePlaylistType: PlaylistType?
    @State private var isDeleting = false
    
    @EnvironmentObject private var userService: UserService
    @EnvironmentObject private var playlistService: PlaylistService
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 歌单分组标题
            SidebarSectionHeader(title: "我的歌单")
            
            // 歌单分组列表
            VStack(alignment: .leading, spacing: 0) {
                ForEach(PlaylistType.allCases, id: \.self) { playlistType in
                    PlaylistTypeSection(
                        playlistType: playlistType,
                        isExpanded: expandedSections.contains(playlistType),
                        selectedPlaylist: $selectedPlaylist,
                        selectedPlaylistType: $selectedPlaylistType,
                        selectedItem: $selectedItem,
                        playlistToDelete: $playlistToDelete,
                        deletePlaylistType: $deletePlaylistType,
                        showDeleteConfirmation: $showDeleteConfirmation,
                        onToggle: {
                            if expandedSections.contains(playlistType) {
                                expandedSections.remove(playlistType)
                            } else {
                                expandedSections.insert(playlistType)
                            }
                        },
                        onNewPlaylist: {
                            if playlistType == .created {
                                showNewPlaylistDialog = true
                            }
                        }
                    )
                }
            }
        }
        .sheet(isPresented: $showNewPlaylistDialog) {
            NewPlaylistDialog()
        }
        .alert("确认删除", isPresented: $showDeleteConfirmation) {
            Button("取消", role: .cancel) {
                playlistToDelete = nil
                deletePlaylistType = nil
            }
            Button("删除", role: .destructive) {
                if let playlist = playlistToDelete, let type = deletePlaylistType {
                    deletePlaylist(playlist, type: type)
                }
            }
        } message: {
            if let playlist = playlistToDelete, let type = deletePlaylistType {
                let actionText = type == .created ? "删除" : "取消收藏"
                Text("确定要\(actionText)歌单「\(playlist.name ?? "未知歌单")」吗？")
            }
        }
        .onAppear {
            // 清理逻辑，不需要检查旧的导航项
        }
    }
    
    // 删除歌单方法
    private func deletePlaylist(_ playlist: UserPlaylistResponse.UserPlaylist, type: PlaylistType) {
        guard !isDeleting else { return }
        
        isDeleting = true
        
        Task {
            do {
                if let listid = playlist.listid {
                    try await playlistService.deletePlaylist(listid: listid)
                    
                    // 删除成功后刷新歌单列表
                    await playlistService.refreshPlaylists()
                    
                    await MainActor.run {
                        // 如果删除的是当前选中的歌单，清除选中状态
                        if selectedPlaylist?.global_collection_id == playlist.global_collection_id {
                            selectedPlaylist = nil
                            selectedPlaylistType = nil
                            
                            // 发送歌单删除通知，让PlaylistView清除状态
                            NotificationCenter.default.post(
                                name: NSNotification.Name("PlaylistDeleted"),
                                object: nil,
                                userInfo: ["deletedPlaylistId": playlist.global_collection_id ?? ""]
                            )
                        }
                        
                        playlistToDelete = nil
                        deletePlaylistType = nil
                        isDeleting = false
                    }
                }
            } catch {
                await MainActor.run {
                    // TODO: 显示错误提示
                    print("删除歌单失败: \(error)")
                    playlistToDelete = nil
                    deletePlaylistType = nil
                    isDeleting = false
                }
            }
        }
    }
}

/// 歌单类型分组
struct PlaylistTypeSection: View {
    let playlistType: PlaylistType
    let isExpanded: Bool
    @Binding var selectedPlaylist: UserPlaylistResponse.UserPlaylist?
    @Binding var selectedPlaylistType: PlaylistType?
    @Binding var selectedItem: NavigationItemType
    @Binding var playlistToDelete: UserPlaylistResponse.UserPlaylist?
    @Binding var deletePlaylistType: PlaylistType?
    @Binding var showDeleteConfirmation: Bool
    let onToggle: () -> Void
    let onNewPlaylist: () -> Void
    
    @EnvironmentObject private var playlistService: PlaylistService
    @EnvironmentObject private var userService: UserService
    @State private var playlists: [UserPlaylistResponse.UserPlaylist] = []
    @State private var isRefreshing = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 分组头部
            Button(action: onToggle) {
                HStack(spacing: 12) {
                    Image(systemName: playlistType.icon)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(.secondary)
                        .frame(width: 20)
                    
                    Text(playlistType.rawValue)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.primary)
                    
                    Spacer()
                    
                    // 只在创建的歌单分组显示+号
                    if playlistType == .created {
                        Button(action: onNewPlaylist) {
                            Image(systemName: "plus")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    
                    // 刷新按钮
                    Button(action: { refreshSection() }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                            .rotationEffect(.degrees(isRefreshing ? 360 : 0))
                            .animation(isRefreshing ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isRefreshing)
                    }
                    .buttonStyle(.plain)
                    .disabled(isRefreshing)
                    
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(height: 44)
                .padding(.horizontal, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            
            // 歌单列表
            if isExpanded {
                VStack(alignment: .leading, spacing: 2) {
                    // 加载状态显示
                    if playlistService.isLoadingMyPlaylists {
                        HStack {
                            ProgressView()
                                .scaleEffect(0.8)
                            Text("加载中...")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                        .frame(height: 32)
                        .padding(.horizontal, 28)
                    } else {
                            ForEach(Array(playlists.prefix(5).enumerated()), id: \.offset) { index, playlist in
                            PlaylistItemRow(
                                playlist: playlist,
                                playlistType: playlistType,
                                isSelected: selectedPlaylist?.global_collection_id == playlist.global_collection_id,
                                onSelect: {
                                    // 设置主导航为歌单
                                    selectedItem = .playlists
                                    // 选中当前歌单
                                    selectedPlaylist = playlist
                                    selectedPlaylistType = playlistType
                                    
                                    // 延迟发送歌单选择通知，确保PlaylistView已经完全初始化
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                        NotificationCenter.default.post(
                                            name: NSNotification.Name("PlaylistSelected"),
                                            object: nil,
                                            userInfo: [
                                                "playlist": playlist,
                                                "playlistType": playlistType
                                            ]
                                        )
                                    }
                                },
                                onDelete: {
                                    // 设置要删除的歌单并显示确认对话框
                                    playlistToDelete = playlist
                                    deletePlaylistType = playlistType
                                    showDeleteConfirmation = true
                                }
                            )
                        }
                        
                        if playlists.count > 5 {
                            Button("查看更多...") {
                                // TODO: 显示完整列表
                            }
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 8)
                        }
                        
                        // 空状态提示
                        if playlists.isEmpty {
                            if userService.isLoggedIn {
                                Text("暂无\(playlistType.rawValue)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .padding(.horizontal, 28)
                            } else {
                                Text("登录后查看\(playlistType.rawValue)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .padding(.horizontal, 28)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .onAppear {
            loadPlaylists()
        }
        .onReceive(userService.$currentUser) { currentUser in
            // 监听用户状态变化，登录后重新加载歌单数据
            if currentUser != nil {
                loadPlaylists()
            } else {
                playlists = []
            }
        }
        .onReceive(playlistService.$userCreatedPlaylists) { _ in
            updatePlaylists()
        }
        .onReceive(playlistService.$collectedPlaylists) { _ in
            updatePlaylists()
        }
        .onReceive(playlistService.$collectedAlbums) { _ in
            updatePlaylists()
        }
    }
    
    private func loadPlaylists() {
        // 只有在登录状态下才加载歌单数据
        guard userService.isLoggedIn else {
            self.playlists = []
            return
        }
        
        Task {
            await playlistService.getAllPlaylistsData()
            await MainActor.run {
                let targetType = playlistTypeToLibraryType(playlistType)
                self.playlists = playlistService.getPlaylistsByType(targetType)
            }
        }
    }
    
    private func playlistTypeToLibraryType(_ type: PlaylistType) -> LibraryContentType {
        switch type {
        case .created:
            return .userCreatedPlaylists
        case .collected:
            return .collectedPlaylists
        case .albums:
            return .collectedAlbums
        }
    }
    
    /// 刷新当前分组
    private func refreshSection() {
        guard !isRefreshing else { return }
        
        isRefreshing = true
        
        Task {
            await playlistService.refreshSection()
            await MainActor.run {
                isRefreshing = false
            }
        }
    }
    
    /// 更新歌单列表
    private func updatePlaylists() {
        let targetType = playlistTypeToLibraryType(playlistType)
        self.playlists = playlistService.getPlaylistsByType(targetType)
    }
}

/// 歌单项目行
struct PlaylistItemRow: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let playlistType: PlaylistType
    let isSelected: Bool
    let onSelect: () -> Void
    let onDelete: (() -> Void)?
    
    @State private var isHovered = false
    @EnvironmentObject private var userService: UserService
    
    var body: some View {
        HStack(spacing: 8) {
            AsyncImage(url: URL(string: playlist.pic ?? "")) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "music.note")
                            .foregroundColor(.gray)
                            .font(.system(size: 10))
                    )
            }
            .frame(width: 24, height: 24)
            .cornerRadius(4)
            .clipped()
            
            Text(playlist.name ?? "未知歌单")
                .font(.system(size: 12))
                .foregroundColor(isSelected ? .accentColor : .primary)
                .lineLimit(1)
            
            Spacer()
            
            // 删除按钮 - 只在悬停时显示，且只对用户创建的歌单或收藏的歌单显示
            if isHovered && canDelete {
                Button(action: {
                    onDelete?()
                }) {
                    Image(systemName: "minus.circle.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                    
                }
                .buttonStyle(.plain)
                .transition(.opacity.combined(with: .scale))
            }
        }
        .frame(height: 32)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            onSelect()
        }
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.2)) {
                isHovered = hovering
            }
        }
    }
    
    // 判断是否可以删除：用户创建的歌单可以删除，收藏的歌单可以取消收藏
    private var canDelete: Bool {
        let currentUserId = userService.currentUser?.userid
        
        switch playlistType {
        case .created:
            // 用户创建的歌单：非"我喜欢"歌单可以删除
            return playlist.list_create_userid == currentUserId && playlist.name != "我喜欢"
        case .collected:
            // 收藏的歌单：可以取消收藏
            return playlist.list_create_userid != currentUserId
        case .albums:
            // 收藏的专辑：可以取消收藏
            return playlist.list_create_userid != currentUserId
        }
    }
}

/// 新建歌单弹窗
struct NewPlaylistDialog: View {
    @Environment(\.presentationMode) var presentationMode
    @State private var playlistName = ""
    @State private var isPrivate = false
    @State private var isCreating = false
    @State private var errorMessage: String?
    @EnvironmentObject private var playlistService: PlaylistService
    
    var body: some View {
        VStack(spacing: 20) {
            // 标题
            Text("新建歌单")
                .font(.title2)
                .fontWeight(.bold)
            
            // 输入框
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("歌单名称")
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                    
                    TextField("请输入歌单名称", text: $playlistName)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                        .onSubmit {
                            if !playlistName.isEmpty {
                                createPlaylist()
                            }
                        }
                }
                
                // 隐私设置
                HStack {
                    Toggle("设为隐私歌单", isOn: $isPrivate)
                        .font(.system(size: 14))
                    Spacer()
                }
            }
            
            // 错误信息
            if let errorMessage = errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
            }
            
            // 按钮
            HStack(spacing: 12) {
                Button("取消") {
                    presentationMode.wrappedValue.dismiss()
                }
                .buttonStyle(.bordered)
                .disabled(isCreating)
                
                Button("创建") {
                    createPlaylist()
                }
                .buttonStyle(.borderedProminent)
                .disabled(playlistName.isEmpty || isCreating)
                .opacity(playlistName.isEmpty ? 0.6 : 1.0)
            }
        }
        .padding(24)
        .frame(width: 320)
    }
    
    private func createPlaylist() {
        guard !playlistName.isEmpty && !isCreating else { return }
        
        isCreating = true
        errorMessage = nil
        
        Task {
            do {
                let _ = try await playlistService.createPlaylist(name: playlistName, isPrivate: isPrivate)
                
                // 创建成功后刷新歌单列表
                await playlistService.refreshPlaylists()
                
                await MainActor.run {
                    presentationMode.wrappedValue.dismiss()
                }
            } catch {
                await MainActor.run {
                    errorMessage = "创建失败: \(error.localizedDescription)"
                    isCreating = false
                }
            }
        }
    }
}

#Preview {
    PlaylistSidebarView(selectedItem: .constant(.playlists))
        .frame(width: 200, height: 400)
}
