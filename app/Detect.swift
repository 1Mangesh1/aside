import CoreAudio
import Foundation

// The bundle ids of the processes that read from an input device now, without this app. The app's 2 s timer polls
// this: on macOS 26 a listener on the input flag never fires.
func micBundleIDs() -> [String] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &objects) == noErr else { return [] }
  let own = Bundle.main.bundleIdentifier
  return objects.compactMap { object in
    var running: UInt32 = 0, runningSize = UInt32(MemoryLayout<UInt32>.size)
    addr.mSelector = kAudioProcessPropertyIsRunningInput
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &runningSize, &running) == noErr, running != 0 else { return nil }
    var id: Unmanaged<CFString>?, idSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    addr.mSelector = kAudioProcessPropertyBundleID
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &idSize, &id) == noErr, let text = id?.takeRetainedValue() as String?,
          !text.isEmpty, text != own else { return nil }
    return text
  }
}
