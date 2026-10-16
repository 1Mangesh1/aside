// Assert-based tests for Logic.swift, because XCTest ships only with Xcode. Run: npm run test:app
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) { if !ok { print("FAIL line \(line): \(what)"); failures += 1 } }
let apps = ["us.zoom.xos", "com.google.Chrome"]

// Hot keys
check(parseHotkey("opt+cmd+a")! == Hotkey(keyCode: 0x00, modifiers: 0x0800 | 0x0100), "opt+cmd+a")
check(parseHotkey(" Cmd + Shift + K ")! == Hotkey(keyCode: 0x28, modifiers: 0x0100 | 0x0200), "spacing and case")
check(parseHotkey("ctrl+opt+9")! == Hotkey(keyCode: 0x19, modifiers: 0x1000 | 0x0800), "digit")
check(parseHotkey("shift+a") == nil && parseHotkey("opt+k") == nil && parseHotkey("opt+shift+k") == nil, "needs cmd or ctrl")
check(parseHotkey("cmd+c") == nil && parseHotkey("ctrl+9") == nil, "needs two modifiers, so it never takes a plain app shortcut")
check(parseHotkey("cmd+") == nil && parseHotkey("cmd+tab") == nil, "one letter or digit only")

// Detection: a watched app holds the mic for 5 s before the prompt, and the prompt comes once per call.
var d = CallDetector(watch: apps)
check(d.step(active: ["us.zoom.xos"], recording: false, now: 0).isEmpty, "not yet")
check(d.step(active: ["us.zoom.xos"], recording: false, now: 4).isEmpty, "still not 5 s")
check(d.step(active: ["us.zoom.xos"], recording: false, now: 5) == [.callStarted("us.zoom.xos")], "prompt at 5 s")
check(d.step(active: ["us.zoom.xos"], recording: false, now: 7).isEmpty, "only once")

// A dictation app is not watched; a browser helper counts as its browser.
var dict = CallDetector(watch: apps)
_ = dict.step(active: ["com.wispr.flow"], recording: false, now: 0)
check(dict.step(active: ["com.wispr.flow"], recording: false, now: 9).isEmpty, "dictation ignored")
var meet = CallDetector(watch: apps)
_ = meet.step(active: ["com.google.Chrome.helper"], recording: false, now: 0)
check(meet.step(active: ["com.google.Chrome.helper"], recording: false, now: 5) == [.callStarted("com.google.Chrome")], "helper prefix")

// Recording during a call: release prompts after 10 s, stops at 120 s; the mic coming back cancels.
var r = CallDetector(watch: apps)
_ = r.step(active: ["us.zoom.xos"], recording: true, now: 0)
check(r.step(active: [], recording: true, now: 1).isEmpty, "grace period")
check(r.step(active: [], recording: true, now: 11) == [.callEnded], "ended prompt")
check(r.step(active: ["us.zoom.xos"], recording: true, now: 50).isEmpty, "mic back")
check(r.step(active: [], recording: true, now: 60).isEmpty, "new release starts over")
check(r.step(active: [], recording: true, now: 70) == [.callEnded], "ended again")
check(r.step(active: [], recording: true, now: 180) == [.autoStop], "auto stop at 120 s")

// Keep recording after a call ended: the meeting becomes manual and detection never stops it.
var keep = CallDetector(watch: apps)
_ = keep.step(active: ["us.zoom.xos"], recording: true, now: 0)
_ = keep.step(active: [], recording: true, now: 1)
check(keep.step(active: [], recording: true, now: 11) == [.callEnded], "ended")
keep.keepRecording()
check(keep.step(active: [], recording: true, now: 200).isEmpty, "kept: no auto stop")

// A recording started by hand, with no call, is never stopped by detection.
var hand = CallDetector(watch: apps)
check(hand.step(active: [], recording: true, now: 0).isEmpty && hand.step(active: [], recording: true, now: 500).isEmpty, "manual recording kept")

// A recording started by hand before the call, then stopped while the call goes on: no prompt to record that call.
var early = CallDetector(watch: apps)
_ = early.step(active: [], recording: true, now: 0)
_ = early.step(active: ["us.zoom.xos"], recording: true, now: 2)
check(early.step(active: ["us.zoom.xos"], recording: false, now: 300).isEmpty, "stopped mid-call")

// A short mic gap (mute, device change, a missed read) is the same call. A gap of 10 s or more ends it.
var gap = CallDetector(watch: apps)
var seen: [DetectEvent] = []
for t in 0...5 { seen += gap.step(active: ["us.zoom.xos"], recording: false, now: Double(t)) }
check(seen == [.callStarted("us.zoom.xos")], "first prompt")
seen = []
for t in [7, 9] { seen += gap.step(active: [], recording: false, now: Double(t)) }
for t in 11...20 { seen += gap.step(active: ["us.zoom.xos"], recording: false, now: Double(t)) }
check(seen.isEmpty, "short gap: same call, no second prompt")
for t in 21...31 { seen += gap.step(active: [], recording: false, now: Double(t)) }
for t in 40...44 { seen += gap.step(active: ["us.zoom.xos"], recording: false, now: Double(t)) }
check(seen.isEmpty && gap.step(active: ["us.zoom.xos"], recording: false, now: 45) == [.callStarted("us.zoom.xos")], "10 s gap: a new call prompts again")

// Keep recording stays manual until the recording stops, even if a watched app takes the mic again.
var man = CallDetector(watch: apps)
_ = man.step(active: ["us.zoom.xos"], recording: true, now: 0)
_ = man.step(active: [], recording: true, now: 1)
check(man.step(active: [], recording: true, now: 11) == [.callEnded], "manual: ended")
man.keepRecording()
check(man.step(active: ["us.zoom.xos"], recording: true, now: 20).isEmpty && man.step(active: [], recording: true, now: 30).isEmpty, "manual: mic back and released")
check(man.step(active: [], recording: true, now: 40).isEmpty && man.step(active: [], recording: true, now: 150).isEmpty, "manual: no end prompt, no auto stop")
_ = man.step(active: [], recording: false, now: 200)
_ = man.step(active: ["us.zoom.xos"], recording: true, now: 300)
_ = man.step(active: [], recording: true, now: 301)
check(man.step(active: [], recording: true, now: 311) == [.callEnded], "manual mode ends with the recording")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("logic tests passed")
