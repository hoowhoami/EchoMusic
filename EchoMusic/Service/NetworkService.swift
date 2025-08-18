//
//  NetworkService.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/4.
//

import Foundation
import Combine
import SwiftUI


/// 网络错误类型
enum NetworkError: Error, LocalizedError {
    case invalidURL
    case noData
    case decodingError
    case serverError(Int)
    case networkError(Error)
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "无效的URL"
        case .noData:
            return "没有数据"
        case .decodingError:
            return "数据解析错误"
        case .serverError(let code):
            return "服务器错误: \(code)"
        case .networkError(let error):
            return "网络错误: \(error.localizedDescription)"
        }
    }
}

/// 用户认证信息
struct UserAuth {
    let token: String
    let userid: String
}

/// 网络服务
class NetworkService: ObservableObject {
    static let shared = NetworkService()
    
    /// 基础URL
    private var baseURL: String {
        return AppSetting.shared.apiBaseURL
    }
    
    /// 用户认证信息
    @Published var userAuth: UserAuth?
    
    /// URLSession
    var session: URLSession!
    
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30.0
        config.timeoutIntervalForResource = 60.0
        
        // 使用默认配置，依赖Info.plist的ATS设置
        self.session = URLSession(configuration: config)
    }
    
    /// 构建完整URL
    private func buildURL(endpoint: String, params: [String: String] = [:]) -> URL? {
        guard var components = URLComponents(string: baseURL + endpoint) else {
            return nil
        }
        
        var queryItems: [URLQueryItem] = []
        
        // 添加时间戳
        let timestamp = String(Int(Date().timeIntervalSince1970 * 1000))
        queryItems.append(URLQueryItem(name: "timestamp", value: timestamp))
        
        // 添加认证参数
        if let auth = userAuth {
            let cookieValue = "token=\(auth.token);userid=\(auth.userid)"
            queryItems.append(URLQueryItem(name: "cookie", value: cookieValue))
        }
        
        // 添加其他参数
        for (key, value) in params {
            queryItems.append(URLQueryItem(name: key, value: value))
        }
        
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        
        return components.url
    }
    
    /// 创建请求
    private func createRequest(url: URL, method: HTTPMethod, body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let body = body {
            request.httpBody = body
        }
        
        return request
    }
    
    /// 执行网络请求
    private func performRequest<T: Codable>(
        request: URLRequest,
        responseType: T.Type
    ) async throws -> T {
        let startTime = CFAbsoluteTimeGetCurrent()
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw NetworkError.networkError(URLError(.badServerResponse))
            }
            
            let duration = CFAbsoluteTimeGetCurrent() - startTime
            let statusIcon = 200...299 ~= httpResponse.statusCode ? "✅" : "❌"
            
            guard 200...299 ~= httpResponse.statusCode else {
                // 打印失败请求的完整信息
                let responseBody = String(data: data, encoding: .utf8) ?? "N/A"
                print("""
                🌐 ═══════════════════════════════════════════════════════════════
                \(statusIcon) \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "unknown")
                📊 Status: \(httpResponse.statusCode) | ⏱️ Duration: \(String(format: "%.2f", duration * 1000))ms
                📄 Response: \(responseBody)
                ═══════════════════════════════════════════════════════════════
                """)
                throw NetworkError.serverError(httpResponse.statusCode)
            }
            
            guard !data.isEmpty else {
                print("""
                🌐 ═══════════════════════════════════════════════════════════════
                \(statusIcon) \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "unknown")
                📊 Status: \(httpResponse.statusCode) | ⏱️ Duration: \(String(format: "%.2f", duration * 1000))ms
                📄 Response: Empty Data
                ═══════════════════════════════════════════════════════════════
                """)
                throw NetworkError.noData
            }
            
            do {
                let decodedResponse = try JSONDecoder().decode(T.self, from: data)
                
                // 打印成功请求的简洁信息
                let responsePreview = String(data: data, encoding: .utf8)?.prefix(200) ?? "N/A"
                print("""
                🌐 ═══════════════════════════════════════════════════════════════
                \(statusIcon) \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "unknown")
                📊 Status: \(httpResponse.statusCode) | ⏱️ Duration: \(String(format: "%.2f", duration * 1000))ms
                📄 Response: \(responsePreview)\(data.count > 200 ? "..." : "")
                ═══════════════════════════════════════════════════════════════
                """)
                
                return decodedResponse
            } catch {
                // 打印解码错误的详细信息
                let responseBody = String(data: data, encoding: .utf8) ?? "N/A"
                print("""
                🌐 ═══════════════════════════════════════════════════════════════
                ❌ \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "unknown")
                📊 Status: \(httpResponse.statusCode) | ⏱️ Duration: \(String(format: "%.2f", duration * 1000))ms
                🚫 Decoding Error: \(error.localizedDescription)
                📄 Response: \(responseBody)
                ═══════════════════════════════════════════════════════════════
                """)
                throw NetworkError.decodingError
            }
        } catch let error as NetworkError {
            throw error
        } catch {
            // 打印网络错误信息
            let duration = CFAbsoluteTimeGetCurrent() - startTime
            print("""
            🌐 ═══════════════════════════════════════════════════════════════
            ❌ \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "unknown")
            🚫 Network Error: \(error.localizedDescription)
            ⏱️ Duration: \(String(format: "%.2f", duration * 1000))ms
            ═══════════════════════════════════════════════════════════════
            """)
            throw NetworkError.networkError(error)
        }
    }
}

/// HTTP方法枚举
enum HTTPMethod: String {
    case GET = "GET"
    case POST = "POST"
    case PUT = "PUT"
    case DELETE = "DELETE"
    case PATCH = "PATCH"
}

// MARK: - 网络请求方法扩展
extension NetworkService {
    /// GET 请求
    func get<T: Codable>(
        endpoint: String,
        params: [String: String] = [:],
        responseType: T.Type
    ) async throws -> T {
        guard let url = buildURL(endpoint: endpoint, params: params) else {
            throw NetworkError.invalidURL
        }
        
        let request = createRequest(url: url, method: .GET)
        return try await performRequest(request: request, responseType: responseType)
    }
    
    /// POST 请求
    func post<T: Codable, U: Codable>(
        endpoint: String,
        params: [String: String] = [:],
        body: U? = nil,
        responseType: T.Type
    ) async throws -> T {
        guard let url = buildURL(endpoint: endpoint, params: params) else {
            throw NetworkError.invalidURL
        }
        
        var requestBody: Data?
        if let body = body {
            requestBody = try JSONEncoder().encode(body)
        }
        
        let request = createRequest(url: url, method: .POST, body: requestBody)
        return try await performRequest(request: request, responseType: responseType)
    }
    
    /// PUT 请求
    func put<T: Codable, U: Codable>(
        endpoint: String,
        params: [String: String] = [:],
        body: U? = nil,
        responseType: T.Type
    ) async throws -> T {
        guard let url = buildURL(endpoint: endpoint, params: params) else {
            throw NetworkError.invalidURL
        }
        
        var requestBody: Data?
        if let body = body {
            requestBody = try JSONEncoder().encode(body)
        }
        
        let request = createRequest(url: url, method: .PUT, body: requestBody)
        return try await performRequest(request: request, responseType: responseType)
    }
    
    /// DELETE 请求
    func delete<T: Codable>(
        endpoint: String,
        params: [String: String] = [:],
        responseType: T.Type
    ) async throws -> T {
        guard let url = buildURL(endpoint: endpoint, params: params) else {
            throw NetworkError.invalidURL
        }
        
        let request = createRequest(url: url, method: .DELETE)
        return try await performRequest(request: request, responseType: responseType)
    }
    
    /// 设置用户认证信息
    func setUserAuth(token: String, userid: String) {
        self.userAuth = UserAuth(token: token, userid: userid)
    }
    
    /// 清除用户认证信息
    func clearUserAuth() {
        self.userAuth = nil
    }
}

