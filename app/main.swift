import AppKit
import AVFoundation
import ServiceManagement
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var item: NSStatusItem!
  private let server = ServerProcess(), hotkeys = HotkeyCenter()
  private var recentMenu = NSMenu()
  private lazy var bridge = Bridge(self)
  private lazy var panel = FloatingPanel(bridge: bridge)
  private var main: WebWindow?, prefsWindow: WebWindow?
  private var status: [String: Any]?, prefs: [String: Any] = [:], recent: [[String: Any]] = []
  private var detector = CallDetector(watch: [])
  private var keys: [String]?, activeKeys: [String] = [], keysPaused = false
  private var meetingID: String?, busy = false, prompting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = editMenu()
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.font = .monospacedDigitSystemFont(ofSize: 0, weight: .regular)
    item.button?.imagePosition = .imageLeading
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    panel.onClose = { [weak self] in self?.updatePanel { self?.prompting = false } }
    server.start()
    let timer = Timer(timeInterval: 1, target: self, selector: #selector(refreshStatus), userInfo: nil, repeats: true)
    RunLoop.main.add(timer, forMode: .common) // .common, so the clock also moves while the menu is open
    refreshStatus()
  }

  func applicationWillTerminate(_ notification: Notification) { server.stop() }

  // Back from System Settings, the preferences page shows the new permission state.
  func applicationDidBecomeActive(_ notification: Notification) { if let prefsWindow { answerNative(prefsWindow.web) } }

  private func applyPrefs(_ p: [String: Any]) {
    prefs = p
    detector.watch = p["detectApps"] as? [String] ?? []
    let next = [p["hotkeyOpen"], p["hotkeyAsk"]].map { $0 as? String ?? "" }
    if next != keys { keys = next; registerHotkeys() }
  }

  @objc private func refreshStatus() {
    API.get("/api/status") { [self] s in
      // A server from before the menu-bar app has no `writing`. The app does not drive it.
      if let s, s["writing"] == nil {
        if server.failed == nil {
          server.fail("An older aside server runs on port 4318. Stop it with ./aside.sh stop, then choose Restart server.")
          hotkeys.unregisterAll()
          keys = nil
          activeKeys = []
        }
        status = nil
        return updateIcon()
      }
      status = s
      guard let s else { server.start(); return updateIcon() } // a server that someone else started may have stopped
      API.get("/api/prefs") { [self] p in if let p, p["error"] == nil { applyPrefs(p) } }
      let id = (s["meeting"] as? [String: Any])?["id"] as? String
      updatePanel { meetingID = id; busy = id != nil || s["writing"] as? Bool == true }
      if prefs["detect"] as? Bool == true {
        detector.step(active: micBundleIDs(), recording: id != nil, now: ProcessInfo.processInfo.systemUptime).forEach(handle)
      } else {
        detector = CallDetector(watch: detector.watch) // turned on again, it starts clean instead of ending an old call
      }
      updateIcon()
    }
  }

  // The panel opens when a meeting starts. It closes when nothing is left in it: no meeting, no notes being written,
  // and no open prompt. A user who opened it by hand closes it again. Every change of these three goes through here.
  private func updatePanel(_ change: () -> Void) {
    let was = meetingID, needed = busy || prompting
    change()
    if meetingID != nil { prompting = false } // the meeting answered the prompt
    if let id = meetingID, id != was { panel.show() }
    // Async, because the panel's own web view can be the caller.
    else if needed && !busy && !prompting { DispatchQueue.main.async { if self.panel.isVisible { self.panel.close() } } }
  }

  // Without the speech model a meeting cannot start, so aside neither asks nor offers Start.
  private var modelReady: Bool { (status?["model"] as? [String: Any])?["downloaded"] as? Bool == true }

  private func handle(_ event: DetectEvent) {
    appLog("detected \(event)")
    switch event {
    case .callStarted(let id): if modelReady { updatePanel { prompting = true }; panel.prompt(bundleId: id, name: appName(id)) }
    case .callGone: updatePanel { prompting = false }
    case .callEnded: panel.ending(seconds: Int(CallDetector.stopDelay - CallDetector.endDelay))
    case .callResumed: panel.ending(seconds: -1)
    case .autoStop: API.post("/api/meeting/stop", [:]) { r in if let e = r?["error"] { appLog("automatic stop failed: \(e)") } }
    }
  }

  private func registerHotkeys() {
    hotkeys.unregisterAll()
    activeKeys = []
    if keysPaused { return }
    let all: [(String, String, String, () -> Void)] = [
      ("hotkeyOpen", "opt+cmd+a", "Open aside", { [weak self] in self?.openMain() }),
      ("hotkeyAsk", "opt+cmd+k", "Ask Claude", { [weak self] in self?.panel.focusAsk() }),
    ]
    for (i, (key, fallback, name, action)) in all.enumerated() {
      var text = prefs[key] as? String ?? fallback
      if parseHotkey(text) == nil { appLog("hot key \"\(text)\" for \(name) is not valid, so \(fallback) is used"); text = fallback }
      let ok = hotkeys.register(id: UInt32(i + 1), hotkey: parseHotkey(text)!, action: action)
      appLog(ok ? "hot key \(text) registered for \(name)" : "hot key \(text) for \(name) not registered: macOS refused it (another app may use it)")
      activeKeys.append(ok ? text : "")
    }
  }

  private func updateIcon() {
    let live = status?["meeting"] as? [String: Any]
    let (symbol, label) =
      server.failed != nil ? ("exclamationmark.triangle", "aside: the server failed")
      : live != nil ? ("record.circle.fill", "aside: recording")
      : status?["writing"] as? Bool == true ? ("doc.text", "aside: writing the notes")
      : ("waveform", "aside")
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    image?.isTemplate = true
    item.button?.image = image
    item.button?.title = (live?["startedAt"] as? Double).map { ms in
      let s = max(0, Int(Date().timeIntervalSince1970 - ms / 1000))
      return String(format: " %d:%02d", s / 60, s % 60)
    } ?? ""
  }

  // MARK: Menu

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let up = status != nil, live = status?["meeting"] as? [String: Any] != nil
    let open = add(menu, "Open aside", #selector(openMain), enabled: up)
    if let key = activeKeys.first, !key.isEmpty {
      let parts = key.split(separator: "+").map(String.init)
      let flags: [String: NSEvent.ModifierFlags] = ["cmd": .command, "opt": .option, "ctrl": .control, "shift": .shift]
      open.keyEquivalent = parts.last!
      open.keyEquivalentModifierMask = parts.dropLast().reduce(into: []) { $0.formUnion(flags[$1] ?? []) }
    }
    let start = add(menu, "Start meeting", nil, enabled: up && !live && modelReady)
    start.submenu = NSMenu()
    add(start.submenu!, "Local only", #selector(startMeeting(_:))).representedObject = "local"
    add(start.submenu!, "Claude allowed", #selector(startMeeting(_:))).representedObject = "allowed"
    add(menu, "Stop and write notes", #selector(stopMeeting), enabled: live)
    add(menu, panel.isVisible ? "Hide panel" : "Show panel", #selector(togglePanel), enabled: up)
    recentMenu = NSMenu() // a menu can be the submenu of one item only
    add(menu, "Recent meetings", nil, enabled: up).submenu = recentMenu
    fillRecent()
    // The list arrives while the menu is open and fills the submenu then.
    API.get("/api/meetings") { [self] r in
      if let list = r?["meetings"] as? [[String: Any]] { recent = list; fillRecent() }
    }
    add(menu, "Preferences…", #selector(openPrefs), enabled: up)
    if let failed = server.failed {
      menu.addItem(.separator())
      add(menu, failed, nil, enabled: false)
      add(menu, "Restart server", #selector(restartServer))
      add(menu, "Show log", #selector(showLog))
    }
    menu.addItem(.separator())
    add(menu, "Quit aside", #selector(quit))
  }

  private func fillRecent() {
    recentMenu.removeAllItems()
    let done = recent.filter { $0["done"] as? Bool == true }.prefix(5)
    for m in done {
      let date = (m["startedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? ""
      add(recentMenu, "\(m["title"] as? String ?? "Meeting"), \(date)", #selector(openMeeting(_:))).representedObject = m["id"]
    }
    if done.isEmpty { add(recentMenu, "No meetings yet", nil, enabled: false) }
  }

  @discardableResult private func add(_ menu: NSMenu, _ title: String, _ action: Selector?, enabled: Bool = true) -> NSMenuItem {
    let i = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
    i.target = self
    i.isEnabled = enabled
    return i
  }

  // An accessory app shows no menu bar, but its key equivalents still work. Without these, Copy, Paste and Close
  // do nothing in the pages.
  private func editMenu() -> NSMenu {
    let edit = NSMenu(title: "Edit")
    for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
                                 ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"), ("Close", "performClose:", "w")] {
      edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
    }
    let bar = NSMenu(), top = NSMenuItem()
    top.submenu = edit
    bar.addItem(top)
    return bar
  }

  // MARK: Actions

  @objc private func openMain() {
    if let main { return main.show() }
    openMainWindow("/")
  }

  private func openMainWindow(_ path: String) {
    main = WebWindow(path: path, name: "main", title: "aside", size: NSSize(width: 1000, height: 760), bridge: bridge) { [weak self] in self?.main = nil }
  }

  // An open page opens the meeting on hashchange, so it is not loaded again.
  @objc private func openMeeting(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    if let main {
      main.web.evaluateJavaScript("location.hash = \(json(id))", completionHandler: nil)
      return main.show()
    }
    openMainWindow("/#" + (id.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? ""))
  }

  @objc private func openPrefs() {
    if let prefsWindow { return prefsWindow.show() }
    // 680, a little more than the page's own height, so it needs no scroll bar.
    prefsWindow = WebWindow(path: "/prefs", name: "prefs", title: "aside Preferences", size: NSSize(width: 560, height: 680), bridge: bridge) { [weak self] in
      guard let self else { return }
      prefsWindow = nil
      if keysPaused { keysPaused = false; registerHotkeys() }
    }
  }

  @objc private func startMeeting(_ sender: NSMenuItem) {
    let holders = micBundleIDs().compactMap(detector.watched)
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    let app = holders.first { $0 == front } ?? holders.first
    let body: [String: Any] = ["title": app.map { "\(appName($0)) call" } ?? "Meeting", "claude": sender.representedObject as? String ?? "local",
                               "app": app ?? "", "backend": prefs["backend"] ?? "auto", "keepAudio": prefs["keepAudio"] ?? false]
    API.post("/api/meeting/start", body) { [self] r in
      if let e = problem(r) { alert("The meeting did not start.", e) }
      refreshStatus()
    }
  }

  @objc private func stopMeeting() {
    API.post("/api/meeting/stop", [:]) { [self] r in
      if let e = problem(r) { alert("The notes were not written.", e) }
      refreshStatus()
    }
  }

  private func problem(_ answer: [String: Any]?) -> String? { answer == nil ? "aside did not answer." : answer?["error"] as? String }

  @objc private func togglePanel() { panel.isVisible ? panel.close() : panel.show() }
  @objc private func restartServer() { server.restart() }
  @objc private func showLog() { NSWorkspace.shared.open(logURL) }
  @objc private func quit() { NSApp.terminate(nil) }

  private func appName(_ id: String) -> String {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { FileManager.default.displayName(atPath: $0.path) } ?? id
  }

  private func alert(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    NSApp.activate()
    a.runModal()
  }

  // MARK: Bridge

  func received(_ message: [String: Any], from web: WKWebView?) {
    switch message["type"] as? String {
    case "native": answerNative(web)
    case "setLoginItem":
      do {
        try message["on"] as? Bool == true ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
        answerNative(web)
      } catch { answerNative(web, error: error.localizedDescription) }
    case "openSettings":
      let pane = message["pane"] as? String == "screen" ? "ScreenCapture" : "Microphone"
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_" + pane)!)
    case "panel": panel.resize(collapsed: message["collapsed"] as? Bool == true)
    case "dismiss": updatePanel { prompting = false }
    case "keep": detector.keepRecording()
    // The new meeting closes the prompt. Clearing it here would close the panel before the meeting shows.
    case "started": refreshStatus()
    case "recordingHotkey": keysPaused = message["on"] as? Bool == true; registerHotkeys()
    default: break
    }
  }

  private func answerNative(_ web: WKWebView?, error: String? = nil) {
    let mic = switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: "granted"
    case .denied, .restricted: "denied"
    default: "unknown"
    }
    // Preflight only tells granted or not: it cannot tell denied from never asked.
    var n: [String: Any] = ["loginItem": SMAppService.mainApp.status == .enabled, "mic": mic, "screen": CGPreflightScreenCaptureAccess() ? "granted" : "unknown"]
    n["error"] = error
    web?.evaluateJavaScript("asideNative(\(json(n)))", completionHandler: nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
