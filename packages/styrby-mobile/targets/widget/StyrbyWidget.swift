// Styrby session-status home-screen widget (Cluster C1).
//
// Reads the most-recent session status from the shared App Group UserDefaults
// (written by the RN app via lib/widget-bridge.ts) and renders it. The widget
// runs no JavaScript; all data crosses the boundary as the string keys defined
// in lib/widget-payload.ts.

import WidgetKit
import SwiftUI

/// App Group suite shared with the main app. Must match WIDGET_APP_GROUP in
/// lib/widget-bridge.ts and app.json's ios.entitlements.
private let appGroup = "group.com.steelmotion.styrby"

/// One timeline entry: a snapshot of the session keys at read time.
struct SessionEntry: TimelineEntry {
    let date: Date
    let hasSession: Bool
    let agent: String
    let statusLabel: String
    let isActive: Bool
    let title: String
    let cost: String
}

/// Reads the App Group keys written by the RN app into a SessionEntry.
private func readSessionEntry() -> SessionEntry {
    let defaults = UserDefaults(suiteName: appGroup)
    return SessionEntry(
        date: Date(),
        hasSession: defaults?.string(forKey: "hasSession") == "true",
        agent: defaults?.string(forKey: "agent") ?? "",
        statusLabel: defaults?.string(forKey: "statusLabel") ?? "",
        isActive: defaults?.string(forKey: "isActive") == "true",
        title: defaults?.string(forKey: "title") ?? "",
        cost: defaults?.string(forKey: "cost") ?? ""
    )
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SessionEntry {
        SessionEntry(
            date: Date(), hasSession: true, agent: "claude",
            statusLabel: "Running", isActive: true,
            title: "Refactor auth flow", cost: "$0.0400"
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (SessionEntry) -> Void) {
        completion(readSessionEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SessionEntry>) -> Void) {
        // The RN app force-reloads timelines on session changes + foreground;
        // this periodic refresh is a safety net so relative time does not go
        // stale if the app is never reopened.
        let entry = readSessionEntry()
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

struct StyrbyWidgetEntryView: View {
    var entry: SessionEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if entry.hasSession {
                HStack(spacing: 6) {
                    Circle()
                        .fill(entry.isActive ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)
                    Text(entry.agent.uppercased())
                        .font(.caption2).bold()
                        .foregroundColor(.orange)
                    Spacer()
                    Text(entry.statusLabel)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                Text(entry.title)
                    .font(.footnote).bold()
                    .lineLimit(2)
                    .foregroundColor(.primary)
                Spacer()
                Text(entry.cost)
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Text("STYRBY")
                    .font(.caption2).bold()
                    .foregroundColor(.orange)
                Spacer()
                Text("No active session")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            Color(red: 0.04, green: 0.04, blue: 0.04)
        }
    }
}

struct StyrbyWidget: Widget {
    let kind = "StyrbyWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            StyrbyWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Session Status")
        .description("Your most recent Styrby coding session at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
