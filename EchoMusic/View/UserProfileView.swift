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
    
    // VIP相关状态
    @State private var isCheckingIn = false
    @State private var isClaimingVip = false
    @State private var vipActionMessage = ""
    @State private var showVipActionResult = false
    @State private var monthVipRecord: MonthVipRecordResponse.MonthVipRecordData?
    @State private var vipUnionStatus: UserVipResponse.UserVipData?
    @State private var youthVipInfo: YouthVipResponse.YouthVipData?
    
    // 防频繁调用相关状态
    @State private var lastCheckInTime: Date?
    @State private var lastClaimTime: Date?
    @State private var todayCheckInStatus: Bool = false // 今天是否已签到
    
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
                    
                    // VIP签到日历
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .center) {
                            Text("VIP签到日历")
                                .font(.headline)
                                .fontWeight(.semibold)
                            
                            Spacer()
                            
                            // 本月签到统计（居中显示）
                            Text("本月已签到 \(getCheckedInDaysCount()) 天")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundColor(.orange)
                            
                            Spacer()
                            
                            // 当前月份显示（右侧）
                            Text(getCurrentMonthString())
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        
                        // 签到日历网格
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 8) {
                            // 星期标题
                            ForEach(["日", "一", "二", "三", "四", "五", "六"], id: \.self) { weekday in
                                Text(weekday)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                    .frame(height: 30)
                            }
                            
                            // 日期网格
                            ForEach(generateCalendarDays(), id: \.day) { dayInfo in
                                CheckInDayView(
                                    dayInfo: dayInfo,
                                    isCheckingIn: isCheckingIn,
                                    onCheckIn: { performCheckIn(for: dayInfo.day) }
                                )
                            }
                        }
                        
                        // VIP信息摘要
                        VStack(spacing: 12) {
                            // 今日领取进度（突出显示）
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("今日领取进度")
                                        .font(.subheadline)
                                        .fontWeight(.semibold)
                                        .foregroundColor(.primary)
                                    HStack(spacing: 4) {
                                        if let youthVip = youthVipInfo {
                                            Text("\(youthVip.done)/\(youthVip.total)")
                                                .font(.title2)
                                                .fontWeight(.bold)
                                                .foregroundColor(.orange)
                                        } else {
                                            Text("--/--")
                                                .font(.title2)
                                                .fontWeight(.bold)
                                                .foregroundColor(.gray)
                                        }
                                        Text("次")
                                            .font(.subheadline)
                                            .foregroundColor(.secondary)
                                    }
                                    if getTodayClaimedCount() > 0 {
                                        Text("今日已获得 \(getTodayClaimedCount() * 3) 小时")
                                            .font(.caption)
                                            .foregroundColor(.green)
                                    }
                                }
                                
                                Spacer()
                                
                                // 领取VIP按钮
                                VStack(spacing: 4) {
                                    Button(action: performClaimVip) {
                                        HStack(spacing: 4) {
                                            if isClaimingVip {
                                                ProgressView()
                                                    .controlSize(.small)
                                            } else {
                                                Image(systemName: "gift.fill")
                                            }
                                            Text("领取VIP")
                                        }
                                        .font(.subheadline)
                                        .foregroundColor(.white)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 8)
                                        .background(canClaimVip() ? Color.orange : Color.gray)
                                        .cornerRadius(8)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(!canClaimVip() || isClaimingVip)
                                    
                                    Text("每次3小时，每日8次")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                }
                            }
                            
                            // VIP详细信息
                            if let youthVip = youthVipInfo {
                                HStack(spacing: 16) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("剩余VIP")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                        Text("\(youthVip.remain_vip_hour)小时")
                                            .font(.headline)
                                            .foregroundColor(.orange)
                                    }
                                    
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("总进度")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                        Text("\(youthVip.done)/\(youthVip.total)")
                                            .font(.headline)
                                            .foregroundColor(.blue)
                                    }
                                    
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("剩余次数")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                        Text("\(youthVip.remain)次")
                                            .font(.headline)
                                            .foregroundColor(.green)
                                    }
                                    
                                    Spacer()
                                }
                            } else {
                                // 如果没有青年VIP数据，显示提示信息
                                HStack {
                                    Text("点击领取VIP开始今日领取，每次3小时，每日最多8次")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Spacer()
                                }
                            }
                        }
                        .padding(.top, 8)
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
        .alert("VIP操作结果", isPresented: $showVipActionResult) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(vipActionMessage)
        }
        .onAppear {
            loadVipStatus()
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
                loadVipStatus()
            } catch {}
        }
    }
    
    // 加载VIP状态
    private func loadVipStatus() {
        guard userService.isLoggedIn else { return }
        
        Task {
            do {
                // 并行加载月度记录、联合状态和青年VIP信息
                async let monthRecordTask = userService.getMonthVipRecord()
                async let unionStatusTask = userService.getVipUnionStatus()
                
                let (monthRecord, unionStatus) = try await (monthRecordTask, unionStatusTask)
                
                // 青年VIP信息获取 - 暂时不在页面加载时获取
                // 只有在用户点击领取VIP后才会有数据
                let youthVip: YouthVipResponse.YouthVipData? = nil
                // 不主动调用claimVip，避免意外领取
                
                await MainActor.run {
                    self.monthVipRecord = monthRecord.data
                    self.vipUnionStatus = unionStatus.data
                    self.youthVipInfo = youthVip
                    // 检查今天是否已签到
                    self.todayCheckInStatus = self.checkTodaySignInStatus()
                }
            } catch {
                // 静默处理错误，不影响主要功能
            }
        }
    }
    
    // 检查今天是否已签到
    private func checkTodaySignInStatus() -> Bool {
        guard let record = monthVipRecord?.list else { return false }
        
        let today = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd"
        let todayString = formatter.string(from: today)
        
        return record.contains { vipRecord in
            guard let day = vipRecord.day else { return false }
            return day.hasSuffix(todayString)
        }
    }
    
    // 执行签到
    private func performCheckIn(for day: Int) {
        guard canCheckIn(for: day) && !isCheckingIn else { return }
        
        Task {
            isCheckingIn = true
            defer { isCheckingIn = false }
            
            do {
                let response = try await userService.dailyCheckIn()
                
                let success = response.status == 1
                let message = success ? "签到成功！" : "签到失败: \(response.error_msg)"
                
                if success {
                    lastCheckInTime = Date()
                    todayCheckInStatus = true
                    // 刷新VIP信息
                    try await userService.refreshUserInfo()
                    loadVipStatus()
                } else {
                    // 即使失败也设置冷却时间，防止频繁重试
                    lastCheckInTime = Date()
                }
                
                await MainActor.run {
                    vipActionMessage = message
                    showVipActionResult = true
                }
            } catch {
                // 网络错误等情况也设置冷却时间
                lastCheckInTime = Date()
                await MainActor.run {
                    vipActionMessage = "签到失败: \(error.localizedDescription)"
                    showVipActionResult = true
                }
            }
        }
    }
    
    // 执行领取VIP
    private func performClaimVip() {
        guard canClaimVip() && !isClaimingVip else { return }
        
        Task {
            isClaimingVip = true
            defer { isClaimingVip = false }
            
            do {
                let response = try await userService.claimVip()
                
                let success = response.status == 1
                let message: String
                
                if success {
                    let remainHour = response.data.remain_vip_hour
                    let done = response.data.done
                    let total = response.data.total
                    let remain = response.data.remain
                    let awardHour = response.data.award_vip_hour
                    
                    message = "VIP领取成功！本次获得 \(awardHour) 小时，今日已领 \(done)/\(total) 次。剩余VIP: \(remainHour)小时，剩余次数: \(remain) 次"
                    lastClaimTime = Date()
                    
                    // 更新青年VIP信息
                    self.youthVipInfo = response.data
                    
                    // 只刷新用户基本信息，不调用loadVipStatus避免重置VIP数据
                    try await userService.refreshUserInfo()
                } else {
                    message = "VIP领取失败: \(response.error_msg)"
                }
                
                await MainActor.run {
                    vipActionMessage = message
                    showVipActionResult = true
                }
            } catch {
                await MainActor.run {
                    vipActionMessage = "VIP领取失败: \(error.localizedDescription)"
                    showVipActionResult = true
                }
            }
        }
    }
    
    // 检查是否可以签到
    private func canCheckIn(for day: Int) -> Bool {
        guard userService.isLoggedIn else { return false }
        
        let today = Calendar.current.component(.day, from: Date())
        
        // 只有今天可以签到
        if day != today { return false }
        
        // 检查今天是否已经签到过（基于API数据）
        if todayCheckInStatus { return false }
        
        // 检查是否已经签到过（从记录中检查）
        if isAlreadyCheckedIn(for: day) { return false }
        
        // 检查签到冷却时间（防止频繁签到）
        if let lastTime = lastCheckInTime {
            let timeSinceLastCheckIn = Date().timeIntervalSince(lastTime)
            if timeSinceLastCheckIn < 60 { // 1分钟冷却时间
                return false
            }
        }
        
        return true
    }
    
    // 检查是否可以领取VIP
    private func canClaimVip() -> Bool {
        guard userService.isLoggedIn else { return false }
        
        // 检查今日是否已达到最大领取次数
        if let youthVip = youthVipInfo, youthVip.done >= youthVip.total {
            return false
        }
        
        // 检查冷却时间（5分钟）
        if let lastTime = lastClaimTime {
            let timeSinceLastClaim = Date().timeIntervalSince(lastTime)
            if timeSinceLastClaim < 300 { // 5分钟冷却
                return false
            }
        }
        
        // 检查是否还有剩余次数
        if let youthVip = youthVipInfo {
            return youthVip.remain > 0
        }
        
        return true
    }
    
    // 检查是否已经签到（基于API返回的具体日期）
    private func isAlreadyCheckedIn(for day: Int) -> Bool {
        guard let record = monthVipRecord?.list else { return false }
        
        // 获取当前月份和年份
        let calendar = Calendar.current
        let now = Date()
        let currentYear = calendar.component(.year, from: now)
        let currentMonth = calendar.component(.month, from: now)
        
        // 构造要检查的日期字符串格式
        let dayString = String(format: "%02d", day)
        let monthString = String(format: "%02d", currentMonth)
        
        return record.contains { vipRecord in
            guard let recordDay = vipRecord.day else { return false }
            // 检查是否包含当前月-日格式，例如 "08-15"
            return recordDay.hasSuffix("\(monthString)-\(dayString)")
        }
    }
    
    // 获取已签到天数
    private func getCheckedInDaysCount() -> Int {
        return monthVipRecord?.list?.count ?? 0
    }
    
    // 获取当前月份字符串
    private func getCurrentMonthString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年MM月"
        return formatter.string(from: Date())
    }
    
    // 生成日历天数信息
    private func generateCalendarDays() -> [CalendarDayInfo] {
        let calendar = Calendar.current
        let now = Date()
        let currentMonth = calendar.component(.month, from: now)
        let currentYear = calendar.component(.year, from: now)
        let today = calendar.component(.day, from: now)
        
        // 获取当月第一天
        guard let firstDayOfMonth = calendar.date(from: DateComponents(year: currentYear, month: currentMonth, day: 1)) else {
            return []
        }
        
        // 获取当月有多少天
        guard let daysInMonth = calendar.range(of: .day, in: .month, for: firstDayOfMonth)?.count else {
            return []
        }
        
        // 获取第一天是星期几（0=Sunday）
        let firstWeekday = calendar.component(.weekday, from: firstDayOfMonth) - 1
        
        var days: [CalendarDayInfo] = []
        
        // 添加空白天数
        for _ in 0..<firstWeekday {
            days.append(CalendarDayInfo(day: 0, isToday: false, isCheckedIn: false, canCheckIn: false))
        }
        
        // 添加当月所有天数
        for day in 1...daysInMonth {
            let isToday = day == today
            let isCheckedIn = isAlreadyCheckedIn(for: day)
            let canCheckIn = self.canCheckIn(for: day)
            
            days.append(CalendarDayInfo(
                day: day,
                isToday: isToday,
                isCheckedIn: isCheckedIn,
                canCheckIn: canCheckIn
            ))
        }
        
        return days
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
    
    // 获取今日已领取VIP次数
    private func getTodayClaimedCount() -> Int {
        // 如果没有youthVipInfo数据，返回0（表示尚未开始领取）
        guard let youthVip = youthVipInfo else { return 0 }
        
        // 直接使用接口返回的done字段，表示已完成的次数
        return youthVip.done
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

// MARK: - 日历相关数据结构和组件

/// 日历天信息
struct CalendarDayInfo {
    let day: Int            // 日期，0表示空白
    let isToday: Bool       // 是否是今天
    let isCheckedIn: Bool   // 是否已签到
    let canCheckIn: Bool    // 是否可以签到
}

/// 签到日期视图
struct CheckInDayView: View {
    let dayInfo: CalendarDayInfo
    let isCheckingIn: Bool
    let onCheckIn: () -> Void
    
    var body: some View {
        Button(action: {
            if dayInfo.canCheckIn {
                onCheckIn()
            }
        }) {
            ZStack {
                // 背景
                RoundedRectangle(cornerRadius: 6)
                    .fill(backgroundColor)
                    .frame(width: 36, height: 36)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(borderColor, lineWidth: borderWidth)
                    )
                
                // 内容
                if dayInfo.day == 0 {
                    // 空白天
                    EmptyView()
                } else if dayInfo.isCheckedIn {
                    // 已签到：显示日期数字和勾号叠加
                    ZStack {
                        Text("\(dayInfo.day)")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(.primary)
                        
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                    .font(.system(size: 12))
                                    .offset(x: 2, y: 2)
                            }
                        }
                    }
                } else if isCheckingIn && dayInfo.canCheckIn {
                    // 签到中：显示加载指示器
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.white)
                } else {
                    // 显示日期数字
                    Text("\(dayInfo.day)")
                        .font(.system(size: 14, weight: dayInfo.isToday ? .bold : .medium))
                        .foregroundColor(textColor)
                }
                
                // 今天的特殊标识
                if dayInfo.isToday && !dayInfo.isCheckedIn {
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Circle()
                                .fill(Color.blue)
                                .frame(width: 6, height: 6)
                                .offset(x: -2, y: -2)
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!dayInfo.canCheckIn || dayInfo.day == 0)
        .opacity(dayInfo.day == 0 ? 0 : 1.0)
        .animation(.easeInOut(duration: 0.2), value: dayInfo.isCheckedIn)
    }
    
    private var backgroundColor: Color {
        if dayInfo.day == 0 {
            return .clear
        } else if dayInfo.isCheckedIn {
            return .green.opacity(0.15)
        } else if dayInfo.isToday && dayInfo.canCheckIn {
            return .blue
        } else if dayInfo.isToday {
            // 今天但不能签到（比如已经签过了）
            return .gray.opacity(0.3)
        } else if dayInfo.canCheckIn {
            return Color(NSColor.controlBackgroundColor)
        } else {
            // 不可签到的历史日期
            return Color(NSColor.controlBackgroundColor).opacity(0.3)
        }
    }
    
    private var borderColor: Color {
        if dayInfo.isCheckedIn {
            return .green.opacity(0.3)
        } else if dayInfo.isToday && dayInfo.canCheckIn {
            return .blue.opacity(0.5)
        } else if dayInfo.isToday {
            // 今天但不能签到
            return .gray.opacity(0.5)
        } else {
            return .clear
        }
    }
    
    private var borderWidth: CGFloat {
        return (dayInfo.isCheckedIn || dayInfo.isToday) ? 1 : 0
    }
    
    private var textColor: Color {
        if dayInfo.isToday && dayInfo.canCheckIn {
            return .white
        } else if dayInfo.isToday {
            // 今天但不能签到
            return .gray
        } else if dayInfo.canCheckIn {
            return .primary
        } else {
            // 不可签到的历史日期
            return .secondary.opacity(0.6)
        }
    }
}
