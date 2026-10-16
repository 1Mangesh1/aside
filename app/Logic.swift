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
  return mods & (0x0100 | 0x1000) == 0 || mods.nonzeroBitCount < 2 ? nil : Hotkey(keyCode: code, modifiers: mods)
}

enum DetectEvent: Equatable { case callStarted(String), callEnded, autoStop }

// Fed every poll with the bundle ids that hold the microphone. A watched id also matches its helpers
// ("com.google.Chrome.helper"). Only a recording that saw a call is stopped when the call goes away.
struct CallDetector {
  var watch: [String]
  let startDelay = 5.0, endDelay = 10.0, stopDelay = 120.0
  private var app: String?, since = 0.0, prompted = false
  private var sawCall = false, manual = false, releasedAt: Double?, endPrompted = false

  init(watch: [String]) { self.watch = watch }

  private func watched(_ id: String) -> String? { watch.first { id == $0 || id.hasPrefix($0 + ".") } }

  mutating func step(active: [String], recording: Bool, now: Double) -> [DetectEvent] {
    var out: [DetectEvent] = []
    if !recording { sawCall = false; manual = false; endPrompted = false }
    if let current = active.compactMap(watched).first {
      if current != app { app = current; since = now; prompted = false }
      releasedAt = nil
      if recording { sawCall = !manual; prompted = true; endPrompted = false }
      else if !prompted && now - since >= startDelay { prompted = true; out.append(.callStarted(current)) }
    } else {
      let r = releasedAt ?? now
      releasedAt = r
      // A gap shorter than endDelay (mute, device change, a missed read) is still the same call.
      if now - r >= endDelay { app = nil; prompted = false }
      if recording && sawCall {
        if !endPrompted && now - r >= endDelay { endPrompted = true; out.append(.callEnded) }
        if now - r >= stopDelay { sawCall = false; out.append(.autoStop) }
      }
    }
    return out
  }

  // The user chose Keep recording: treat the meeting as manual until it stops.
  mutating func keepRecording() { manual = true; sawCall = false; endPrompted = false }
}
