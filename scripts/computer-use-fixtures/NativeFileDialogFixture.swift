// Owned AppKit target for native-file-dialog-regression.mjs. No injected input,
// external AX reads, application activation, or selected-file content reads.
// Build separately: xcrun swiftc NativeFileDialogFixture.swift -o <fixture>
// Run with one explicit fixture directory; commands and replies are JSON lines.
import AppKit
import Foundation

func emit(_ value: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return }
  FileHandle.standardOutput.write(bytes + Data([10]))
}

final class ParentControls: NSObject, NSTextFieldDelegate {
  let label: String
  let window: NSWindow
  var field: NSTextField
  let button: NSButton
  var edits = 0
  var clicks = 0
  var replacements = 0

  init(label: String, offset: CGFloat) {
    self.label = label
    window = NSWindow(
      contentRect: NSRect(x: 100 + offset, y: 180, width: 460, height: 240),
      styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    field = NSTextField(string: "unchanged-\(label)")
    button = NSButton(title: "\(label) counter", target: nil, action: nil)
    super.init()
    window.title = "Synara File Dialog Fixture \(ProcessInfo.processInfo.processIdentifier) \(label)"
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    field.frame = NSRect(x: 24, y: 140, width: 400, height: 28)
    field.setAccessibilityLabel("\(label) sentinel")
    field.delegate = self
    button.frame = NSRect(x: 24, y: 72, width: 190, height: 34)
    button.target = self
    button.action = #selector(clicked)
    window.contentView?.addSubview(field)
    window.contentView?.addSubview(button)
    window.orderFront(nil)
  }

  @objc func clicked() { clicks += 1 }
  func controlTextDidChange(_ notification: Notification) { edits += 1 }

  // Preserve appearance and value while replacing the actual native object.
  // A reference to the removed field must never be redirected to this one.
  func replaceField() {
    let previous = field
    let replacement = NSTextField(string: previous.stringValue)
    replacement.frame = previous.frame
    replacement.setAccessibilityLabel("\(label) sentinel")
    replacement.delegate = self
    previous.removeFromSuperview()
    window.contentView?.addSubview(replacement)
    field = replacement
    replacements += 1
  }

  func state() -> [String: Any] {
    return ["label": label, "windowId": window.windowNumber, "title": window.title,
      "value": field.stringValue, "edits": edits, "clicks": clicks,
      "replacements": replacements]
  }
}

final class FileDialogFixture: NSObject, NSApplicationDelegate {
  let root: URL
  let parents: [ParentControls]
  var currentPanel: NSSavePanel?
  var panelKind: String?
  var generation = 0
  var completionSource = "native"
  var results: [[String: Any]] = []

  init(root: URL) {
    self.root = root
    parents = [ParentControls(label: "Parent", offset: 0),
      ParentControls(label: "Sibling", offset: 500)]
    super.init()
  }

  // Only fixture-owned NSWindows are declared. This includes AppKit child
  // windows/sheets when AppKit exposes them; an unrelated process is never
  // accepted merely because it appeared above this panel.
  func windows() -> [[String: Any]] {
    var seen = Set<ObjectIdentifier>()
    var rows: [[String: Any]] = []
    func visit(_ window: NSWindow) {
      guard seen.insert(ObjectIdentifier(window)).inserted else { return }
      if window.windowNumber > 0 {
        rows.append([
          "windowId": window.windowNumber, "title": window.title,
          "kind": String(describing: type(of: window)),
          "visible": window.isVisible, "key": window.isKeyWindow,
          "parentWindowId": window.parent?.windowNumber ?? 0,
          "sheetParentWindowId": window.sheetParent?.windowNumber ?? 0,
          "attachedSheetWindowId": window.attachedSheet?.windowNumber ?? 0])
      }
      if let sheet = window.attachedSheet { visit(sheet) }
      for child in window.childWindows ?? [] { visit(child) }
    }
    for window in NSApp.windows { visit(window) }
    for parent in parents { visit(parent.window) }
    if let panel = currentPanel { visit(panel) }
    return rows
  }

  func isInsideFixture(_ url: URL) -> Bool {
    let candidate = url.standardizedFileURL.path
    return candidate == root.path || candidate.hasPrefix(root.path + "/")
  }

  func state() -> [String: Any] {
    var state: [String: Any] = [
      "pid": ProcessInfo.processInfo.processIdentifier, "active": NSApp.isActive,
      "generation": generation, "parents": parents.map { $0.state() },
      "windows": windows(), "results": results]
    if let panel = currentPanel {
      state["panel"] = [
        "kind": panelKind ?? "unknown", "generation": generation,
        "windowId": panel.windowNumber,
        "parentWindowId": panel.sheetParent?.windowNumber ?? 0,
        "visible": panel.isVisible, "prompt": panel.prompt ?? "",
        "directory": panel.directoryURL.flatMap { isInsideFixture($0) ? $0.path : nil } ?? ""]
    } else {
      state["panel"] = NSNull()
    }
    return state
  }

  func open(_ kind: String) throws {
    guard currentPanel == nil else {
      throw NSError(domain: "SynaraFileDialogFixture", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "A fixture panel is already open."])
    }
    let panel: NSSavePanel
    if kind == "save-sheet" {
      panel = NSSavePanel()
      panel.nameFieldStringValue = "saved selection café.txt"
      panel.prompt = "Fixture Save"
      panel.canCreateDirectories = false
    } else {
      let openPanel = NSOpenPanel()
      openPanel.canChooseFiles = true
      openPanel.canChooseDirectories = false
      openPanel.allowsMultipleSelection = false
      openPanel.resolvesAliases = false
      openPanel.prompt = "Fixture Open"
      panel = openPanel
    }
    generation += 1
    let openedGeneration = generation
    panel.title = "Synara File Dialog \(ProcessInfo.processInfo.processIdentifier) \(generation)"
    panel.message = "Owned regression fixture; choose only its temporary test file."
    panel.directoryURL = root.appendingPathComponent("Start here", isDirectory: true)
    panel.animationBehavior = .none
    currentPanel = panel
    panelKind = kind
    completionSource = "native"
    let completed: (NSApplication.ModalResponse) -> Void = { [weak self, weak panel] response in
      guard let self = self, let panel = panel else { return }
      let urls: [URL]
      if response == .OK {
        urls = (panel as? NSOpenPanel)?.urls ?? panel.url.map { [$0] } ?? []
      } else {
        urls = []
      }
      // The callback is independent evidence. Never open the chosen file and
      // never disclose an out-of-fixture URL should a human change the panel.
      let inside = urls.allSatisfy { self.isInsideFixture($0) }
      let result: [String: Any] = [
        "generation": openedGeneration, "kind": kind,
        "response": response == .OK ? "ok" : "cancel",
        "rawResponse": response.rawValue, "source": self.completionSource,
        "selectedPaths": inside ? urls.map { $0.standardizedFileURL.path } : [],
        "rejectedOutsideFixture": !inside]
      self.results.append(result)
      self.results = Array(self.results.suffix(16))
      self.currentPanel = nil
      self.panelKind = nil
      panel.orderOut(nil)
      emit(["event": "panel-result", "pid": ProcessInfo.processInfo.processIdentifier,
        "result": result])
    }
    if kind == "open-standalone" {
      panel.begin(completionHandler: completed)
    } else {
      panel.beginSheetModal(for: parents[0].window, completionHandler: completed)
    }
  }

  func handle(_ message: [String: Any]) {
    let id = message["id"] ?? NSNull()
    guard let command = message["command"] as? String else {
      emit(["id": id, "error": "Missing command."])
      return
    }
    do {
      switch command {
      case "state": break
      case "open-sheet", "open-standalone", "save-sheet": try open(command)
      case "replace-parent-field":
        guard currentPanel == nil else {
          throw NSError(domain: "SynaraFileDialogFixture", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "Cannot replace a field behind an open panel."])
        }
        parents[0].replaceField()
      case "close-panel":
        completionSource = "fixture-cleanup"
        currentPanel?.cancel(nil)
      case "quit":
        completionSource = "fixture-cleanup"
        currentPanel?.cancel(nil)
        emit(["id": id, "quitting": true, "pid": ProcessInfo.processInfo.processIdentifier])
        NSApp.terminate(nil)
        return
      default:
        throw NSError(domain: "SynaraFileDialogFixture", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Unknown command: \(command)"])
      }
      emit(["id": id, "state": state()])
    } catch {
      emit(["id": id, "pid": ProcessInfo.processInfo.processIdentifier,
        "error": String(describing: error)])
    }
  }
}

guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else {
  fatalError("Usage: native-file-dialog-fixture <absolute owned fixture directory>")
}
let fixtureRoot = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL
var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: fixtureRoot.path, isDirectory: &isDirectory),
  isDirectory.boolValue,
  FileManager.default.fileExists(atPath: fixtureRoot.appendingPathComponent(".synara-file-dialog-fixture").path)
else { fatalError("The explicit directory must carry the runner's fixture marker.") }

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = FileDialogFixture(root: fixtureRoot)
app.delegate = fixture
app.finishLaunching()
emit(["event": "ready", "pid": ProcessInfo.processInfo.processIdentifier, "state": fixture.state()])
DispatchQueue.global().async {
  while let line = readLine() {
    guard line.utf8.count <= 16_384, let data = line.data(using: .utf8),
      let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      emit(["error": "Expected a bounded JSON command."])
      continue
    }
    DispatchQueue.main.async { fixture.handle(message) }
  }
  DispatchQueue.main.async {
    fixture.completionSource = "fixture-cleanup"
    fixture.currentPanel?.cancel(nil)
    app.terminate(nil)
  }
}
app.run()
