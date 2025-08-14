//
//  LoginView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/5.
//

import SwiftUI

struct LoginView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var userService: UserService
    
    // 登录方式
    @State private var loginType: LoginType = .mobile
    
    // 手机号登录相关
    @State private var mobile = ""
    @State private var verificationCode = ""
    @State private var canSendCode = true
    @State private var countdownSeconds = 0
    
    // 二维码登录相关
    @State private var qrKey = ""
    @State private var qrCodeURL = ""
    @State private var qrCodeImage: String?
    @State private var qrStatus: QRCodeStatus = .waiting
    @State private var isPollingQR = false
    @State private var qrTimer: Timer?
    
    // 通用状态
    @State private var isLoading = false
    @State private var errorMessage = ""
    @State private var showError = false
    
    private let loginService = LoginService.shared
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                
                // 标题
                VStack(spacing: 8) {
                    Text("登录 EchoMusic")
                        .font(.title)
                        .fontWeight(.bold)
                    
                    Text("登录以同步您的音乐和播放列表")
                        .font(.body)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 20)
                
                // 登录方式选择
                Picker("登录方式", selection: $loginType) {
                    Text("手机验证码").tag(LoginType.mobile)
                    Text("扫码登录").tag(LoginType.qrcode)
                }
                .pickerStyle(.segmented)
                .controlSize(.large)
                .frame(width: 350)
                
                // 登录表单
                Group {
                    switch loginType {
                    case .mobile:
                        mobileLoginForm
                    case .qrcode:
                        qrCodeLoginForm
                    default:
                        mobileLoginForm
                    }
                }
                
                Spacer()
            }
            .padding(32)
            .frame(width: 500, height: 500)
        }
        .alert("登录失败", isPresented: $showError) {
            Button("确定") { }
        } message: {
            Text(errorMessage)
        }
    }
    
    // MARK: - 登录表单视图
    
    @ViewBuilder
    private var mobileLoginForm: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text("手机号")
                    .font(.headline)
                
                TextField("请输入手机号", text: $mobile)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .frame(height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(NSColor.controlBackgroundColor))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                    )
            }
            
            VStack(alignment: .leading, spacing: 8) {
                Text("验证码")
                    .font(.headline)
                
                HStack {
                    TextField("请输入验证码", text: $verificationCode)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12)
                        .frame(height: 44)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color(NSColor.controlBackgroundColor))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                        )
                    
                    Button(action: sendVerificationCode) {
                        Text(canSendCode ? "发送验证码" : "\(countdownSeconds)s")
                            .font(.system(size: 12))
                            .foregroundColor(canSendCode ? .white : .secondary)
                    }
                    .disabled(!canSendCode || mobile.isEmpty)
                    .buttonStyle(.plain)
                    .frame(width: 80, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(canSendCode && !mobile.isEmpty ? Color.accentColor : Color.gray.opacity(0.3))
                    )
                }
            }
            
            Button(action: performMobileLogin) {
                HStack {
                    if isLoading {
                        ProgressView()
                            .scaleEffect(0.8)
                            .progressViewStyle(CircularProgressViewStyle())
                    }
                    
                    Text(isLoading ? "登录中..." : "登录")
                        .fontWeight(.medium)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Color.accentColor)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
            .disabled(mobile.isEmpty || verificationCode.isEmpty || isLoading)
            .buttonStyle(.plain)
            
            // 添加占位空间使高度与二维码登录一致
            Spacer()
                .frame(height: 80)
        }
        .frame(width: 350, height: 320) // 与二维码登录保持相同高度
    }
    
    @ViewBuilder
    private var qrCodeLoginForm: some View {
        VStack(spacing: 16) {
            // 二维码显示区域 - 固定高度避免布局变化
            VStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.white)
                        .frame(width: 200, height: 200)
                        .shadow(radius: 2)
                    
                    if isLoading {
                        ProgressView()
                            .scaleEffect(1.2)
                    } else if let qrImageData = qrCodeImage,
                              let imageData = Data(base64Encoded: qrImageData.replacingOccurrences(of: "data:image/png;base64,", with: "")),
                              let nsImage = NSImage(data: imageData) {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 180, height: 180)
                    } else if !qrCodeURL.isEmpty {
                        // 使用系统生成的二维码占位
                        Image(systemName: "qrcode")
                            .font(.system(size: 60))
                            .foregroundColor(.gray)
                    } else {
                        // 初始状态显示二维码占位
                        VStack(spacing: 8) {
                            Image(systemName: "qrcode")
                                .font(.system(size: 60))
                                .foregroundColor(.gray.opacity(0.5))
                            Text("正在生成二维码...")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                
                // 状态显示 - 固定高度
                VStack(spacing: 8) {
                    HStack {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                        
                        Text(qrStatus.description)
                            .font(.body)
                            .foregroundColor(.primary)
                    }
                    
                    if qrStatus == .waiting {
                        Text("请使用手机APP扫描二维码")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .frame(height: 40) // 固定状态区域高度
                
                // 操作按钮
                Button("刷新") {
                    refreshQRCode()
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
        }
        .frame(width: 350, height: 320) // 固定整个二维码区域高度
        .onAppear {
            if loginType == .qrcode && qrCodeURL.isEmpty {
                generateQRCode()
            }
        }
        .onDisappear {
            stopQRPolling()
        }
        .onChange(of: loginType) { newLoginType in
            if newLoginType == .qrcode && qrCodeURL.isEmpty {
                generateQRCode()
            } else if newLoginType != .qrcode {
                stopQRPolling()
            }
        }
    }
    
    private var statusColor: Color {
        switch qrStatus {
        case .expired:
            return .red
        case .waiting:
            return .orange
        case .scanned:
            return .blue
        case .confirmed:
            return .green
        }
    }
    
    // MARK: - 登录方法
    
    private func performMobileLogin() {
        Task {
            await MainActor.run {
                isLoading = true
                errorMessage = ""
            }
            
            do {
                let user = try await loginService.loginWithMobile(
                    mobile: mobile,
                    code: verificationCode
                )
                
                await handleLoginSuccess(user)
            } catch let error as LoginError {
                await MainActor.run {
                    handleLoginError(error)
                }
            } catch {
                await MainActor.run {
                    handleLoginError(LoginError.unknownError)
                }
            }
        }
    }
    
    private func sendVerificationCode() {
        Task {
            do {
                try await loginService.sendCaptcha(mobile: mobile)
                
                await MainActor.run {
                    startCountdown()
                }
            } catch let error as LoginError {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    showError = true
                }
            } catch {
                await MainActor.run {
                    errorMessage = "发送验证码失败"
                    showError = true
                }
            }
        }
    }
    
    // MARK: - 二维码登录方法
    
    private func generateQRCode() {
        Task {
            isLoading = true
            errorMessage = ""
            
            do {
                // 直接生成二维码（包含key和图片）
                let (key, qrimg) = try await loginService.generateQRCode()
                
                await MainActor.run {
                    qrKey = key
                    qrCodeURL = "qr://generated" // 使用占位URL表示已生成
                    qrCodeImage = qrimg
                    qrStatus = .waiting
                    isLoading = false
                    
                    // 开始轮询二维码状态
                    startQRPolling()
                }
            } catch let error as LoginError {
                await MainActor.run {
                    handleLoginError(error)
                }
            } catch {
                await MainActor.run {
                    handleLoginError(LoginError.unknownError)
                }
            }
        }
    }
    
    private func startQRPolling() {
        guard !qrKey.isEmpty else { return }
        
        isPollingQR = true
        qrTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { timer in
            Task {
                await checkQRStatus()
            }
        }
    }
    
    private func stopQRPolling() {
        isPollingQR = false
        qrTimer?.invalidate()
        qrTimer = nil
    }
    
    private func checkQRStatus() async {
        guard isPollingQR && !qrKey.isEmpty else { return }
        
        do {
            let response = try await loginService.checkQRStatus(key: qrKey)
            
            
            await MainActor.run {
                // 检查外层status是否成功
                guard response.status == 1, let data = response.data else {
                    return
                }
                
                // 根据data中的status判断二维码状态
                switch data.status {
                case 0:
                    qrStatus = .expired
                    stopQRPolling()
                case 1:
                    qrStatus = .waiting
                case 2:
                    qrStatus = .scanned
                case 4:
                    qrStatus = .confirmed
                    stopQRPolling()
                    
                    // 登录成功，处理登录数据
                    if data.token != nil {
                        if let user = data.toUser() {
                            Task {
                                await handleLoginSuccess(user)
                            }
                        }
                    }
                default:
                    break
                }
            }
        } catch {
            // 不要因为单次错误就停止轮询，继续等待下次检查
            // 只有在多次连续失败时才考虑停止
        }
    }
    
    private func refreshQRCode() {
        stopQRPolling()
        qrCodeURL = ""
        qrCodeImage = nil
        qrKey = ""
        qrStatus = .waiting
        generateQRCode()
    }
    
    private func cancelQRLogin() {
        stopQRPolling()
        qrCodeURL = ""
        qrCodeImage = nil
        qrKey = ""
        qrStatus = .waiting
    }
    
    // MARK: - 辅助方法
    
    private func handleLoginSuccess(_ user: User) async {
        do {
            try await loginService.completeLoginProcess(userInfo: user)
            
            await MainActor.run {
                isLoading = false
                dismiss()
            }
        } catch {
            await MainActor.run {
                // 即使完整流程失败，如果基础登录成功了也应该继续
                if userService.isLoggedIn {
                    isLoading = false
                    dismiss()
                } else {
                    handleLoginError(LoginError.unknownError)
                }
            }
        }
    }
    
    private func handleLoginError(_ error: LoginError) {
        errorMessage = error.localizedDescription
        showError = true
        isLoading = false
    }
    
    private func startCountdown() {
        canSendCode = false
        countdownSeconds = 60
        
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { timer in
            if countdownSeconds > 0 {
                countdownSeconds -= 1
            } else {
                canSendCode = true
                timer.invalidate()
            }
        }
    }
}

#Preview {
    LoginView()
        .environmentObject(UserService.shared)
}
