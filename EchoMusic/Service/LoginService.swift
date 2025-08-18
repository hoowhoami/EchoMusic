//
//  LoginService.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/5.
//

import Foundation

/// 登录服务
class LoginService {
    static let shared = LoginService()
    private let networkService = NetworkService.shared
    
    private init() {}
    
    /// 发送验证码
    func sendCaptcha(mobile: String) async throws {
        // 验证手机号格式
        guard isValidMobile(mobile) else {
            throw LoginError.invalidMobile
        }
        
        do {
            let response: CaptchaResponse = try await networkService.get(
                endpoint: "/captcha/sent",
                params: ["mobile": mobile],
                responseType: CaptchaResponse.self
            )
            
            if response.status == 1 {
                // Success
            } else {
                throw LoginError.serverError(response.error_code ?? -1, "发送验证码失败")
            }
        } catch let error as NetworkError {
            throw LoginError.networkError(error.localizedDescription)
        } catch let error as LoginError {
            throw error
        } catch {
            throw LoginError.unknownError
        }
    }
    
    /// 手机号验证码登录
    func loginWithMobile(mobile: String, code: String) async throws -> User {
        // 验证输入
        guard isValidMobile(mobile) else {
            throw LoginError.invalidMobile
        }
        
        guard !code.isEmpty else {
            throw LoginError.invalidCode
        }
        
        do {
            let response: LoginResponse = try await networkService.get(
                endpoint: "/login/cellphone",
                params: [
                    "mobile": mobile,
                    "code": code
                ],
                responseType: LoginResponse.self
            )
            
            if response.status == 1, response.error_code == 0, let data = response.data {
                return data
            } else {
                throw LoginError.serverError(response.error_code ?? -1, "登录失败")
            }
        } catch let error as NetworkError {
            throw LoginError.networkError(error.localizedDescription)
        } catch let error as LoginError {
            throw error
        } catch {
            throw LoginError.unknownError
        }
    }
    
    // MARK: - 二维码登录方法
    
    /// 生成二维码（合并key生成和二维码创建）
    func generateQRCode() async throws -> (key: String, qrimg: String?) {
        
        do {
            let response: QRKeyResponse = try await networkService.get(
                endpoint: "/login/qr/key",
                responseType: QRKeyResponse.self
            )
            
            if response.status == 1, let data = response.data, let qrcode = data.qrcode {
                return (qrcode, data.qrcode_img)
            } else {
                throw LoginError.serverError(response.error_code ?? -1, "生成二维码失败")
            }
        } catch let error as NetworkError {
            throw LoginError.networkError(error.localizedDescription)
        } catch let error as LoginError {
            throw error
        } catch {
            throw LoginError.unknownError
        }
    }
    
    /// 检查二维码状态
    func checkQRStatus(key: String) async throws -> QRCheckResponse {
        
        do {
            let response: QRCheckResponse = try await networkService.get(
                endpoint: "/login/qr/check",
                params: [
                    "key": key
                ],
                responseType: QRCheckResponse.self
            )
            
            return response
        } catch let error as NetworkError {
            throw LoginError.networkError(error.localizedDescription)
        } catch let error as LoginError {
            throw error
        } catch {
            throw LoginError.unknownError
        }
    }
    
    // MARK: - 私有方法
    
    /// 验证手机号格式
    private func isValidMobile(_ mobile: String) -> Bool {
        let mobileRegex = "^1[3-9]\\d{9}$"
        let mobilePredicate = NSPredicate(format: "SELF MATCHES %@", mobileRegex)
        return mobilePredicate.evaluate(with: mobile)
    }
    
    /// 完整登录流程（包括获取额外信息）
    func completeLoginProcess(userInfo: User) async throws {
        // 使用UserService处理登录流程
        try await UserService.shared.completeLoginProcess(userInfo: userInfo)
    }
}
