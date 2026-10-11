import SwiftUI
import WuuCore

/// Reads a folded item's body only while its inspector row is mounted.
struct DeferredHistoryContent: View {
    let model: AppModel
    let message: ChatMessage
    @State private var failure: String?
    @State private var retry = 0
    var body: some View {
        Group {
            if message.deferred {
                if let failure {
                    Button { self.failure = nil; retry += 1 } label: {
                        Label("读取失败，轻点重试", systemImage: "arrow.clockwise")
                    }.accessibilityHint(failure)
                } else {
                    ProgressView("正在读取详情…").font(.footnote)
                }
            }
        }
        .task(id: "\(message.contentRef):\(retry)") {
            guard message.deferred else { return }
            do {
                guard model.connected, !model.refreshing else { throw NativeError.invalid("请连接电脑后重试") }
                try await model.expand(message)
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
}
