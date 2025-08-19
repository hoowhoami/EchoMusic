//
//  RecentMusicView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/15.
//

import SwiftUI


/// 最近播放音乐视图
struct RecentMusicView: View {
    @EnvironmentObject private var userService: UserService
    @State private var tracks: [PlaylistTrackInfo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isRefreshing = false
    
    var body: some View {
        Group {
            if userService.isLoggedIn {
                VStack(alignment: .leading, spacing: 0) {
                    // 统计信息头部
                    headerView
                    
                    Divider()
                    
                    // 歌曲列表
                    SongListView(
                        tracks: tracks,
                        title: "最近播放",
                        isLoading: isLoading,
                        errorMessage: errorMessage
                    )
                }
                .onAppear {
                    Task {
                        await loadRecentMusic()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("RefreshCurrentContent"))) { _ in
                    Task {
                        await loadRecentMusic()
                        // 发送刷新完成通知
                        NotificationCenter.default.post(
                            name: NSNotification.Name("RefreshCompleted"),
                            object: nil
                        )
                    }
                }
            } else {
                UnauthorizedView(
                    title: "需要登录才能查看最近播放",
                    description: "登录后您可以查看最近播放的音乐记录，继续享受音乐",
                    iconName: "clock.fill",
                    iconColor: .orange
                )
            }
        }
    }
    
    @ViewBuilder
    private var headerView: some View {
        HStack(alignment: .top, spacing: 20) {
            // 封面
            VStack(spacing: 12) {
                Image(systemName: "clock.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.orange)
                
                Text("最近播放")
                    .font(.title)
                    .fontWeight(.bold)
            }
            .frame(width: 160)
            
            // 统计信息和操作
            VStack(alignment: .leading, spacing: 8) {
                Text("共 \(tracks.count) 首歌曲")
                    .font(.title2)
                    .fontWeight(.semibold)
                
                Text("您最近播放的音乐记录")
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
                    
                    Button(action: {
                        // TODO: 实现清空播放历史功能
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: "trash")
                            Text("清空记录")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(Color.red)
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
    
    private func loadRecentMusic() async {
        guard userService.isLoggedIn else {
            return
        }
        
        await MainActor.run {
            isLoading = true
            errorMessage = nil
        }
        
        do {
            // 调用 /user/history 接口获取播放历史
            let response: UserHistoryResponse = try await NetworkService.shared.get(
                endpoint: "/user/history",
                responseType: UserHistoryResponse.self
            )
            
            await MainActor.run {
                if response.status == 1 && response.error_code == 0 {
                    if let data = response.data {
                        // 过滤出有info的歌曲
                        self.tracks = data.songs.compactMap { $0.info }
                    } else {
                        self.tracks = []
                    }
                } else {
                    self.errorMessage = "获取历史记录失败: 错误代码 \(response.error_code)"
                    self.tracks = []
                }
                self.isLoading = false
            }
            
        } catch {
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isLoading = false
                self.tracks = []
            }
        }
    }
}

#Preview {
    RecentMusicView()
        .frame(width: 800, height: 600)
        .environmentObject(UserService.shared)
        .environmentObject(PlayerService.shared)
}
