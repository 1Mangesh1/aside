import AppKit
import WebKit

// WKUserContentController holds its handlers strongly. The weak link keeps a web view from holding the app delegate.
final class Bridge: NSObject, WKScriptMessageHandler {
  weak var app: AppDelegate?
  init(_ app: AppDelegate) { self.app = app }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only aside's own pages may use the bridge, not a site that a link opened in the same web view.
    let origin = message.frameInfo.securityOrigin
    guard origin.host == "127.0.0.1", origin.port == 4318, let body = message.body as? [String: Any] else { return }
    app?.received(body, from: message.webView)
  }
}

func makeWebView(_ path: String, _ bridge: Bridge) -> WKWebView {
  let config = WKWebViewConfiguration()
  config.userContentController.add(bridge, name: "aside")
  let web = WKWebView(frame: .zero, configuration: config)
  web.load(URLRequest(url: URL(string: API.base + path)!))
  return web
}

// A value as JavaScript source. JSON encoding keeps any text inside its string literal.
func json(_ value: Any) -> String {
  String(decoding: (try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)) ?? Data("null".utf8), as: UTF8.self)
}

// A normal window with one page. The owner drops its reference in onClose, which releases the window and its web view.
final class WebWindow: NSObject, NSWindowDelegate {
  let window: NSWindow, web: WKWebView
  private let onClose: () -> Void

  init(path: String, name: String, title: String, size: NSSize, bridge: Bridge, onClose: @escaping () -> Void) {
    web = makeWebView(path, bridge)
    window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    self.onClose = onClose
    super.init()
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary] // it opens on the current Space, also over a full-screen app
    window.title = title
    window.contentView = web
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("aside." + name)
    show()
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  // Async, so the window is not freed while AppKit is still closing it.
  func windowWillClose(_ notification: Notification) { DispatchQueue.main.async(execute: onClose) }
}

// The small always-on-top panel. It takes key focus for typing without activating the app, so the call app stays in
// front. Its web view exists only while the panel is shown.
final class FloatingPanel: NSPanel, WKNavigationDelegate {
  static let expanded = NSSize(width: 340, height: 220), collapsed = NSSize(width: 140, height: 36)
  var onClose: () -> Void = {}
  private let bridge: Bridge
  private var web: WKWebView?
  private var queued: [String]? // scripts that wait for the page to finish loading, or nil once it has

  init(bridge: Bridge) {
    self.bridge = bridge
    super.init(contentRect: NSRect(origin: .zero, size: Self.expanded), styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView], backing: .buffered, defer: true)
    titleVisibility = .hidden
    titlebarAppearsTransparent = true
    // The page draws its own 36 px header, and the standard buttons would sit on top of it. Cmd-W still closes.
    for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { standardWindowButton(b)?.isHidden = true }
    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    if !setFrameUsingName("aside.panel"), let screen = NSScreen.main?.visibleFrame {
      setFrame(NSRect(x: screen.maxX - Self.expanded.width - 12, y: screen.maxY - Self.expanded.height - 12, width: Self.expanded.width, height: Self.expanded.height), display: false)
    }
    setFrameAutosaveName("aside.panel")
  }

  override var canBecomeKey: Bool { true }

  func show() {
    if web == nil {
      let w = makeWebView("/panel", bridge)
      w.navigationDelegate = self
      contentView = w
      web = w
      queued = []
      resize(collapsed: false) // a new page starts expanded
    }
    orderFrontRegardless()
  }

  override func close() {
    super.close()
    web = nil
    contentView = NSView()
    onClose()
  }

  func resize(collapsed: Bool) {
    let size = collapsed ? Self.collapsed : Self.expanded, f = frame
    setFrame(NSRect(x: f.maxX - size.width, y: f.maxY - size.height, width: size.width, height: size.height), display: true)
  }

  func prompt(bundleId: String, name: String) {
    show()
    run("promptStart(\(json(bundleId)), \(json(name)))")
  }

  // -1 hides the countdown, and does not open a closed panel for that.
  func ending(seconds: Int) {
    if seconds >= 0 { show() }
    run("promptEnding(\(seconds))")
  }

  func focusAsk() {
    show()
    makeKey()
    makeFirstResponder(web)
    run("focusAsk()")
  }

  private func run(_ script: String) {
    guard let web else { return }
    if queued != nil { queued!.append(script) } else { web.evaluateJavaScript(script, completionHandler: nil) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    queued?.forEach { webView.evaluateJavaScript($0, completionHandler: nil) }
    queued = nil
  }
}
