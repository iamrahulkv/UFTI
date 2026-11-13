// QR scanner: point the camera at the QR code shown by UFTI on a PC or another phone.
import SwiftUI
import AVFoundation

struct ScannerScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            QRScannerView { text in
                guard let url = RemoteLink.parse(text) else { return false }
                model.connect(pairing: url)
                model.scanning = false
                return true
            }
            .ignoresSafeArea()
            HStack {
                Button("Cancel") { model.scanning = false }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.ultraThinMaterial).clipShape(Capsule())
                Spacer()
            }
            .padding()
            VStack {
                Spacer()
                Text("Scan the QR code that UFTI shows on the PC or on another phone.")
                    .multilineTextAlignment(.center)
                    .padding(12)
                    .background(.ultraThinMaterial).cornerRadius(12)
                    .padding()
            }
        }
        .background(Color.black.ignoresSafeArea())
    }
}

/// `onCode` returns true when it accepted the code; false keeps the camera scanning.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Bool

    func makeUIViewController(context: Context) -> ScannerController {
        let vc = ScannerController()
        vc.onCode = onCode
        return vc
    }
    func updateUIViewController(_ vc: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Bool)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var locked = false
    private let note = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        note.textColor = .white
        note.textAlignment = .center
        note.numberOfLines = 0
        note.font = .preferredFont(forTextStyle: .body)
        note.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(note)
        NSLayoutConstraint.activate([
            note.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            note.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            note.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async {
                    if ok { self.configure() } else { self.note.text = "Camera access is off. Turn it on in Settings, UFTI, Camera." }
                }
            }
        default:
            note.text = "Camera access is off. Turn it on in Settings, UFTI, Camera."
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            note.text = "No camera available."
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]   // after addOutput, or the type is not available yet
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [session] in if session.isRunning { session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !locked, let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = obj.stringValue else { return }
        locked = true
        if onCode?(text) == true { return }
        // Not a UFTI pairing code: say so, then keep scanning.
        note.text = "That isn't a UFTI QR code."
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            self?.note.text = nil
            self?.locked = false
        }
    }
}
