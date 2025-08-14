//
//  SettingsView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/4.
//

import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appSettings: AppSetting
    
    @State private var selectedTab: SettingsTab = .appearance
    @State private var tempApiURL: String = ""
    
    var body: some View {
        NavigationSplitView {
            // 左侧设置分类
            List(SettingsTab.allCases, id: \.self, selection: $selectedTab) { tab in
                Label(tab.title, systemImage: tab.icon)
                    .tag(tab)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 200)
            .listStyle(.sidebar)
        } detail: {
            // 右侧设置内容
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch selectedTab {
                    case .appearance:
                        AppearanceSettingsView()
                    case .api:
                        APISettingsView(tempApiURL: $tempApiURL)
                    case .about:
                        AboutSettingsView()
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(selectedTab.title)
        }
        .frame(width: 600, height: 500)
        .onAppear {
            tempApiURL = appSettings.apiBaseURL
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") {
                    dismiss()
                }
            }
        }
    }
}

// 设置分类枚举
enum SettingsTab: String, CaseIterable {
    case appearance = "appearance"
    case api = "api"
    case about = "about"
    
    var title: String {
        switch self {
        case .appearance: return "外观"
        case .api: return "接口"
        case .about: return "关于"
        }
    }
    
    var icon: String {
        switch self {
        case .appearance: return "paintbrush"
        case .api: return "network"
        case .about: return "info.circle"
        }
    }
}

// 外观设置视图
struct AppearanceSettingsView: View {
    @EnvironmentObject private var appSettings: AppSetting
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("外观设置")
                .font(.title2)
                .fontWeight(.semibold)
            
            VStack(alignment: .leading, spacing: 12) {
                Text("主题模式")
                    .font(.headline)
                
                HStack(spacing: 16) {
                    // 浅色主题预览
                    Button(action: {
                        appSettings.appearanceMode = .light
                    }) {
                        VStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(Color.white)
                                .frame(width: 80, height: 60)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12)
                                        .stroke(
                                            appSettings.appearanceMode == .light 
                                            ? Color.accentColor 
                                            : Color.gray.opacity(0.3), 
                                            lineWidth: appSettings.appearanceMode == .light ? 2 : 1
                                        )
                                )
                                .overlay(
                                    VStack(spacing: 2) {
                                        Circle()
                                            .fill(Color.black.opacity(0.8))
                                            .frame(width: 16, height: 16)
                                        Rectangle()
                                            .fill(Color.black.opacity(0.6))
                                            .frame(width: 40, height: 3)
                                            .cornerRadius(1.5)
                                        Rectangle()
                                            .fill(Color.black.opacity(0.4))
                                            .frame(width: 30, height: 2)
                                            .cornerRadius(1)
                                    }
                                )
                            
                            Text("浅色")
                                .font(.caption)
                                .foregroundColor(appSettings.appearanceMode == .light ? .accentColor : .primary)
                                .fontWeight(appSettings.appearanceMode == .light ? .medium : .regular)
                        }
                    }
                    .buttonStyle(.plain)
                    .scaleEffect(appSettings.appearanceMode == .light ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.15), value: appSettings.appearanceMode)
                    
                    // 深色主题预览
                    Button(action: {
                        appSettings.appearanceMode = .dark
                    }) {
                        VStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(Color.black)
                                .frame(width: 80, height: 60)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12)
                                        .stroke(
                                            appSettings.appearanceMode == .dark 
                                            ? Color.accentColor 
                                            : Color.gray.opacity(0.5), 
                                            lineWidth: appSettings.appearanceMode == .dark ? 2 : 1
                                        )
                                )
                                .overlay(
                                    VStack(spacing: 2) {
                                        Circle()
                                            .fill(Color.white.opacity(0.9))
                                            .frame(width: 16, height: 16)
                                        Rectangle()
                                            .fill(Color.white.opacity(0.7))
                                            .frame(width: 40, height: 3)
                                            .cornerRadius(1.5)
                                        Rectangle()
                                            .fill(Color.white.opacity(0.5))
                                            .frame(width: 30, height: 2)
                                            .cornerRadius(1)
                                    }
                                )
                            
                            Text("深色")
                                .font(.caption)
                                .foregroundColor(appSettings.appearanceMode == .dark ? .accentColor : .primary)
                                .fontWeight(appSettings.appearanceMode == .dark ? .medium : .regular)
                        }
                    }
                    .buttonStyle(.plain)
                    .scaleEffect(appSettings.appearanceMode == .dark ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.15), value: appSettings.appearanceMode)
                    
                    // 跟随系统主题预览
                    Button(action: {
                        appSettings.appearanceMode = .system
                    }) {
                        VStack(spacing: 8) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(
                                        LinearGradient(
                                            colors: [Color.white, Color.black],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                                    .frame(width: 80, height: 60)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12)
                                            .stroke(
                                                appSettings.appearanceMode == .system 
                                                ? Color.accentColor 
                                                : Color.gray.opacity(0.4), 
                                                lineWidth: appSettings.appearanceMode == .system ? 2 : 1
                                            )
                                    )
                                
                                VStack(spacing: 2) {
                                    Circle()
                                        .fill(Color.primary.opacity(0.8))
                                        .frame(width: 16, height: 16)
                                    Rectangle()
                                        .fill(Color.primary.opacity(0.6))
                                        .frame(width: 40, height: 3)
                                        .cornerRadius(1.5)
                                    Rectangle()
                                        .fill(Color.primary.opacity(0.4))
                                        .frame(width: 30, height: 2)
                                        .cornerRadius(1)
                                }
                                .shadow(color: .white, radius: 0.5)
                                .shadow(color: .black, radius: 0.5)
                            }
                            
                            Text("跟随系统")
                                .font(.caption)
                                .foregroundColor(appSettings.appearanceMode == .system ? .accentColor : .primary)
                                .fontWeight(appSettings.appearanceMode == .system ? .medium : .regular)
                        }
                    }
                    .buttonStyle(.plain)
                    .scaleEffect(appSettings.appearanceMode == .system ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.15), value: appSettings.appearanceMode)
                }
                .padding(.top, 8)
                
                Text("当前主题: \(appSettings.appearanceMode.displayName)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)
            }
            
            Spacer()
        }
    }
}

// API设置视图
struct APISettingsView: View {
    @EnvironmentObject private var appSettings: AppSetting
    @Binding var tempApiURL: String
    @State private var showResetAlert = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("接口设置")
                .font(.title2)
                .fontWeight(.semibold)
            
            VStack(alignment: .leading, spacing: 12) {
                Text("API 基础地址")
                    .font(.headline)
                
                TextField("请输入API地址", text: $tempApiURL)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 400)
                
                HStack {
                    Button("保存") {
                        appSettings.apiBaseURL = tempApiURL
                    }
                    .disabled(tempApiURL == appSettings.apiBaseURL)
                    
                    Button("重置为默认") {
                        showResetAlert = true
                    }
                    .foregroundColor(.red)
                }
                
                Text("当前使用: \(appSettings.apiBaseURL)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Divider()
            
            VStack(alignment: .leading, spacing: 8) {
                Text("连接状态")
                    .font(.headline)
                
                HStack {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 8, height: 8)
                    
                    Text("已连接")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            
            Spacer()
        }
        .alert("重置设置", isPresented: $showResetAlert) {
            Button("取消", role: .cancel) { }
            Button("重置", role: .destructive) {
                appSettings.resetSettings()
                tempApiURL = appSettings.apiBaseURL
            }
        } message: {
            Text("确定要重置所有设置为默认值吗？")
        }
    }
}

// 关于设置视图
struct AboutSettingsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("关于")
                .font(.title2)
                .fontWeight(.semibold)
            
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: "music.note")
                        .font(.system(size: 40))
                        .foregroundColor(.accentColor)
                    
                    VStack(alignment: .leading) {
                        Text("EchoMusic")
                            .font(.title)
                            .fontWeight(.bold)
                        
                        Text("版本 1.0.0")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                
                Text("一个现代化的音乐播放器应用")
                    .font(.body)
                    .foregroundColor(.secondary)
            }
            
            Divider()
            
            VStack(alignment: .leading, spacing: 8) {
                Text("技术信息")
                    .font(.headline)
                
                VStack(alignment: .leading, spacing: 4) {
                    InfoRow(label: "框架", value: "SwiftUI")
                    InfoRow(label: "平台", value: "macOS 13.0+")
                    InfoRow(label: "架构", value: "Apple Silicon & Intel")
                }
            }
            
            Spacer()
        }
    }
}

// 信息行组件
struct InfoRow: View {
    let label: String
    let value: String
    
    var body: some View {
        HStack {
            Text(label)
                .foregroundColor(.secondary)
                .frame(width: 80, alignment: .leading)
            
            Text(value)
                .foregroundColor(.primary)
            
            Spacer()
        }
        .font(.caption)
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppSetting.shared)
}
