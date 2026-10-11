#if DEBUG
import SwiftUI
import WuuCore

/// Disposable real-host fixture, separate from saved accounts and navigation.
enum NativeHistoryFixture {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--native-history-fixture") }
    static var automated: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--native-history-demo") }
    static var directory: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    @MainActor static func connect(_ model: AppModel) async throws {
        let data = try Data(contentsOf: directory.appendingPathComponent("native-history-fixture.json"))
        let fixture = try JSONDecoder().decode(JSONValue.self, from: data)
        let account = try JSONDecoder().decode(AccountSession.self, from: data)
        // Local synthetic hosts only; this entry never imports a real user's account.
        guard let url = URL(string: account.server), ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let host = fixture["host"].string, let thread = fixture["history_demo_thread"].string, !thread.isEmpty else {
            throw NativeError.invalid("无效的本地验收配置")
        }
        model.account = account
        model.host = AccountDevice(pub: host, name: "本地验收电脑", role: "host", online: true)
        model.activeID = thread
        model.refreshing = true
        await model.connect()
        try await model.measureHistoryFixture()
    }
    static func record(_ stage: String, _ values: JSONValue = [:]) {
        let entry: JSONValue = ["stage": .string(stage), "time": .number(Date().timeIntervalSince1970), "values": values]
        do {
            let file = directory.appendingPathComponent("history-demo.jsonl")
            if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: JSONEncoder().encode(entry) + Data([10]))
        } catch { print("History fixture log: \(error)") }
    }
    @MainActor static func demonstrate(model: AppModel, scroll: TimelineScrollState,
        scrollTo: (String) -> Void, inspect: (ConversationRow?, Bool) -> Void, loadOlder: () -> Void) async throws {
        try await Task.sleep(for: .seconds(3))
        record("ready", ["turns": .number(Double(model.live?.turns.count ?? 0))])
        let rows = model.conversationRows
        guard let first = rows.first else { throw NativeError.invalid("验收会话为空") }
        scrollTo(rows[max(0, rows.count - 12)].id)
        try await Task.sleep(for: .seconds(2))
        scrollTo(first.id)
        try await Task.sleep(for: .seconds(2))
        record("older-request", ["offset": .number(Double(scroll.scroll?.contentOffset.y ?? 0))])
        loadOlder()
        for _ in 0..<300 where model.loadingHistory { try await Task.sleep(for: .milliseconds(50)) }
        try await Task.sleep(for: .seconds(2))
        record("older-shown", ["turns": .number(Double(model.live?.turns.count ?? 0)), "offset": .number(Double(scroll.scroll?.contentOffset.y ?? 0))])
        guard let group = model.conversationRows.first(where: { $0.isProcessGroup && $0.messages.contains(where: \.deferred) }) else {
            throw NativeError.invalid("验收会话缺少延迟读取的过程")
        }
        scrollTo(group.id)
        try await Task.sleep(for: .seconds(2))
        inspect(group, false)
        record("process-opened")
        try await Task.sleep(for: .seconds(4))
        inspect(nil, false)
        try await Task.sleep(for: .seconds(1))
        inspect(group, true)
        record("tools-opened")
        try await Task.sleep(for: .seconds(4))
        inspect(nil, false)
        record("finished")
    }
}

struct NativeHistoryFixtureView: View {
    let model: AppModel
    var body: some View {
        NavigationStack {
            ConversationTimeline(model: model)
                .navigationTitle("历史加载验收").navigationBarTitleDisplayMode(.inline)
                .overlay { if model.live == nil { ProgressView("正在连接本地验收电脑…") } }
        }
        .task {
            do { try await NativeHistoryFixture.connect(model) }
            catch { model.error = error.localizedDescription; NativeHistoryFixture.record("error", .string(error.localizedDescription)) }
        }
        .modelErrorAlert(model)
    }
}
#endif
