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
        .onAppear {
            // 清理逻辑，不需要检查旧的导航项
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
    let onToggle: () -> Void
    let onNewPlaylist: () -> Void
    
    @EnvironmentObject private var playlistService: PlaylistService
    @EnvironmentObject private var userService: UserService
    @State private var playlists: [UserPlaylistResponse.UserPlaylist] = []
    
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
                                
                                // 发送歌单选择通知
                                NotificationCenter.default.post(
                                    name: NSNotification.Name("PlaylistSelected"),
                                    object: nil,
                                    userInfo: [
                                        "playlist": playlist,
                                        "playlistType": playlistType
                                    ]
                                )
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
}

/// 歌单项目行
struct PlaylistItemRow: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let playlistType: PlaylistType
    let isSelected: Bool
    let onSelect: () -> Void
    
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
    }
}

/// 新建歌单弹窗
struct NewPlaylistDialog: View {
    @Environment(\.presentationMode) var presentationMode
    @State private var playlistName = ""
    @State private var isCreating = false
    @EnvironmentObject private var playlistService: PlaylistService
    
    var body: some View {
        VStack(spacing: 20) {
            // 标题
            Text("新建歌单")
                .font(.title2)
                .fontWeight(.bold)
            
            // 输入框
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
            
            // 按钮
            HStack(spacing: 12) {
                Button("取消") {
                    presentationMode.wrappedValue.dismiss()
                }
                .buttonStyle(.bordered)
                
                Button("创建") {
                    createPlaylist()
                }
                .buttonStyle(.borderedProminent)
                .disabled(playlistName.isEmpty || isCreating)
                .opacity(playlistName.isEmpty ? 0.6 : 1.0)
            }
        }
        .padding(24)
        .frame(width: 300)
    }
    
    private func createPlaylist() {
        guard !playlistName.isEmpty else { return }
        
        isCreating = true
        
        Task {
            // TODO: 实现创建歌单的API调用
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 模拟网络请求
            
            await MainActor.run {
                isCreating = false
                presentationMode.wrappedValue.dismiss()
            }
        }
    }
}

#Preview {
    PlaylistSidebarView(selectedItem: .constant(.playlists))
        .frame(width: 200, height: 400)
}