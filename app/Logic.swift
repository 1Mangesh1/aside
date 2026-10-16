// Pure logic for the menu-bar app, kept free of AppKit so that app/logic-tests/main.swift can test it with swiftc alone.
import Foundation

// A global hot key in Carbon terms. Modifier bits: cmd 0x0100, shift 0x0200, option 0x0800, control 0x1000.
struct Hotkey: Equatable { let keyCode: UInt32; let modifiers: UInt32 }

private let keyCodes: [Character: UInt32] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
  "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
  "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D, "o": 0x1F, "u": 0x20, "i": 0x22,
  "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
]
private let modifierBits: [String: UInt32] = ["cmd": 0x0100, "shift": 0x0200, "opt": 0x0800, "ctrl": 0x1000]

// "opt+cmd+a" -> Hotkey. nil unless it has two modifiers, one of them Command or Control: macOS refuses
// Shift/Option-only global hot keys, and a one-modifier key such as Command-C would take a shortcut from every app.
func parseHotkey(_ text: String) -> Hotkey? {
  let parts = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
  guard parts.count >= 2, let last = parts.last, last.count == 1, let code = keyCodes[last.first!] else { return nil }
  var mods: UInt32 = 0
  for p in parts.dropLast() { guard let bit = modifierBits[p] else { return nil }; mods |= bit }
  guard mods & (0x0100 | 0x1000) != 0, mods.nonzeroBitCount >= 2 else { return nil }
  return Hotkey(keyCode: code, modifiers: mods)
}

enum DetectEvent: Equatable { case callStarted(String), callEnded, callResumed, autoStop }

// Fed every poll with the bundle ids that hold the microphone. A watched id also matches its helpers
// ("com.google.Chrome.helper"). A call is a watched app on the mic for startDelay without a break, and it ends
// after endDelay with no watched app on the mic. Only a recording that a call armed is stopped when the call ends.
struct CallDetector {
  static let startDelay = 5.0, endDelay = 10.0, stopDelay = 120.0

  // never: started by hand, or no call yet. onCallEnd: a call armed it. kept: the user chose Keep recording.
  private enum StopMode { case never, onCallEnd, kept }

  var watch: [String]
  private var app: String?               // the watched app of the current call
  private var since: Double?             // when `app` took the mic; any gap resets it
  private var releasedAt: Double?        // when the current gap with no watched app on the mic began
  private var callHandled = false        // the call got its prompt or a recording, so it gets no more prompts
  private var stopMode = StopMode.never  // what the end of the call does to the current recording
  private var countdown = false          // callEnded was sent, and no autoStop, callResumed or Keep recording followed

  init(watch: [String]) { self.watch = watch }

  func watched(_ id: String) -> String? { watch.first { id == $0 || id.hasPrefix($0 + ".") } }

  mutating func step(active: [String], recording: Bool, now: Double) -> [DetectEvent] {
    var out: [DetectEvent] = []
    if !recording { stopMode = .never; countdown = false }
    let holders = active.compactMap(watched)
    // Prefer the current app while it still holds the mic, so the order of `active` does not restart the timer.
    if let current = holders.first(where: { $0 == app }) ?? holders.first {
      if current != app { app = current; since = nil; callHandled = false }
      let start = since ?? now
      since = start
      releasedAt = nil
      if recording {
        callHandled = true
        if stopMode == .never && now - start >= Self.startDelay { stopMode = .onCallEnd }
        if countdown { countdown = false; out.append(.callResumed) }
      } else if !callHandled && now - start >= Self.startDelay { callHandled = true; out.append(.callStarted(current)) }
    } else {
      since = nil
      let start = releasedAt ?? now
      releasedAt = start
      // A gap shorter than endDelay (mute, device change, a missed read) is still the same call.
      if now - start >= Self.endDelay { app = nil; callHandled = false }
      if recording && stopMode == .onCallEnd {
        if !countdown && now - start >= Self.endDelay { countdown = true; out.append(.callEnded) }
        if now - start >= Self.stopDelay { stopMode = .never; countdown = false; out.append(.autoStop) }
      }
    }
    return out
  }

  // The user chose Keep recording: the call no longer stops this recording.
  mutating func keepRecording() { stopMode = .kept; countdown = false }
}
