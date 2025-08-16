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
                                
                                // vip标识
                                if let vipInfo = userService.vipInfo,
                                   let busiVip = vipInfo.busi_vip,
                                   busiVip.count > 0
                                {
                                    // svip标识
                                    if busiVip.first?.is_vip == 1 {
                                        Text("SVIP")
                                            .font(.caption2)
                                            .fontWeight(.bold)
                                            .foregroundColor(.orange)
                                            .padding(.horizontal, 2)
                                            .padding(.vertical, 0.5)
                                            .background(Color.orange.opacity(0.1))
                                            .cornerRadius(2)
                                    }
                                    
                                    // tvip标识
                                    if busiVip.count > 1,
                                       busiVip[1].is_vip == 1
                                    {
                                        Text("TVIP")
                                            .font(.caption2)
                                            .fontWeight(.bold)
                                            .foregroundColor(.blue)
                                            .padding(.horizontal, 2)
                                            .padding(.vertical, 0.5)
                                            .background(Color.orange.opacity(0.1))
                                            .cornerRadius(2)
                                    }
                                 }
                              }
                            
                            Text("Lv.\(userService.userDetail?.p_grade ?? 0)")
                                .font(.body)
                                .foregroundColor(.secondary)
                            
                            Text("用户签名: \(userService.userDetail?.descri ?? "暂无~")")
                                .font(.caption)
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
                    
                    // vip信息
                    VStack(alignment: .leading, spacing: 16) {
                        
                        HStack(alignment: .center) {
                            Text("VIP信息")
                                .font(.headline)
                                .fontWeight(.semibold)
                            
                            Spacer()
                            
                            Text("签到")
                                .font(.headline)
                                .fontWeight(.semibold)
                            
                            Text("领取VIP")
                                .font(.headline)
                                .fontWeight(.semibold)

                        }
                        
                       
                        
                        // vip标识
                        if let vipInfo = userService.vipInfo,
                           let busiVip = vipInfo.busi_vip,
                           busiVip.count > 0
                        {
                            // svip标识
                            if let svip = busiVip.first, svip.is_vip == 1 {
                                InfoRowItem(label: "SVIP时间", value: "\(svip.vip_begin_time ?? "未知") ~ \(svip.vip_end_time ?? "未知")")
                            }
                            
                            // tvip标识
                            if busiVip.count > 1 {
                                let tvip = busiVip[1]
                                if tvip.is_vip == 1 {
                                    InfoRowItem(label: "TVIP时间", value: "\(tvip.vip_begin_time ?? "未知") ~ \(tvip.vip_end_time ?? "未知")")
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                        
                        // 每行2个，左右布局
                        VStack(spacing: 16) {
                            // 第一行：用户ID | 等级
                            HStack(spacing: 20) {
                                // ID肯定存在
                                InfoRowItem(label: "用户ID", value: String(userInfo.userid))
                                if let gender = userService.userDetail?.gender {
                                    InfoRowItem(label: "用户性别", value: formatGender(gender))
                                } else {
                                    Spacer()
                                }
                            }
                            
                            // 第二行：听歌时长 | 用户乐龄
                            HStack(spacing: 20) {
                                if let duration = userService.userDetail?.duration {
                                    InfoRowItem(label: "听歌时长", value: formatDuration(duration))
                                } else {
                                    Spacer()
                                }
                                
                                if let rtime = userService.userDetail?.rtime {
                                    InfoRowItem(label: "用户乐龄", value: formatRegTime(rtime))
                                } else {
                                    Spacer()
                                }
                            }
                            
                            // 第三行：IP属地 | 预留位置
                            HStack(spacing: 20) {
                                if let loc = userService.userDetail?.loc, !loc.isEmpty {
                                    InfoRowItem(label: "IP属地", value: loc)
                                } else {
                                    InfoRowItem(label: "IP属地", value: "未知")
                                }
                                
                                // 右侧预留位置，可以添加其他信息
                                Spacer()
                            }
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
            Button("取消", role: .cancel) {}
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
            } catch {}
        }
    }
    
    private func formatGender(_ gender: Int) -> String {
        switch gender {
        case 1:
            return "男"
        case 0:
            return "女"
        default:
            return "保密"
        }
    }
    
    private func formatDuration(_ duration: Int) -> String {
        // 分钟转为小时和分钟
        let hours = duration / 60
        let minutes = duration % 60
        
        if hours == 0 {
            return "\(minutes)分钟"
        } else if minutes == 0 {
            return "\(hours)小时"
        } else {
            return "\(hours)小时\(minutes)分钟"
        }
    }
    
    private func formatRegTime(_ regTime: Int) -> String {
        // 当前时间 - 注册时间戳 转为年和月
        // 将时间戳转换为Date
        let regDate = Date(timeIntervalSince1970: TimeInterval(regTime))
        let currentDate = Date()
        
        // 使用Calendar计算差值
        let calendar = Calendar.current
        let components = calendar.dateComponents([.year, .month], from: regDate, to: currentDate)
        
        guard let years = components.year, let months = components.month, years >= 0, months >= 0 else {
            return "刚刚" // 处理异常情况或未来时间
        }
        
        if years == 0 {
            return "\(months)个月"
        } else if months == 0 {
            return "\(years)年"
        } else {
            return "\(years)年\(months)个月"
        }
    }
}

// 信息行项目组件
struct InfoRowItem: View {
    let label: String
    let value: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            
            Text(value)
                .font(.body)
                .foregroundColor(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
