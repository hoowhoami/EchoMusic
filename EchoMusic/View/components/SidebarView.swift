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
    @EnvironmentObject private var playlistService: PlaylistService

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

                    Spacer()
                }
                .frame(height: 30)
                .padding(.horizontal, 16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 10)

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
                                    selectedItem = item
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    
                    // 歌单分组 - 无论是否登录都显示
                    PlaylistSidebarView(selectedItem: $selectedItem)
                    
                    Spacer(minLength: 100)
                }
            }
            .padding(.top, 20)

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
                        Image(systemName: "gearshape")
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
                
                // 移除锁定图标显示逻辑
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

#Preview {
    SidebarView(selectedItem: .constant(.home))
        .frame(width: 200, height: 400)
}
