// Styrby home-screen widget bundle (Cluster C1).
//
// The @main entry point for the WidgetKit extension. Exposes the single
// session-status widget; additional widgets (e.g. a cost summary) would be
// added to `body` here.

import WidgetKit
import SwiftUI

@main
struct StyrbyWidgetBundle: WidgetBundle {
    var body: some Widget {
        StyrbyWidget()
    }
}
