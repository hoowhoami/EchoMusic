//
//  AppSettingService.swift
//  EchoMusic
//
//  Created on 2025/8/5.
//
import SwiftUI

/// 应用设置服务，处理所有设置相关的业务逻辑
class AppSettingService {
    static let shared = AppSettingService()
    
    private init() {}
    
    /// 保存外观模式
    func saveAppearanceMode(_ mode: AppearanceMode) {
        UserDefaults.standard.set(mode.rawValue, forKey: "appearanceMode")
    }
    
    /// 加载外观模式
    func loadAppearanceMode() -> AppearanceMode {
        let savedAppearance = UserDefaults.standard.string(forKey: "appearanceMode") ?? AppearanceMode.system.rawValue
        return AppearanceMode(rawValue: savedAppearance) ?? .system
    }
    
    /// 保存API基础URL
    func saveAPIBaseURL(_ url: String) {
        UserDefaults.standard.set(url, forKey: "apiBaseURL")
    }
    
    /// 加载API基础URL
    func loadAPIBaseURL() -> String {
        return UserDefaults.standard.string(forKey: "apiBaseURL") ?? "https://kgmusic-api.vercel.app"
    }
    
    /// 重置所有设置
    func resetAllSettings() {
        UserDefaults.standard.removeObject(forKey: "appearanceMode")
        UserDefaults.standard.removeObject(forKey: "apiBaseURL")
    }
    
    /// 验证API URL格式
    func isValidAPIURL(_ url: String) -> Bool {
        guard let url = URL(string: url) else { return false }
        return url.scheme == "http" || url.scheme == "https"
    }
}