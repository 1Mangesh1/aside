import Foundation

let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/aside.log")
// O_APPEND, so the server's output and the app's own lines add to the end instead of writing over each other.
let logFile: FileHandle = {
  let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
  return fd < 0 ? FileHandle.nullDevice : FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}()
func appLog(_ text: String) { try? logFile.write(contentsOf: Data("[app] \(text)\n".utf8)) }

// Runs `node server.mjs` in the checkout named by the Info.plist key AsideRoot. A server that already answers on the
// port (for example one from aside.sh) is used as it is and never stopped.
final class ServerProcess {
  private(set) var failed: String?
  private var owned = false, stopping = false
  private var proc: Process?
  private var restarts: [Date] = []

  func start() {
    API.get("/api/status") { [self] status in
      if status != nil { return appLog("using the server that already runs on port 4318") }
      owned = true
      launch()
    }
  }

  func stop() {
    guard owned, let proc else { return }
    stopping = true
    proc.terminate()
  }

  private func launch() {
    var env = ProcessInfo.processInfo.environment
    if let path = Self.loginPath { env["PATH"] = path }
    guard let node = env["PATH"]?.split(separator: ":").map({ "\($0)/node" }).first(where: FileManager.default.isExecutableFile(atPath:)) else {
      return fail("node is not on the PATH of your login shell. Install Node 22 or later (brew install node), then open aside again.")
    }
    guard let root = Bundle.main.object(forInfoDictionaryKey: "AsideRoot") as? String else { return fail("Info.plist has no AsideRoot. Build the app with: npm run build:app") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = ["server.mjs"]
    p.currentDirectoryURL = URL(fileURLWithPath: root)
    p.environment = env
    p.standardOutput = logFile
    p.standardError = logFile
    p.terminationHandler = { p in DispatchQueue.main.async { self.exited(p.terminationStatus) } }
    do { try p.run(); proc = p; appLog("server started (pid \(p.processIdentifier))") } catch { fail("could not start node: \(error.localizedDescription)") }
  }

  private func exited(_ code: Int32) {
    proc = nil
    if stopping { return }
    appLog("server exited with status \(code)")
    restarts = restarts.filter { $0.timeIntervalSinceNow > -60 }
    guard restarts.count < 3 else { return fail("The server stopped 4 times within a minute.") }
    restarts.append(Date())
    appLog("restarting the server")
    launch()
  }

  private func fail(_ why: String) {
    failed = why
    appLog("server failed: \(why)")
  }

  // An app opened from Finder gets the short launchd PATH, so node, uv and claude come from the login shell's PATH.
  // The marker skips anything that the shell's startup files print first.
  private static let loginPath: String? = {
    let p = Process(), out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-ilc", #"printf "__ASIDE__%s" "$PATH""#]
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    return text.range(of: "__ASIDE__").map { String(text[$0.upperBound...]) }
  }()
}

enum API {
  static let base = "http://127.0.0.1:4318"

  // done gets the JSON object (an error answer too, as { error }), or nil when the server did not answer. On the main queue.
  static func get(_ path: String, _ done: @escaping ([String: Any]?) -> Void) { send(path, nil, done) }
  static func post(_ path: String, _ body: [String: Any], _ done: @escaping ([String: Any]?) -> Void = { _ in }) { send(path, body, done) }

  private static func send(_ path: String, _ body: [String: Any]?, _ done: @escaping ([String: Any]?) -> Void) {
    // A POST can wait for the notes to be written, so only a GET gets a short timeout.
    var req = URLRequest(url: URL(string: base + path)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: body == nil ? 5 : 600)
    req.setValue(base, forHTTPHeaderField: "Origin") // allowedOrigin() in server.mjs answers 403 to a POST without it
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let body { req.httpMethod = "POST"; req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
      DispatchQueue.main.async { done(json) }
    }.resume()
  }
}
