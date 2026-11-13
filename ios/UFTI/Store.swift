// Transfer history (history.json) and the received files. Same item shape as server.js.
import Foundation

struct Item: Codable {
    var id: String
    var kind: String          // "file" or "text"
    var name: String?
    var size: Int64?
    var text: String?
    var from: String
    var fromId: String
    var ts: Int64
}

final class Store {
    static let maxItems = 500
    let dir: URL                       // Documents/received, visible in the Files app
    private let historyFile: URL
    private let lock = NSLock()
    private var items: [Item] = []
    private var saveWork: DispatchWorkItem?
    /// Called with a ready-made JSON message ({"type":"add",...} or {"type":"remove",...}).
    var emit: ((String) -> Void)?

    init(documents: URL, support: URL) {
        dir = documents.appendingPathComponent("received", isDirectory: true)
        historyFile = support.appendingPathComponent("history.json")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        load()
    }

    func fileURL(_ item: Item) -> URL { dir.appendingPathComponent("\(item.id)__\(item.name ?? "file")") }

    private func load() {
        if let d = try? Data(contentsOf: historyFile), let saved = try? JSONDecoder().decode([Item].self, from: d) {
            // Drop file entries whose file was removed outside the app.
            items = saved.filter { $0.kind != "file" || FileManager.default.fileExists(atPath: fileURL($0).path) }
            return
        }
        // First run: rebuild the list from files already on disk.
        for f in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
            guard let r = f.range(of: "__"), f.distance(from: f.startIndex, to: r.lowerBound) == 8 else { continue }
            let attrs = try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(f).path)
            let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
            let mod = (attrs?[.modificationDate] as? Date) ?? Date()
            items.append(Item(id: String(f[..<r.lowerBound]), kind: "file", name: String(f[r.upperBound...]), size: size,
                              text: nil, from: "earlier", fromId: "", ts: Int64(mod.timeIntervalSince1970 * 1000)))
        }
        items.sort { $0.ts < $1.ts }
    }

    private func scheduleSave() { // caller holds the lock
        saveWork?.cancel()
        let snapshot = items
        let w = DispatchWorkItem { [historyFile] in
            if let d = try? JSONEncoder().encode(snapshot) { try? d.write(to: historyFile, options: .atomic) }
        }
        saveWork = w
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2, execute: w)
    }

    func all() -> [Item] { lock.lock(); defer { lock.unlock() }; return items }
    func find(_ id: String) -> Item? { lock.lock(); defer { lock.unlock() }; return items.first { $0.id == id } }

    func add(_ item: Item) {
        lock.lock()
        items.append(item)
        var dropped: [String] = []
        while items.count > Store.maxItems { dropped.append(items[0].id); removeLocked(items[0].id, deleteFile: true) }
        scheduleSave()
        lock.unlock()
        for id in dropped { emit?(#"{"type":"remove","id":"\#(id)"}"#) }
        if let d = try? JSONEncoder().encode(item), let s = String(data: d, encoding: .utf8) { emit?(#"{"type":"add","item":\#(s)}"#) }
    }

    @discardableResult
    func remove(_ id: String, deleteFile: Bool) -> Bool {
        lock.lock()
        let ok = removeLocked(id, deleteFile: deleteFile)
        if ok { scheduleSave() }
        lock.unlock()
        if ok { emit?(#"{"type":"remove","id":"\#(id)"}"#) }
        return ok
    }

    @discardableResult
    private func removeLocked(_ id: String, deleteFile: Bool) -> Bool {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return false }
        let item = items.remove(at: idx)
        if item.kind == "file" && deleteFile { try? FileManager.default.removeItem(at: fileURL(item)) }
        return true
    }
}
