//
//  FavoriteMusicView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI

/// 喜欢的音乐视图
struct FavoriteMusicView: View {
    @EnvironmentObject private var userService: UserService
    @State private var playlistService = PlaylistService.shared
    @State private var tracks: [PlaylistTrackInfo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isRefreshing = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 统计信息头部
            headerView
            
            Divider()
            
            // 歌曲列表
            SongListView(
                tracks: tracks,
                title: "喜欢的歌曲",
                isLoading: isLoading,
                errorMessage: errorMessage
            )
        }
        .onAppear {
            Task {
                await loadFavoriteMusic()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCurrentContent"))) { _ in
            Task {
                await loadFavoriteMusic()
                // 发送刷新完成通知
                NotificationCenter.default.post(
                    name: NSNotification.Name("RefreshCompleted"),
                    object: nil
                )
            }
        }
    }
    
    @ViewBuilder
    private var headerView: some View {
        HStack(alignment: .top, spacing: 20) {
            // 封面
            VStack(spacing: 12) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.red)
                
                Text("喜欢的音乐")
                    .font(.title)
                    .fontWeight(.bold)
            }
            .frame(width: 160)
            
            // 统计信息和操作
            VStack(alignment: .leading, spacing: 8) {
                Text("共 \(tracks.count) 首歌曲")
                    .font(.title2)
                    .fontWeight(.semibold)
                
                Text("收藏您喜欢的音乐，随时聆听")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                
                HStack(spacing: 12) {
                    Button(action: {
                        let songs = tracks.map { Song(from: $0) }
                        PlayerService.shared.playAllSongs(songs)
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: "play.fill")
                            Text("播放全部")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(tracks.isEmpty ? Color.gray : Color.accentColor)
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .disabled(tracks.isEmpty)
                }
                .offset(y: -2)
            }
            
            Spacer()
        }
        .padding(.all, 20)
    }
    
    private func loadFavoriteMusic() async {
        guard userService.isLoggedIn else {
            await MainActor.run {
                self.errorMessage = "用户未登录"
            }
            return
        }
        
        await MainActor.run {
            isLoading = true
            errorMessage = nil
        }
        
        do {
            // 获取"我喜欢"歌单ID
            if let likedPlaylistId = playlistService.likedPlaylistId {
                // 获取所有页的歌曲列表
                var allTracks: [PlaylistTrackInfo] = []
                var currentPage = 1
                let pageSize = 100
                
                // 持续获取页面直到没有更多数据
                while true {
                    let trackList = try await playlistService.getPlaylistTracks(
                        globalCollectionId: likedPlaylistId,
                        page: currentPage,
                        pageSize: pageSize
                    )
                    
                    if trackList.isEmpty {
                        break
                    }
                    
                    allTracks.append(contentsOf: trackList)
                    
                    // 如果返回的歌曲数少于页大小，说明是最后一页
                    if trackList.count < pageSize {
                        break
                    }
                    
                    currentPage += 1
                }
                
                await MainActor.run {
                    self.tracks = allTracks
                    self.isLoading = false
                }
            } else {
                await MainActor.run {
                    self.errorMessage = "未找到喜欢的歌单"
                    self.isLoading = false
                }
            }
        } catch {
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isLoading = false
            }
        }
    }
}

#Preview {
    FavoriteMusicView()
        .frame(width: 800, height: 600)
        .environmentObject(UserService.shared)
        .environmentObject(PlaylistService.shared)
        .environmentObject(PlayerService.shared)
}