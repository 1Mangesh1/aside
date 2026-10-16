// Assert-based tests for Logic.swift, because XCTest ships only with Xcode. Run: npm run test:app
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) { if !ok { print("FAIL line \(line): \(what)"); failures += 1 } }
// Steps the detector every 2 s, as the app polls, and returns the events by time.
func poll(_ d: inout CallDetector, _ from: Int, _ to: Int, _ active: [String], recording: Bool) -> [Int: [DetectEvent]] {
  var out: [Int: [DetectEvent]] = [:]
  for t in stride(from: from, through: to, by: 2) {
    let e = d.step(active: active, recording: recording, now: Double(t))
    if !e.isEmpty { out[t] = e }
  }
  return out
}
let apps = ["us.zoom.xos", "com.google.Chrome"]

// Hot keys
check(parseHotkey("opt+cmd+a") == Hotkey(keyCode: 0x00, modifiers: 0x0800 | 0x0100), "opt+cmd+a")
check(parseHotkey(" Cmd + Shift + K ") == Hotkey(keyCode: 0x28, modifiers: 0x0100 | 0x0200), "spacing and case")
check(parseHotkey("ctrl+opt+9") == Hotkey(keyCode: 0x19, modifiers: 0x1000 | 0x0800), "digit")
check(parseHotkey("shift+a") == nil, "needs cmd or ctrl: shift")
check(parseHotkey("opt+k") == nil, "needs cmd or ctrl: opt")
check(parseHotkey("opt+shift+k") == nil, "needs cmd or ctrl: opt+shift")
check(parseHotkey("cmd+c") == nil, "needs two modifiers, so it never takes a plain app shortcut")
check(parseHotkey("ctrl+9") == nil, "needs two modifiers: ctrl")
check(parseHotkey("cmd+") == nil, "needs a key")
check(parseHotkey("cmd+tab") == nil, "one letter or digit only")

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

// The 5 s hold must be unbroken: two one-poll grabs 8 s apart do not prompt.
var grabs = CallDetector(watch: apps)
var grabEvents: [DetectEvent] = []
for t in stride(from: 0, through: 20, by: 2) {
  grabEvents += grabs.step(active: t == 0 || t == 8 ? ["us.zoom.xos"] : [], recording: false, now: Double(t))
}
check(grabEvents.isEmpty, "two short grabs")

// Two watched apps in a changing order are one call, so the timer keeps running.
var flip = CallDetector(watch: apps)
var flipEvents: [Int: [DetectEvent]] = [:]
for t in stride(from: 0, through: 30, by: 2) {
  let e = flip.step(active: t % 4 == 0 ? ["us.zoom.xos", "com.google.Chrome"] : ["com.google.Chrome", "us.zoom.xos"], recording: false, now: Double(t))
  if !e.isEmpty { flipEvents[t] = e }
}
check(flipEvents == [6: [.callStarted("us.zoom.xos")]], "order flip: one prompt at 6 s")

// Recording during a call: release prompts after 10 s, stops at 120 s; the mic coming back resumes the call.
var r = CallDetector(watch: apps)
_ = r.step(active: ["us.zoom.xos"], recording: true, now: 0)
_ = r.step(active: ["us.zoom.xos"], recording: true, now: 5)
check(r.step(active: [], recording: true, now: 6).isEmpty, "grace period")
check(r.step(active: [], recording: true, now: 16) == [.callEnded], "ended prompt")
check(r.step(active: ["us.zoom.xos"], recording: true, now: 50) == [.callResumed], "mic back")
check(r.step(active: [], recording: true, now: 60).isEmpty, "new release starts over")
check(r.step(active: [], recording: true, now: 70) == [.callEnded], "ended again")
check(r.step(active: [], recording: true, now: 180) == [.autoStop], "auto stop at 120 s")

// Arming: a call stops a recording only after a watched app held the mic for 5 s without a break.
var blip = CallDetector(watch: apps)
check(poll(&blip, 0, 18, [], recording: true).isEmpty, "hand-started")
check(blip.step(active: ["com.google.Chrome.helper"], recording: true, now: 20).isEmpty, "one-poll grab by a Chrome tab")
check(poll(&blip, 22, 200, [], recording: true).isEmpty, "the grab does not arm auto stop")
var held = CallDetector(watch: apps)
check(poll(&held, 0, 28, ["us.zoom.xos"], recording: true).isEmpty, "Zoom held from 0")
check(poll(&held, 30, 150, [], recording: true) == [40: [.callEnded], 150: [.autoStop]], "release at 30: ended at 40, auto stop at 150")
check(poll(&held, 152, 400, [], recording: true).isEmpty, "auto stop only once")
var fromPrompt = CallDetector(watch: apps)
check(poll(&fromPrompt, 0, 6, ["us.zoom.xos"], recording: false) == [6: [.callStarted("us.zoom.xos")]], "prompt")
check(fromPrompt.step(active: ["us.zoom.xos"], recording: true, now: 8).isEmpty, "recording from the prompt")
check(poll(&fromPrompt, 10, 20, [], recording: true) == [20: [.callEnded]], "armed at once: the app already held the mic 5 s")

// Resume: the mic coming back during the end countdown sends callResumed once, and only after callEnded.
var res = CallDetector(watch: apps)
check(poll(&res, 0, 6, ["us.zoom.xos"], recording: true).isEmpty, "armed")
check(poll(&res, 8, 14, [], recording: true).isEmpty, "short release: no countdown")
check(res.step(active: ["us.zoom.xos"], recording: true, now: 16).isEmpty, "no callResumed without callEnded")
check(poll(&res, 18, 28, [], recording: true) == [28: [.callEnded]], "countdown")
check(res.step(active: ["us.zoom.xos"], recording: true, now: 30) == [.callResumed], "resumed")
check(res.step(active: ["us.zoom.xos"], recording: true, now: 32).isEmpty, "resumed only once")

// Keep recording after a call ended: the meeting becomes manual and detection never stops it.
var keep = CallDetector(watch: apps)
_ = keep.step(active: ["us.zoom.xos"], recording: true, now: 0)
_ = keep.step(active: ["us.zoom.xos"], recording: true, now: 5)
_ = keep.step(active: [], recording: true, now: 6)
check(keep.step(active: [], recording: true, now: 16) == [.callEnded], "ended")
keep.keepRecording()
check(keep.step(active: [], recording: true, now: 200).isEmpty, "kept: no auto stop")

// A recording started by hand, with no call, is never stopped by detection.
var hand = CallDetector(watch: apps)
check(hand.step(active: [], recording: true, now: 0).isEmpty, "manual recording")
check(hand.step(active: [], recording: true, now: 500).isEmpty, "manual recording kept")

// A recording started by hand before the call, then stopped while the call goes on: no prompt to record that call.
var early = CallDetector(watch: apps)
_ = early.step(active: [], recording: true, now: 0)
_ = early.step(active: ["us.zoom.xos"], recording: true, now: 2)
check(early.step(active: ["us.zoom.xos"], recording: false, now: 300).isEmpty, "stopped mid-call")
check(poll(&early, 302, 340, [], recording: false).isEmpty, "the call goes after a recording: no callGone")

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
check(seen == [.callGone], "10 s gap: the call ended, and its unanswered prompt with it")
check(gap.step(active: ["us.zoom.xos"], recording: false, now: 45) == [.callStarted("us.zoom.xos")], "10 s gap: a new call prompts again")

// Keep recording stays manual until the recording stops, even if a watched app holds the mic again.
var man = CallDetector(watch: apps)
_ = man.step(active: ["us.zoom.xos"], recording: true, now: 0)
_ = man.step(active: ["us.zoom.xos"], recording: true, now: 5)
_ = man.step(active: [], recording: true, now: 6)
check(man.step(active: [], recording: true, now: 16) == [.callEnded], "manual: ended")
man.keepRecording()
check(poll(&man, 20, 28, ["us.zoom.xos"], recording: true).isEmpty, "manual: mic back for 8 s")
check(poll(&man, 30, 200, [], recording: true).isEmpty, "manual: no end prompt, no auto stop")
_ = man.step(active: [], recording: false, now: 202)
check(poll(&man, 300, 306, ["us.zoom.xos"], recording: true).isEmpty, "new recording: call held 6 s")
check(poll(&man, 308, 318, [], recording: true) == [318: [.callEnded]], "manual mode ends with the recording")

// An unanswered prompt closes when the call goes, once, and only a prompt that is still open does.
var gone = CallDetector(watch: apps)
check(poll(&gone, 0, 6, ["us.zoom.xos"], recording: false) == [6: [.callStarted("us.zoom.xos")]], "gone: prompt")
check(poll(&gone, 8, 40, [], recording: false) == [18: [.callGone]], "gone: 10 s after the mic went, once")
var brief = CallDetector(watch: apps)
check(poll(&brief, 0, 2, ["us.zoom.xos"], recording: false).isEmpty, "brief: no prompt yet")
check(poll(&brief, 4, 40, [], recording: false).isEmpty, "brief: no callGone without a prompt")
var answered = CallDetector(watch: apps)
check(poll(&answered, 0, 6, ["us.zoom.xos"], recording: false) == [6: [.callStarted("us.zoom.xos")]], "answered: prompt")
check(poll(&answered, 8, 40, [], recording: true).isEmpty, "answered: no callGone while recording")

// The login shell prints the marker, then `env -0`: NUL-separated KEY=VALUE pairs. A value can hold = and a newline.
let shellOut = Data("Last login: Fri\n__ASIDE__PATH=/opt/homebrew/bin:/usr/bin\0NOTE=a=b\nline 2\0HOME=/Users/sam\0".utf8)
check(loginEnvironment(shellOut) == ["PATH": "/opt/homebrew/bin:/usr/bin", "NOTE": "a=b\nline 2", "HOME": "/Users/sam"], "env -0 after the marker")
check(loginEnvironment(Data("zsh: no such file\n".utf8)) == nil, "no marker")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("logic tests passed")
