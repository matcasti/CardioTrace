import Foundation
import UserNotifications
import UIKit

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {

    static let shared = NotificationManager()
    private let recordingID = "cardiotrace.recording.live"
    private let ecgImageURL: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("ct_ecg_strip.png")

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: – Permission
    func requestPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge]) { _, _ in }
    }

    // MARK: – Post / update
    func postUpdate(hr: Int, rmssd: Double, sri: Int, duration: Double) {
        let content = UNMutableNotificationContent()
        content.title = "● CardioTrace  —  Recording"
        content.body  = buildBody(hr: hr, rmssd: rmssd, sri: sri, duration: duration)
        content.sound = nil
        content.interruptionLevel = .passive

        // Attach rendered ECG strip
        if let img  = generateECGImage(hr: hr),
           let data = img.pngData(),
           (try? data.write(to: ecgImageURL)) != nil,
           let att  = try? UNNotificationAttachment(
               identifier: "ecg_strip", url: ecgImageURL,
               options: [UNNotificationAttachmentOptionsThumbnailClippingRectKey:
                           CGRect(x: 0, y: 0, width: 1, height: 1) as AnyObject]) {
            content.attachments = [att]
        }

        let req = UNNotificationRequest(
            identifier: recordingID, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func remove() {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [recordingID])
        UNUserNotificationCenter.current()
            .removeDeliveredNotifications(withIdentifiers: [recordingID])
    }

    // MARK: – Delegate — suppress in-app banner for our own notification
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        handler(notification.request.identifier == recordingID ? [] : [.banner, .sound])
    }

    // MARK: – ECG strip generator
    /// Renders a 600 × 160 pt ECG strip whose beat rate matches `hr`.
    private func generateECGImage(hr: Int) -> UIImage? {
        let W: CGFloat = 600, H: CGFloat = 160
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: W, height: H))
        return renderer.image { ctx in
            let g = ctx.cgContext

            // ── Background ────────────────────────────────────────────────
            g.setFillColor(UIColor(red: 0.04, green: 0.07, blue: 0.13, alpha: 1).cgColor)
            g.fill(CGRect(x: 0, y: 0, width: W, height: H))

            // ── Grid ──────────────────────────────────────────────────────
            g.setStrokeColor(UIColor(white: 1, alpha: 0.05).cgColor)
            g.setLineWidth(0.5)
            for x in stride(from: CGFloat(0), to: W, by: 25) {
                g.move(to: CGPoint(x: x, y: 0)); g.addLine(to: CGPoint(x: x, y: H))
            }
            for y in stride(from: CGFloat(0), to: H, by: 25) {
                g.move(to: CGPoint(x: 0, y: y)); g.addLine(to: CGPoint(x: W, y: y))
            }
            g.strokePath()

            // ── Waveform ──────────────────────────────────────────────────
            let safeHR    = Double(max(40, min(200, hr > 0 ? hr : 72)))
            let beatSec   = 60.0 / safeHR                    // seconds per beat
            let showBeats = 3.2                               // beats visible
            let pxPerSec  = Double(W) / (beatSec * showBeats)
            let midY      = Double(H) / 2.0
            let amp       = Double(H) * 0.38

            let path = CGMutablePath()
            path.move(to: CGPoint(x: 0, y: midY))

            let beats = Int(showBeats) + 1
            for b in 0..<beats {
                let bx = Double(b) * beatSec * pxPerSec
                func px(_ frac: Double) -> Double { bx + frac * beatSec * pxPerSec }

                // Isoelectric baseline → P wave
                path.addLine(to: CGPoint(x: px(0.12), y: midY))
                path.addQuadCurve(
                    to:      CGPoint(x: px(0.22), y: midY),
                    control: CGPoint(x: px(0.17), y: midY - amp * 0.17))
                // PR segment
                path.addLine(to: CGPoint(x: px(0.28), y: midY))
                // Q
                path.addLine(to: CGPoint(x: px(0.31), y: midY + amp * 0.12))
                // R peak
                path.addLine(to: CGPoint(x: px(0.35), y: midY - amp))
                // S
                path.addLine(to: CGPoint(x: px(0.39), y: midY + amp * 0.08))
                // ST → T wave
                path.addLine(to: CGPoint(x: px(0.46), y: midY))
                path.addQuadCurve(
                    to:      CGPoint(x: px(0.63), y: midY),
                    control: CGPoint(x: px(0.545), y: midY - amp * 0.27))
                // TP flat
                path.addLine(to: CGPoint(x: px(1.0), y: midY))
            }
            path.addLine(to: CGPoint(x: Double(W), y: midY))

            // Glow
            g.addPath(path)
            g.setStrokeColor(UIColor(red: 0.13, green: 0.83, blue: 0.50, alpha: 0.22).cgColor)
            g.setLineWidth(7); g.setLineCap(.round); g.setLineJoin(.round)
            g.strokePath()

            // Main line
            g.addPath(path)
            g.setStrokeColor(UIColor(red: 0.13, green: 0.83, blue: 0.50, alpha: 1).cgColor)
            g.setLineWidth(1.8)
            g.strokePath()

            // ── HR badge (bottom-right) ────────────────────────────────
            let label = "\(max(40, min(200, hr > 0 ? hr : 72))) BPM" as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font:            UIFont.systemFont(ofSize: 18, weight: .bold),
                .foregroundColor: UIColor(red: 0.13, green: 0.83, blue: 0.50, alpha: 0.9)
            ]
            let size = label.size(withAttributes: attrs)
            label.draw(at: CGPoint(x: Double(W) - size.width - 10,
                                   y: Double(H) - size.height - 8),
                       withAttributes: attrs)
        }
    }

    // MARK: – Body text
    private func buildBody(hr: Int, rmssd: Double, sri: Int, duration: Double) -> String {
        let m = Int(duration) / 60, s = Int(duration) % 60
        var parts = [String(format: "⏱ %02d:%02d", m, s)]
        if hr    > 0 { parts.append("❤️ \(hr) BPM") }
        if rmssd > 0 { parts.append(String(format: "📊 %.1f ms RMSSD", rmssd)) }
        if sri   > 0 {
            let icon = sri >= 75 ? "🌟" : sri >= 55 ? "✅" : sri >= 35 ? "⚠️" : "⚡"
            parts.append("\(icon) SRI \(sri)")
        }
        return parts.joined(separator: "   ")
    }
}
