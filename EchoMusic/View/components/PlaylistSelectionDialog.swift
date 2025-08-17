//
//  PlaylistSelectionDialog.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/17.
//

import SwiftUI

/// 歌单选择弹窗 - 用于批量添加歌曲到歌单
struct PlaylistSelectionDialog: View {
    @Environment(\.presentationMode) var presentationMode
    let selectedTracks: [PlaylistTrackInfo]
    let onAddToPlaylist: (UserPlaylistResponse.UserPlaylist, [PlaylistTrackInfo]) async -> Void
    
    @State private var searchText = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isAddingTracks = false
    
    @EnvironmentObject private var playlistService: PlaylistService
    @EnvironmentObject private var userService: UserService
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("添加到歌单")
                    .font(.title2)
                    .fontWeight(.bold)
                
                Spacer()
                
                Button("取消") {
                    presentationMode.wrappedValue.dismiss()
                }
                .foregroundColor(.secondary)
            }
            .padding()
            
            Divider()
            
            // 搜索栏
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                
                TextField("搜索歌单...", text: $searchText)
                    .textFieldStyle(.plain)
                
                if !searchText.isEmpty {
                    Button(action: { searchText = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding()
            
            Divider()
            
            // 歌单列表
            if isLoading {
                VStack {
                    ProgressView()
                    Text("加载中...")
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        // 只显示用户创建的歌单（可以添加歌曲）
                        ForEach(filteredPlaylists, id: \.global_collection_id) { playlist in
                            PlaylistSelectionRow(
                                playlist: playlist,
                                onSelect: { selectedPlaylist in
                                    Task {
                                        await addTracksToPlaylist(selectedPlaylist)
                                    }
                                }
                            )
                            .disabled(isAddingTracks)
                        }
                        
                        if filteredPlaylists.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "music.note.list")
                                    .font(.system(size: 48))
                                    .foregroundColor(.secondary)
                                Text(searchText.isEmpty ? "暂无可用歌单" : "没有找到匹配的歌单")
                                    .font(.headline)
                                    .foregroundColor(.secondary)
                                if searchText.isEmpty {
                                    Text("您需要先创建歌单才能添加歌曲")
                                        .font(.body)
                                        .foregroundColor(.secondary)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 60)
                        }
                    }
                }
            }
            
            // 底部信息
            if !selectedTracks.isEmpty {
                Divider()
                HStack {
                    Text("将要添加 \(selectedTracks.count) 首歌曲")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding()
            }
            
            // 错误信息
            if let errorMessage = errorMessage {
                Divider()
                HStack {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                    Spacer()
                }
                .padding()
            }
        }
        .frame(width: 400, height: 500)
        .onAppear {
            loadPlaylists()
        }
        .disabled(isAddingTracks)
        .overlay(
            // 添加中的遮罩
            isAddingTracks ? 
            Color.black.opacity(0.3)
                .overlay(
                    VStack {
                        ProgressView()
                        Text("添加中...")
                            .foregroundColor(.white)
                    }
                )
                .ignoresSafeArea()
            : nil
        )
    }
    
    // 过滤后的歌单列表
    private var filteredPlaylists: [UserPlaylistResponse.UserPlaylist] {
        let allPlaylists = playlistService.userCreatedPlaylists
        
        if searchText.isEmpty {
            return allPlaylists
        } else {
            return allPlaylists.filter { playlist in
                playlist.name?.localizedCaseInsensitiveContains(searchText) == true
            }
        }
    }
    
    private func loadPlaylists() {
        guard userService.isLoggedIn else {
            errorMessage = "请先登录"
            return
        }
        
        isLoading = true
        errorMessage = nil
        
        Task {
            await playlistService.getAllPlaylistsData()
            await MainActor.run {
                isLoading = false
            }
        }
    }
    
    private func addTracksToPlaylist(_ playlist: UserPlaylistResponse.UserPlaylist) async {
        await MainActor.run {
            isAddingTracks = true
            errorMessage = nil
        }
        
        await onAddToPlaylist(playlist, selectedTracks)
        
        await MainActor.run {
            isAddingTracks = false
            presentationMode.wrappedValue.dismiss()
        }
    }
}

/// 歌单选择行
struct PlaylistSelectionRow: View {
    let playlist: UserPlaylistResponse.UserPlaylist
    let onSelect: (UserPlaylistResponse.UserPlaylist) -> Void
    
    var body: some View {
        Button(action: {
            onSelect(playlist)
        }) {
            HStack(spacing: 12) {
                // 歌单封面
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
                                .font(.system(size: 12))
                        )
                }
                .frame(width: 40, height: 40)
                .cornerRadius(6)
                .clipped()
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(playlist.name ?? "未知歌单")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    
                    if let count = playlist.count {
                        Text("\(count) 首歌曲")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            Color.clear
                .onHover { isHovered in
                    // 可以添加悬停效果
                }
        )
    }
}

#Preview {
    PlaylistSelectionDialog(
        selectedTracks: [],
        onAddToPlaylist: { _, _ in }
    )
    .environmentObject(PlaylistService.shared)
    .environmentObject(UserService.shared)
}