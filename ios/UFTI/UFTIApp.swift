import SwiftUI

@main
struct UFTIApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView(model: model, server: model.server)
                .onChange(of: phase) { model.phaseChanged($0) }
        }
    }
}

/// Owns the server and the connection state. The iPhone can do two things at once:
///  - host: show its own QR code so other devices can connect to it (the server below), and
///  - client: scan another UFTI's QR code and use that one inside the app (`remoteBase` is set).
/// The server runs while the app is on screen; iOS suspends background apps, so transfers pause
/// when you leave the app, and the screen is kept awake while UFTI is open.
@MainActor
final class AppModel: ObservableObject {
    let server = UFTIServer()

    @Published var remoteBase: URL?     // the other device we are connected to, e.g. http://192.168.1.20:8787/
    @Published var remoteStart: URL?    // what the page loads first: the pairing link, then just the base
    @Published var viewID = UUID()      // changes to rebuild the page when switching between host and client
    @Published var lastRemote: URL?     // remembered, so "Reconnect" works without scanning again
    @Published var scanning = false
    @Published var busy: String?
    @Published var alert: String?

    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private let lastRemoteKey = "lastRemote"

    init() {
        server.start()
        if let s = UserDefaults.standard.string(forKey: lastRemoteKey) { lastRemote = URL(string: s) }
    }

    var pageURL: URL { remoteStart ?? URL(string: "http://localhost:\(UFTIServer.port)/")! }

    /// Connect to the device whose QR code was scanned. The code works once; it becomes a login cookie for this app.
    func connect(pairing url: URL) {
        var c = URLComponents()
        c.scheme = "http"; c.host = url.host; c.port = url.port; c.path = "/"
        guard let base = c.url else { return }
        remoteBase = base
        remoteStart = url
        lastRemote = base
        UserDefaults.standard.set(base.absoluteString, forKey: lastRemoteKey)
        viewID = UUID()
    }

    /// Open the last device again. Its login cookie is still stored, so no new scan is needed (if it was removed there, scan again).
    func reconnect() {
        guard let base = lastRemote else { return }
        remoteBase = base
        remoteStart = base
        viewID = UUID()
    }

    func disconnect() {
        remoteBase = nil
        remoteStart = nil
        viewID = UUID()
    }

    /// The pairing code is used up after the first load; a rebuilt page must open the plain address.
    func pairingConsumed() { remoteStart = remoteBase }

    func phaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            UIApplication.shared.isIdleTimerDisabled = true
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
            server.ensureRunning()
        case .background:
            UIApplication.shared.isIdleTimerDisabled = false
            // A little extra time so an upload or download already under way can finish.
            bgTask = UIApplication.shared.beginBackgroundTask { [weak self] in
                guard let self = self else { return }
                UIApplication.shared.endBackgroundTask(self.bgTask); self.bgTask = .invalid
            }
        default: break
        }
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var server: UFTIServer   // observed directly so the error screen appears and clears by itself

    var body: some View {
        VStack(spacing: 0) {
            TopBar(model: model)
            ZStack {
                if let err = server.error, model.remoteBase == nil {
                    VStack(spacing: 10) {
                        Text("UFTI can't start its server").font(.headline)
                        Text(err).font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
                        Button("Try again") { server.start() }
                    }.padding()
                } else {
                    PageView(model: model, start: model.pageURL, isClient: model.remoteBase != nil)
                        .id(model.viewID)
                }
                if let message = model.busy {
                    ZStack {
                        Color.black.opacity(0.35)
                        VStack(spacing: 10) { ProgressView(); Text(message).font(.footnote) }
                            .padding(20).background(.regularMaterial).cornerRadius(12)
                    }
                }
            }
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .fullScreenCover(isPresented: $model.scanning) { ScannerScreen(model: model) }
        .alert("UFTI", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.alert ?? "")
        }
    }
}

/// Shows which device the page belongs to, and the buttons to scan or disconnect.
struct TopBar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            if let base = model.remoteBase {
                Image(systemName: "link")
                Text("Connected to \(base.host ?? "")").lineLimit(1)
                Spacer()
                Button("Disconnect") { model.disconnect() }
            } else {
                Image(systemName: "iphone")
                Text("This iPhone").lineLimit(1)
                Spacer()
                if model.lastRemote != nil {
                    Button("Reconnect") { model.reconnect() }
                }
                Button {
                    model.scanning = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(.secondarySystemBackground))
    }
}
