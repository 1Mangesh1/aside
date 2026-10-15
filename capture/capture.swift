// aside-capture: records the call's audio (system output) and the microphone until SIGINT or SIGTERM.
// Usage: aside-capture <out-dir> [app]. It writes them-0001.m4a and me-0001.m4a, and starts the next pair of files
// every ASIDE_CHUNK_SECONDS (default 15), all aligned to one start time. Stdout: "recording" once capture runs,
// "chunk <n> <them start> <me start>" when both files of chunk n are complete (start offsets in seconds), "stopped".
// With [app] (an app name such as "Microsoft Teams", or part of a bundle id), only that app's audio is recorded.
// Needs Screen Recording and Microphone permission for the app that launches it (the terminal).
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let sampleRate = 16_000.0
let chunkSeconds = Double(ProcessInfo.processInfo.environment["ASIDE_CHUNK_SECONDS"] ?? "") ?? 15

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

// One output track. Incoming buffers are converted to 16 kHz mono; a gap in the stream is filled with silence,
// so a position in the track always equals the time since the shared start.
// ASIDE_DEBUG=1 prints each track's incoming audio format once, to stderr.
let debug = ProcessInfo.processInfo.environment["ASIDE_DEBUG"] == "1"

final class Track {
  let label: String
  var loggedFormat = false
  var file: AVAudioFile?
  let format: AVAudioFormat
  var converter: AVAudioConverter?
  var written: AVAudioFramePosition = 0
  var chunkStart = 0.0 // seconds from the shared start to the first frame of the current chunk file
  static let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate,
                                        AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000]

  init(url: URL, label: String) throws {
    self.label = label
    let f = try AVAudioFile(forWriting: url, settings: Track.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    file = f
    format = f.processingFormat
  }

  // Closes the current chunk file and opens the next. `written` keeps counting across chunks, so silence padding
  // still lines each chunk up with the shared start, and chunkStart is the new chunk's offset.
  func rotate(to url: URL) throws {
    file = nil
    file = try AVAudioFile(forWriting: url, settings: Track.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    chunkStart = Double(written) / sampleRate
  }

  func append(_ sb: CMSampleBuffer, at seconds: Double) throws {
    guard let file, let desc = CMSampleBufferGetFormatDescription(sb),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
          let inFormat = AVAudioFormat(streamDescription: asbd) else { return }
    if debug && !loggedFormat {
      loggedFormat = true
      let a = asbd.pointee
      FileHandle.standardError.write(Data("format \(label): rate=\(a.mSampleRate) channels=\(a.mChannelsPerFrame) bits=\(a.mBitsPerChannel) flags=\(a.mFormatFlags) bytesPerFrame=\(a.mBytesPerFrame) interleaved=\(inFormat.isInterleaved) common=\(inFormat.commonFormat.rawValue)\n".utf8))
    }
    let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
    guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else { return }
    input.frameLength = frames
    guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: input.mutableAudioBufferList) == noErr else { return }

    let expected = AVAudioFramePosition(seconds * sampleRate)
    if expected - written > AVAudioFramePosition(sampleRate / 10), let pad = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(expected - written)) {
      pad.frameLength = pad.frameCapacity
      if let ch = pad.floatChannelData { memset(ch[0], 0, Int(pad.frameLength) * MemoryLayout<Float>.size) }
      try file.write(from: pad)
      written += AVAudioFramePosition(pad.frameLength)
    }

    if converter == nil || converter!.inputFormat != inFormat { converter = AVAudioConverter(from: inFormat, to: format) }
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(frames) * sampleRate / inFormat.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return input
    }
    if let error { throw error }
    if out.frameLength > 0 {
      try file.write(from: out)
      written += AVAudioFramePosition(out.frameLength)
    }
  }

  // Releasing the file writes the AAC container's index; without it the .m4a is unreadable.
  func close() { file = nil }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let queue = DispatchQueue(label: "aside.capture")
  let dir: URL
  let them: Track
  let me: Track
  var stream: SCStream?
  var start: CMTime?
  var chunk = 1
  let app: String?

  init(dir: URL, app: String?) throws {
    self.dir = dir
    self.app = app?.lowercased()
    them = try Track(url: Recorder.url(dir, "them", 1), label: "them")
    me = try Track(url: Recorder.url(dir, "me", 1), label: "me")
  }

  static func url(_ dir: URL, _ track: String, _ n: Int) -> URL {
    dir.appendingPathComponent("\(track)-\(String(format: "%04d", n)).m4a")
  }

  func announce(_ n: Int, _ themStart: Double, _ meStart: Double) {
    print("chunk \(n) \(themStart) \(meStart)")
    fflush(stdout)
  }

  func run() async throws {
    // All apps, not only on-screen ones: a minimised call window or one on another desktop still plays audio.
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else { fail("No display found to attach the audio capture to.") }
    var filter = SCContentFilter(display: display, excludingWindows: [])
    if let app {
      let apps = content.applications.filter { $0.applicationName.lowercased() == app || $0.bundleIdentifier.lowercased().contains(app) }
      if apps.isEmpty { fail("No running app matches \"\(app)\". Open the meeting app first.") }
      filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
    }
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.captureMicrophone = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = Int(sampleRate)
    config.channelCount = 1
    // Video is required by the stream but unused: the smallest frame at one frame per second.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    let s = SCStream(filter: filter, configuration: config, delegate: self)
    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
    try await s.startCapture()
    stream = s
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard sb.isValid else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    if start == nil { start = pts }
    let seconds = CMTimeGetSeconds(CMTimeSubtract(pts, start!))
    // Both tracks move to the next chunk at the same boundary of the shared clock.
    if seconds >= Double(chunk) * chunkSeconds {
      let (themStart, meStart) = (them.chunkStart, me.chunkStart)
      do {
        try them.rotate(to: Recorder.url(dir, "them", chunk + 1))
        try me.rotate(to: Recorder.url(dir, "me", chunk + 1))
        announce(chunk, themStart, meStart)
        chunk += 1
      } catch {
        FileHandle.standardError.write(Data("chunk rotation failed: \(error)\n".utf8))
      }
    }
    do {
      switch type {
      case .audio: try them.append(sb, at: seconds)
      case .microphone: try me.append(sb, at: seconds)
      default: break
      }
    } catch {
      FileHandle.standardError.write(Data("audio write failed: \(error)\n".utf8))
    }
  }

  // Close and announce the open chunk before exiting, so what was recorded stays readable and gets transcribed.
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async {
      self.them.close()
      self.me.close()
      self.announce(self.chunk, self.them.chunkStart, self.me.chunkStart)
      fail("Capture stopped: \(error.localizedDescription)")
    }
  }

  func finish() async {
    try? await stream?.stopCapture()
    queue.sync {
      them.close()
      me.close()
      announce(chunk, them.chunkStart, me.chunkStart)
    }
  }
}

let args = CommandLine.arguments
guard args.count == 2 || args.count == 3 else { fail("usage: aside-capture <out-dir> [app]") }
let dir = URL(fileURLWithPath: args[1], isDirectory: true)
do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch { fail("Cannot create \(dir.path): \(error)") }
let recorder: Recorder
do { recorder = try Recorder(dir: dir, app: args.count == 3 ? args[2] : nil) } catch { fail("Cannot open the output files: \(error)") }

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler {
    Task {
      await recorder.finish()
      print("stopped")
      exit(0)
    }
  }
  src.resume()
  signalSources.append(src)
}

Task {
  do {
    try await recorder.run()
    print("recording")
    fflush(stdout)
  } catch {
    fail("Could not start capture: \(error.localizedDescription). Check Screen Recording and Microphone permission for your terminal in System Settings > Privacy & Security.")
  }
}
dispatchMain()
