import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    // Dock icon click with no visible windows (e.g. window was hidden to tray).
    // Only restore the main Flutter window to avoid activating hidden windows from plugins (like tray_manager),
    // which can cause duplicate tray icons or unexpected UI behavior.
    if !flag {
      for window in sender.windows {
        if window.contentViewController is FlutterViewController {
          window.makeKeyAndOrderFront(self)
          NSApp.activate(ignoringOtherApps: true)
          break
        }
      }
    }
    return true
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  override func applicationWillTerminate(_ notification: Notification) {
    let task = Process()
    task.launchPath = "/bin/sh"
    task.arguments = ["-c", "lsof -ti :10086 | xargs kill -9"]
    task.launch()
    task.waitUntilExit()
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
