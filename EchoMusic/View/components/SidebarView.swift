//
//  SidebarView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/4.
//

import SwiftUI

// 左侧导航栏
struct SidebarView: View {
    @Binding var selectedItem: NavigationItemType
    @State private var showSettings = false
    @State private var showLoginSheet = false
    
    @EnvironmentObject private var userService: UserService
    @EnvironmentObject private var libraryService: LibraryService

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 顶部个人中心
            Button(action: {
                if userService.isLoggedIn {
                    selectedItem = .userProfile
                } else {
                    showLoginSheet = true
                }
            }) {
                HStack(spacing: 12) {
                    if let avatar = userService.currentUser?.avatar, !avatar.isEmpty {
                        AsyncImage(url: URL(string: avatar)) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            case .failure(_):
                                Image(systemName: "person.circle.fill")
                                    .foregroundColor(.secondary)
                            case .empty:
                                Image(systemName: "person.circle.fill")
                                    .foregroundColor(.secondary)
                                    .opacity(0.5)
                            @unknown default:
                                Image(systemName: "person.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                        .frame(width: 32, height: 32)
                        .clipShape(Circle())
                    } else {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        if userService.isLoggedIn {
                            Text(userService.currentUser?.username ?? "用户")
                                .font(.system(size: 16, weight: .medium))
                                .foregroundColor(.primary)
                            if userService.isVipUser {
                                Image("vip-open")
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(width: 25, height: 25)
                            }
                        } else {
                            Text("点击登录")
                                .font(.system(size: 16, weight: .medium))
                                .foregroundColor(.accentColor)
                        }
                    }

                    Spacer()
                }
                .frame(height: 60)
                .padding(.horizontal, 16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // 在线音乐分组
                    SidebarSectionHeader(title: "在线音乐")
                    
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(NavigationItemType.onlineMusicItems, id: \.self) { item in
                            SidebarNavigationItem(
                                title: item.rawValue,
                                icon: item.icon,
                                isSelected: selectedItem == item,
                                action: { selectedItem = item }
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)

                    // 我的音乐分组
                    SidebarSectionHeader(title: "我的音乐")
                    
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(NavigationItemType.myMusicItems, id: \.self) { item in
                            SidebarNavigationItem(
                                title: item.rawValue,
                                icon: item.icon,
                                isSelected: selectedItem == item,
                                requiresLogin: item.requiresLogin,
                                action: { 
                                    if item.requiresLogin && !userService.isLoggedIn {
                                        showLoginSheet = true
                                    } else {
                                        selectedItem = item
                                    }
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    
                    // 歌单分组
                    if userService.isLoggedIn {
                        PlaylistSectionGroup(selectedItem: $selectedItem)
                    }
                    
                    Spacer(minLength: 100)
                }
            }

            // 底部设置按钮
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Color(NSColor.separatorColor).opacity(0.3))
                    .frame(height: 0.5)
                    .padding(.horizontal, 16)

                Button(action: {
                    showSettings = true
                }) {
                    HStack(spacing: 12) {
                        Image(systemName: "gear")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.secondary)
                            .frame(width: 20)

                        Text("设置")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(.primary)

                        Spacer()
                    }
                    .frame(height: 44)
                    .padding(.horizontal, 12)
                    .background(Color.clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showLoginSheet) {
            LoginView()
        }
    }
}

// 分组标题
struct SidebarSectionHeader: View {
    let title: String
    
    var body: some View {
        VStack(spacing: 0) {
            // 分割线
            Rectangle()
                .fill(Color(NSColor.separatorColor).opacity(0.3))
                .frame(height: 0.5)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            
            // 标题
            HStack {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 16)
                Spacer()
            }
            .padding(.bottom, 8)
        }
    }
}

// 歌单分组
struct PlaylistSection: View {
    let playlistType: PlaylistType
    let isExpanded: Bool
    let onToggle: () -> Void
    let onNewPlaylist: () -> Void
    @Binding var selectedItem: NavigationItemType
    
    @EnvironmentObject private var libraryService: LibraryService
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
                        PlaylistItem(playlist: playlist, playlistType: playlistType, selectedItem: $selectedItem)
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
                    
                    // 调试信息
                    if playlists.isEmpty {
                        Text("暂无\(playlistType.rawValue)")
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                            .padding(.horizontal, 28)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .onAppear {
            loadPlaylists()
        }
    }
    
    private func loadPlaylists() {
        Task {
            await libraryService.getAllPlaylistsData()
            await MainActor.run {
                let targetType = playlistTypeToLibraryType(playlistType)
                self.playlists = libraryService.getPlaylistsByType(targetType)
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

// 歌单项目
struct PlaylistItem: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let playlistType: PlaylistType
    @Binding var selectedItem: NavigationItemType
    
    var body: some View {
        Button(action: {
            // 直接发送通知打开歌单详情，不改变主导航
            NotificationCenter.default.post(
                name: NSNotification.Name("OpenPlaylistDetailDirectly"),
                object: nil,
                userInfo: [
                    "playlist": playlist,
                    "playlistType": playlistType
                ]
            )
        }) {
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
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                Spacer()
            }
            .frame(height: 32)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// 侧边栏导航项
struct SidebarNavigationItem: View {
    let title: String
    let icon: String
    let isSelected: Bool
    let requiresLogin: Bool
    let action: () -> Void
    
    @EnvironmentObject private var userService: UserService
    
    init(title: String, icon: String, isSelected: Bool, requiresLogin: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.isSelected = isSelected
        self.requiresLogin = requiresLogin
        self.action = action
    }
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(iconColor)
                    .frame(width: 20)
                
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(textColor)
                
                Spacer()
                
                // 未登录时显示锁定图标
                if requiresLogin && !userService.isLoggedIn {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
            }
            .frame(height: 44)
            .padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(backgroundColor)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    
    private var iconColor: Color {
        if requiresLogin && !userService.isLoggedIn {
            return .secondary
        }
        return isSelected ? .accentColor : .secondary
    }
    
    private var textColor: Color {
        if requiresLogin && !userService.isLoggedIn {
            return .secondary
        }
        return isSelected ? .accentColor : .primary
    }
    
    private var backgroundColor: Color {
        if requiresLogin && !userService.isLoggedIn {
            return Color.clear
        }
        return isSelected ? Color.accentColor.opacity(0.1) : Color.clear
    }
}

// MARK: - 歌单分组管理器
struct PlaylistSectionGroup: View {
    @State private var expandedSections: Set<PlaylistType> = [.created]
    @State private var showNewPlaylistDialog = false
    @Binding var selectedItem: NavigationItemType
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(PlaylistType.allCases, id: \.self) { playlistType in
                PlaylistSection(
                    playlistType: playlistType,
                    isExpanded: expandedSections.contains(playlistType),
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
                    },
                    selectedItem: $selectedItem
                )
            }
        }
        .sheet(isPresented: $showNewPlaylistDialog) {
            NewPlaylistDialog()
        }
    }
}

// MARK: - 新建歌单弹窗
struct NewPlaylistDialog: View {
    @Environment(\.presentationMode) var presentationMode
    @State private var playlistName = ""
    @State private var isCreating = false
    @EnvironmentObject private var libraryService: LibraryService
    
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
    SidebarView(selectedItem: .constant(.home))
        .frame(width: 200, height: 400)
}
