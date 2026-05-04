//
//  NotificationManager.swift
//  CardioTrace
//
//  Manages the persistent "recording" notification shown on the lock screen
//  and notification centre while the app records in the background.
//  The notification is replaced in-place (same identifier) so it acts as a
//  live-updating banner without requiring Live Activities.
//

import Foundation
import UserNotifications

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {

    static let shared = NotificationManager()

    private let recordingID = "cardiotrace.recording.live"

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: – Permission

    func requestPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge]) { granted, error in
                if let error { print("CardioTrace notification permission error: \(error)") }
                print("CardioTrace notifications: \(granted ? "granted ✓" : "denied")")
            }
    }

    // MARK: – Post / update (call from any thread)

    func postUpdate(hr: Int, rmssd: Double, sri: Int, duration: Double) {
        let content = UNMutableNotificationContent()
        content.title = "● CardioTrace  —  Recording Active"
        content.body  = buildBody(hr: hr, rmssd: rmssd, sri: sri, duration: duration)
        content.sound = nil
        content.interruptionLevel = .passive   // quiet delivery, no popup sound

        // trigger = nil → deliver immediately; same identifier replaces the previous
        let request = UNNotificationRequest(
            identifier: recordingID,
            content:    content,
            trigger:    nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    func remove() {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [recordingID])
        UNUserNotificationCenter.current()
            .removeDeliveredNotifications(withIdentifiers: [recordingID])
    }

    // MARK: – UNUserNotificationCenterDelegate
    // Suppress the in-app banner for our own recording notification while
    // the app is foregrounded — it still lives in the notification centre / lock screen.

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if notification.request.identifier == recordingID {
            completionHandler([])          // silent while in foreground
        } else {
            completionHandler([.banner, .sound])
        }
    }

    // MARK: – Private helpers

    private func buildBody(hr: Int, rmssd: Double, sri: Int, duration: Double) -> String {
        let mins = Int(duration) / 60
        let secs = Int(duration) % 60
        var parts = [String(format: "⏱ %02d:%02d", mins, secs)]
        if hr    > 0 { parts.append("❤️ \(hr) BPM") }
        if rmssd > 0 { parts.append("📊 \(String(format: "%.1f", rmssd)) ms RMSSD") }
        if sri   > 0 {
            let icon = sri >= 75 ? "🌟" : sri >= 55 ? "✅" : sri >= 35 ? "⚠️" : "⚡"
            parts.append("\(icon) SRI \(sri)")
        }
        return parts.joined(separator: "   ")
    }
}
