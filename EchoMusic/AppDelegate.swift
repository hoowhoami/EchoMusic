//
//  AppDelegate.swift
//  EchoMusic
//
//  Created on 2025/8/4.
//

import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: NSWindow?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 获取第一个窗口作为主窗口
        if let window = NSApplication.shared.windows.first {
            mainWindow = window
            // 设置窗口代理以处理关闭事件
            window.delegate = self
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        // 应用即将终止时
    }
    
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // 当用户点击Dock图标时，如果没有可见窗口，显示主窗口
        if !flag, let window = mainWindow {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        return true
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 防止最后一个窗口关闭时退出应用
        return false
    }
    
    private func configureWindow(_ window: NSWindow) {
        // 配置窗口样式
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor.windowBackgroundColor
        window.toolbarStyle = .unified
        
        // 设置窗口标题
        window.title = ""
    }
}

// MARK: - NSWindowDelegate
extension AppDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // 只有主窗口才执行隐藏操作
        if sender == mainWindow {
            sender.orderOut(nil)
            return false
        }
        // 其他窗口允许正常关闭
        return true
    }
}
