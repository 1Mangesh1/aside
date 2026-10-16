import Carbon

// Global hot keys with Carbon's RegisterEventHotKey, which needs no Accessibility permission.
final class HotkeyCenter {
  private var refs: [EventHotKeyRef] = []
  private var actions: [UInt32: () -> Void] = [:]

  init() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    // A C callback cannot capture, so the center travels as the user data pointer. The center lives as long as the app.
    InstallEventHandler(GetApplicationEventTarget(), { _, event, data in
      var key = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &key)
      Unmanaged<HotkeyCenter>.fromOpaque(data!).takeUnretainedValue().actions[key.id]?()
      return noErr
    }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
  }

  // false when macOS refuses the key, for example because another app has it already.
  func register(id: UInt32, hotkey: Hotkey, action: @escaping () -> Void) -> Bool {
    var ref: EventHotKeyRef?
    let signature = "asid".utf8.reduce(OSType(0)) { $0 << 8 | OSType($1) }
    guard RegisterEventHotKey(hotkey.keyCode, hotkey.modifiers, EventHotKeyID(signature: signature, id: id), GetApplicationEventTarget(), 0, &ref) == noErr,
          let ref else { return false }
    refs.append(ref)
    actions[id] = action
    return true
  }

  func unregisterAll() {
    refs.forEach { UnregisterEventHotKey($0) }
    refs = []
    actions = [:]
  }
}
