import SwiftUI

/// 外观模式
enum AppearanceMode: String, CaseIterable {
    case light = "light"
    case dark = "dark"
    case system = "system"
    
    var displayName: String {
        switch self {
        case .light: return "浅色"
        case .dark: return "深色"
        case .system: return "跟随系统"
        }
    }
    
    var colorScheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }
}

/// 应用设置管理器（仅负责状态管理，业务逻辑由AppSettingService处理）
class AppSetting: ObservableObject {
    static let shared = AppSetting()
    private let service = AppSettingService.shared
    
    /// 外观模式
    @Published var appearanceMode: AppearanceMode {
        didSet {
            service.saveAppearanceMode(appearanceMode)
        }
    }
    
    /// API 基础URL
    @Published var apiBaseURL: String {
        didSet {
            service.saveAPIBaseURL(apiBaseURL)
        }
    }
    
    private init() {
        // 通过服务加载设置
        self.appearanceMode = service.loadAppearanceMode()
        self.apiBaseURL = service.loadAPIBaseURL()
    }
    
    /// 重置设置
    func resetSettings() {
        service.resetAllSettings()
        self.appearanceMode = .system
        self.apiBaseURL = "https://kgmusic-api.vercel.app"
    }
    
    /// 验证API URL
    func isValidAPIURL() -> Bool {
        return service.isValidAPIURL(apiBaseURL)
    }
}