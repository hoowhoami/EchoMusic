//
//  LoginModel.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/5.
//

import Foundation

// MARK: - 登录方式枚举
enum LoginType {
    case mobile     // 手机验证码登录
    case qrcode     // 扫码登录
}

// MARK: - 登录请求模型
struct MobileLoginRequest: Codable {
    let mobile: String?
    let code: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.mobile = c[safe: .mobile]
        self.code = c[safe: .code]
    }
    
    init(mobile: String, code: String) {
        self.mobile = mobile
        self.code = code
    }
}


struct CaptchaSendRequest: Codable {
    let mobile: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.mobile = c[safe: .mobile]
    }
    
    init(mobile: String) {
        self.mobile = mobile
    }
}

// MARK: - 二维码登录请求模型
struct QRKeyRequest: Codable {
    let timestamp: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.timestamp = c[safe: .timestamp]
    }
    
    init(timestamp: String) {
        self.timestamp = timestamp
    }
}

struct QRCreateRequest: Codable {
    let key: String?
    let qrimg: String?
    let timestamp: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.key = c[safe: .key]
        self.qrimg = c[safe: .qrimg]
        self.timestamp = c[safe: .timestamp]
    }
    
    init(key: String, qrimg: String? = nil, timestamp: String) {
        self.key = key
        self.qrimg = qrimg
        self.timestamp = timestamp
    }
}

struct QRCheckRequest: Codable {
    let key: String?
    let timestamp: String?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.key = c[safe: .key]
        self.timestamp = c[safe: .timestamp]
    }
    
    init(key: String, timestamp: String) {
        self.key = key
        self.timestamp = timestamp
    }
}

// MARK: - 登录响应模型
struct LoginResponse: Codable {
    let status: Int?
    let error_code: Int?
    let data: User?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.error_code = c[safe: .error_code]
        self.data = c[safe: .data]
    }
}

// MARK: - 验证码发送响应模型
struct CaptchaResponse: Codable {
    let status: Int?
    let error_code: Int?
    let data: CaptchaData?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.error_code = c[safe: .error_code]
        self.data = c[safe: .data]
    }
    
    struct CaptchaData: Codable {
        let count: Int?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 优雅简洁的解码方式
            self.count = c[safe: .count]
        }
    }
}

// MARK: - 二维码登录响应模型
struct QRKeyResponse: Codable {
    let status: Int?
    let error_code: Int?
    let data: QRKeyData?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.error_code = c[safe: .error_code]
        self.data = c[safe: .data]
    }
    
    struct QRKeyData: Codable {
        let qrcode: String?
        let qrcode_img: String?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 优雅简洁的解码方式
            self.qrcode = c[safe: .qrcode]
            self.qrcode_img = c[safe: .qrcode_img]
        }
    }
}

struct QRCreateResponse: Codable {
    let code: Int?
    let data: QRCreateData?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.code = c[safe: .code]
        self.data = c[safe: .data]
    }
    
    struct QRCreateData: Codable {
        let url: String?
        let base64: String?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 优雅简洁的解码方式
            self.url = c[safe: .url]
            self.base64 = c[safe: .base64]
        }
    }
}

struct QRCheckResponse: Codable {
    let status: Int?
    let error_code: Int?
    let data: QRCheckData?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.error_code = c[safe: .error_code]
        self.data = c[safe: .data]
    }
    
    struct QRCheckData: Codable {
        let nickname: String?
        let pic: String?
        let token: String?
        let userid: Int?
        let status: Int?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 优雅简洁的解码方式
            self.nickname = c[safe: .nickname]
            self.pic = c[safe: .pic]
            self.token = c[safe: .token]
            self.userid = c[safe: .userid]
            self.status = c[safe: .status]
        }
        
        // 转换为User对象的便捷方法
        func toUser() -> User? {
            guard let token = token, let userid = userid else { return nil }
            return User(userid: userid, username: nickname ?? "", nickname: nickname ?? "", token: token, avatar: pic)
        }
    }
}

// MARK: - 二维码状态枚举
enum QRCodeStatus: Int {
    case expired = 0     // 二维码过期
    case waiting = 1     // 等待扫码
    case scanned = 2     // 已扫码，待确认
    case confirmed = 4   // 授权登录成功
    
    var description: String {
        switch self {
        case .expired:
            return "二维码已过期"
        case .waiting:
            return "等待扫码"
        case .scanned:
            return "已扫码，请在手机上确认"
        case .confirmed:
            return "登录成功"
        }
    }
}


// MARK: - 登录错误类型
enum LoginError: Error, LocalizedError {
    case invalidMobile
    case invalidCode
    case networkError(String)
    case serverError(Int, String?)
    case unknownError
    
    var errorDescription: String? {
        switch self {
        case .invalidMobile:
            return "请输入正确的手机号码"
        case .invalidCode:
            return "请输入正确的验证码"
        case .networkError(let message):
            return "网络错误: \(message)"
        case .serverError(_, let message):
            return message ?? "服务器错误"
        case .unknownError:
            return "未知错误"
        }
    }
}

// MARK: - 设备注册响应模型
struct DeviceRegisterResponse: Codable {
    let status: Int?
    let error_code: Int?
    let data: DeviceRegisterData?
    
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        
        // 🎯 优雅简洁的解码方式
        self.status = c[safe: .status]
        self.error_code = c[safe: .error_code]
        self.data = c[safe: .data]
    }
    
    struct DeviceRegisterData: Codable {
        let dfid: String?
        
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            
            // 🎯 优雅简洁的解码方式
            self.dfid = c[safe: .dfid]
        }
    }
}

