import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private var terminationTimer: Timer?

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

  // Intercept Dock right-click → Quit, Cmd+Q, etc.
  // Ask Flutter to stop the mpv player first; terminating while mpv is playing
  // causes EXC_BAD_ACCESS on the native mpv thread.
  override func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let messenger = flutterBinaryMessenger else {
      return .terminateNow
    }

    let channel = FlutterMethodChannel(
      name: "com.hoowhoami.echomusic/app_lifecycle",
      binaryMessenger: messenger
    )

    // Safety fallback: if Flutter doesn't respond within 3 s, terminate anyway.
    terminationTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { _ in
      NSApp.reply(toApplicationShouldTerminate: true)
    }

    channel.invokeMethod("prepareToTerminate", arguments: nil) { [weak self] _ in
      self?.terminationTimer?.invalidate()
      self?.terminationTimer = nil
      NSApp.reply(toApplicationShouldTerminate: true)
    }

    return .terminateLater
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

  private var flutterBinaryMessenger: FlutterBinaryMessenger? {
    for window in NSApp.windows {
      if let vc = window.contentViewController as? FlutterViewController {
        return vc.engine.binaryMessenger
      }
    }
    return nil
  }
}
