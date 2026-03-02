import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    // Window visibility is managed entirely by Dart (flutter_single_instance + window_manager).
    // Returning true lets the system proceed, but we do not call makeKeyAndOrderFront here
    // to avoid conflicting with the Dart-side focus handler.
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
