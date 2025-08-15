//
//  UserProfileView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/5.
//

import SwiftUI

struct UserProfileView: View {
    @EnvironmentObject private var userService: UserService
    @State private var showLogoutConfirmation = false
    @State private var isRefreshing = false
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // 标题
                HStack {
                    Text("用户详情")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    
                    Spacer()
                    
                    // 刷新按钮
                    if userService.isLoggedIn {
                        Button(action: refreshUserInfo) {
                            HStack {
                                if isRefreshing {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.clockwise")
                                        .font(.system(size: 16))
                                        .foregroundColor(.secondary)
                                }
                            }
                            .font(.caption)
                            .foregroundColor(.blue)
                        }
                        .buttonStyle(.plain)
                        .disabled(isRefreshing)
                    }
                }
                .padding(.bottom, 8)
                
                if let userInfo = userService.currentUser {
                    // 用户头像和基本信息
                    HStack(spacing: 20) {
                        // 头像
                        if let avatar = userInfo.avatar, !avatar.isEmpty {
                            AsyncImage(url: URL(string: avatar)) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                case .failure, .empty:
                                    Image(systemName: "person.circle.fill")
                                        .foregroundColor(.secondary)
                                @unknown default:
                                    Image(systemName: "person.circle.fill")
                                        .foregroundColor(.secondary)
                                }
                            }
                            .frame(width: 80, height: 80)
                            .clipShape(Circle())
                        } else {
                            Image(systemName: "person.circle.fill")
                                .font(.system(size: 80))
                                .foregroundColor(.secondary)
                        }
                        
                        // 基本信息
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Text(userInfo.nickname.isEmpty ? userInfo.username : userInfo.nickname)
                                    .font(.title2)
                                    .fontWeight(.semibold)
                                if userService.isVipUser {
                                    Image("vip-open")
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(width: 25, height: 25)
                                }
                            }
                            
                            Text("用户ID: \(String(userInfo.userid))")
                                .font(.body)
                                .foregroundColor(.secondary)
                        }
                        
                        Spacer()
                    }
                    .padding(.vertical, 16)
                    .padding(.horizontal, 20)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color(NSColor.windowBackgroundColor))
                    )
                    
                    // 详细信息
                    VStack(alignment: .leading, spacing: 16) {
                        Text("详细信息")
                            .font(.headline)
                            .fontWeight(.semibold)
                        
                        // IP属地
                        if let loc = userService.userDetail?.loc, !loc.isEmpty {
                            Text("IP属地: \(loc)")
                                .font(.body)
                                .foregroundColor(.primary)
                        } else {
                            Text("IP属地: 未知")
                                .font(.body)
                                .foregroundColor(.primary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 16)
                    .padding(.horizontal, 20)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color(NSColor.windowBackgroundColor))
                    )
                    
                    // 操作按钮
                    VStack(spacing: 12) {
                        Button(action: {
                            showLogoutConfirmation = true
                        }) {
                            HStack {
                                Image(systemName: "rectangle.portrait.and.arrow.right")
                                Text("注销登录")
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .background(Color.red)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 16)
                    .padding(.horizontal, 20)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color(NSColor.windowBackgroundColor))
                    )
                    
                } else {
                    // 未登录状态 - 使用UnauthorizedView
                    UnauthorizedView(
                        title: "需要登录才能查看用户详情",
                        description: "登录后您可以查看个人信息、管理账户设置",
                        iconName: "person.circle",
                        iconColor: .secondary
                    )
                }
                
                Spacer()
            }
            .padding(32)
        }
        .alert("确认注销", isPresented: $showLogoutConfirmation) {
            Button("取消", role: .cancel) { }
            Button("注销", role: .destructive) {
                userService.clearUserSession()
            }
        } message: {
            Text("确定要注销登录吗？")
        }
    }
    
    // 刷新用户信息
    private func refreshUserInfo() {
        guard !isRefreshing else { return }
        
        Task {
            isRefreshing = true
            defer { isRefreshing = false }
            
            do {
                try await UserService.shared.refreshUserInfo()
            } catch {
            }
        }
    }
    
    private func formatDate(_ dateString: String) -> String {
        // 简单的日期格式化，可以根据需要调整
        return dateString
    }
}

// 信息卡片组件
struct InfoCard: View {
    let title: String
    let value: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            
            Text(value)
                .font(.body)
                .fontWeight(.medium)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(NSColor.windowBackgroundColor))
        )
    }
}

#Preview {
    UserProfileView()
        .environmentObject(UserService.shared)
}
