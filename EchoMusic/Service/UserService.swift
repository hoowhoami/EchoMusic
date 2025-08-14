//
//  UserService.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/5.
//

import Foundation
import SwiftUI

/// 用户信息服务（负责用户状态管理和API交互）
class UserService: ObservableObject {
    static let shared = UserService()
    private let networkService = NetworkService.shared
    
    // MARK: - 用户状态
    
    /// 当前用户信息
    @Published
    var currentUser: User? {
        didSet {
            if let user = currentUser {
                // 保存到本地存储
                if let encoded = try? JSONEncoder().encode(user) {
                    UserDefaults.standard.set(encoded, forKey: "userInfo")
                }
                // 同步到网络管理器
                NetworkService.shared.setUserAuth(token: user.token, userid: String(user.userid))
            } else {
                // 清除本地存储和网络认证
                UserDefaults.standard.removeObject(forKey: "userInfo")
                NetworkService.shared.clearUserAuth()
            }
        }
    }
    
    /// 用户VIP信息
    @Published
    var vipInfo: UserVipResponse.UserVipData? {
        didSet {
            // 保存VIP信息到本地存储
            if let vipInfo = vipInfo {
                if let encoded = try? JSONEncoder().encode(vipInfo) {
                    UserDefaults.standard.set(encoded, forKey: "vipInfo")
                }
            } else {
                UserDefaults.standard.removeObject(forKey: "vipInfo")
            }
        }
    }
    
    /// 用户详细信息
    @Published
    var userDetail: UserDetailResponse.UserDetailData? {
        didSet {
            // 保存用户详细信息到本地存储
            if let userDetail = userDetail {
                if let encoded = try? JSONEncoder().encode(userDetail) {
                    UserDefaults.standard.set(encoded, forKey: "userDetail")
                }
            } else {
                UserDefaults.standard.removeObject(forKey: "userDetail")
            }
        }
    }
    
    /// 是否已登录
    var isLoggedIn: Bool {
        return currentUser != nil
    }
    
    /// 是否为VIP用户
    var isVipUser: Bool {
        return vipInfo?.busi_vip?.first?.is_vip == 1
    }
    
    private init() {
        // 从本地存储恢复用户信息
        loadUserFromStorage()
    }
    
    // MARK: - 用户状态管理
    
    /// 从本地存储加载用户信息
    private func loadUserFromStorage() {
        if let userData = UserDefaults.standard.data(forKey: "userInfo"),
           let user = try? JSONDecoder().decode(User.self, from: userData) {
            self.currentUser = user
            NetworkService.shared.setUserAuth(token: user.token, userid: String(user.userid))
        }
        
        // 加载VIP信息
        if let vipData = UserDefaults.standard.data(forKey: "vipInfo"),
           let vip = try? JSONDecoder().decode(UserVipResponse.UserVipData.self, from: vipData) {
            self.vipInfo = vip
        }
        
        // 加载用户详细信息
        if let userDetailData = UserDefaults.standard.data(forKey: "userDetail"),
           let detail = try? JSONDecoder().decode(UserDetailResponse.UserDetailData.self, from: userDetailData) {
            self.userDetail = detail
        }
    }
    
    /// 设置基础用户信息
    func setUserInfo(userid: String, token: String, username: String? = nil, avatar: String? = nil) {
        // 处理头像URL，确保使用HTTPS并处理尺寸占位符
        let secureAvatar = ImageURLHelper.processImageURL(avatar, size: .medium)?.absoluteString
        
        let newUser = User(
            userid: Int(userid) ?? 0,
            username: username ?? "",
            nickname: username ?? "",
            token: token,
            avatar: secureAvatar
        )
        
        self.currentUser = newUser
    }
    
    /// 更新完整用户信息
    func updateUserInfo(dfid: String? = nil, userDetail: UserDetailResponse.UserDetailData? = nil, vipInfo: UserVipResponse.UserVipData? = nil) {
        guard let user = currentUser else { return }
        
        // 处理头像URL，确保使用HTTPS并处理尺寸占位符
        let avatarURL = userDetail?.pic ?? user.avatar
        let secureAvatar = ImageURLHelper.processImageURL(avatarURL, size: .medium)?.absoluteString
        
        // 创建更新后的用户信息
        let updatedUser = User(
            userid: user.userid,
            username: userDetail?.nickname ?? user.username,
            nickname: userDetail?.nickname ?? user.nickname,
            token: user.token,
            avatar: secureAvatar
        )
        
        self.currentUser = updatedUser
        
        // 更新VIP信息
        if let vipInfo = vipInfo {
            self.vipInfo = vipInfo
        }
        
        // 更新用户详细信息
        if let userDetail = userDetail {
            self.userDetail = userDetail
        }
    }
    
    /// 清除用户登录状态
    func clearUserSession() {
        self.currentUser = nil
        self.vipInfo = nil
        self.userDetail = nil
    }
    
    // MARK: - 基础用户信息API
    
    /// 刷新登录token
    func refreshToken() async throws -> User {
        guard currentUser != nil else {
            throw UserServiceError.userNotLoggedIn
        }
        
        do {
            let response: TokenRefreshResponse = try await networkService.get(
                endpoint: "/login/token",
                responseType: TokenRefreshResponse.self
            )
            
            if response.status == 1, let refreshedUser = response.data {
                // 处理头像URL，确保使用HTTPS并处理尺寸占位符
                let secureAvatar = ImageURLHelper.processImageURL(refreshedUser.avatar, size: .medium)?.absoluteString
                
                // 创建更新后的用户信息（保持HTTPS头像）
                let updatedUser = User(
                    userid: refreshedUser.userid,
                    username: refreshedUser.username,
                    nickname: refreshedUser.nickname,
                    token: refreshedUser.token,
                    avatar: secureAvatar
                )
                
                self.currentUser = updatedUser
                
                return refreshedUser
            } else {
                throw UserServiceError.serverError(response.error_code, "刷新token失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 获取设备ID (dfid)
    func getDfid() async throws -> String {
        do {
            let response: DeviceRegisterResponse = try await networkService.get(
                endpoint: "/register/dev",
                responseType: DeviceRegisterResponse.self
            )
            
            if response.status == 1, let data = response.data, let dfid = data.dfid {
                return dfid
            } else {
                throw UserServiceError.serverError(response.error_code ?? -1, "获取设备ID失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 获取用户详细信息
    func getUserDetail() async throws -> UserDetailResponse.UserDetailData {
        do {
            let response: UserDetailResponse = try await networkService.get(
                endpoint: "/user/detail",
                responseType: UserDetailResponse.self
            )
            
            if response.status == 1, let data = response.data {
                return data
            } else {
                throw UserServiceError.serverError(response.error_code, "获取用户详细信息失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    /// 获取用户VIP信息
    func getUserVipDetail() async throws -> UserVipResponse.UserVipData {
        do {
            let response: UserVipResponse = try await networkService.get(
                endpoint: "/user/vip/detail",
                responseType: UserVipResponse.self
            )
            
            if response.status == 1, let data = response.data {
                return data
            } else {
                throw UserServiceError.serverError(response.error_code, "获取VIP信息失败")
            }
        } catch let error as NetworkError {
            throw UserServiceError.networkError(error.localizedDescription)
        } catch let error as UserServiceError {
            throw error
        } catch {
            throw UserServiceError.unknownError
        }
    }
    
    
    
    
    
    // MARK: - 组合方法
    
    /// app启动时自动刷新token和用户信息
    func autoRefreshOnAppLaunch() async {
        guard isLoggedIn else {
            return
        }
        
        do {
            let _ = try await refreshToken()
            
            // 2. 并行获取详细信息（userdetail, vipdetail, dfid）
            async let dfidTask = getDfid()
            async let userDetailTask = getUserDetail()
            async let vipInfoTask = getUserVipDetail()
            
            let (dfid, userDetail, vipInfo) = try await (dfidTask, userDetailTask, vipInfoTask)
            
            // 3. 更新用户详细信息
            updateUserInfo(
                dfid: dfid,
                userDetail: userDetail,
                vipInfo: vipInfo
            )
        } catch {
            if case UserServiceError.serverError(let code, _) = error, code == 401 {
                clearUserSession()
            }
        }
    }
    
    /// 获取完整用户信息（登录成功后调用）
    func fetchCompleteUserInfo() async throws -> (dfid: String, userDetail: UserDetailResponse.UserDetailData, vipInfo: UserVipResponse.UserVipData) {
        // 并行获取所有信息
        async let dfidTask = getDfid()
        async let userDetailTask = getUserDetail()
        async let vipInfoTask = getUserVipDetail()
        
        let (dfid, userDetail, vipInfo) = try await (dfidTask, userDetailTask, vipInfoTask)
        
        return (dfid, userDetail, vipInfo)
    }
    
    /// 刷新用户信息（用户点击头像进入个人中心时调用）
    func refreshUserInfo() async throws {
        guard isLoggedIn else {
            throw UserServiceError.userNotLoggedIn
        }
        
        do {
            let (dfid, userDetail, vipInfo) = try await fetchCompleteUserInfo()
            
            // 更新用户信息
            updateUserInfo(
                dfid: dfid,
                userDetail: userDetail,
                vipInfo: vipInfo
            )
            
        } catch {
            throw error
        }
    }
    
    /// 完整登录流程（包括获取额外信息）
    func completeLoginProcess(userInfo: User) async throws {
        let userid = String(userInfo.userid)
        let token = userInfo.token
        let username = userInfo.username.isEmpty ? userInfo.nickname : userInfo.username
        let avatar = userInfo.avatar
        
        // 设置基础用户信息（已经包含HTTPS转换）
        setUserInfo(
            userid: userid,
            token: token,
            username: username,
            avatar: avatar
        )
        
        // 获取额外信息
        do {
            let (dfid, userDetail, vipInfo) = try await fetchCompleteUserInfo()
            
            // 更新完整用户信息
            updateUserInfo(
                dfid: dfid,
                userDetail: userDetail,
                vipInfo: vipInfo
            )
            
        } catch {
            // 即使获取额外信息失败，基础登录仍然有效
        }
    }
}

// MARK: - 用户服务错误类型
enum UserServiceError: Error, LocalizedError {
    case networkError(String)
    case serverError(Int, String?)
    case userNotLoggedIn
    case unknownError
    
    var errorDescription: String? {
        switch self {
        case .networkError(let message):
            return "网络错误: \(message)"
        case .serverError(_, let message):
            return message ?? "服务器错误"
        case .userNotLoggedIn:
            return "用户未登录"
        case .unknownError:
            return "未知错误"
        }
    }
}
