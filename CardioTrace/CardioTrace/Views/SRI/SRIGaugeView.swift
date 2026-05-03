import SwiftUI
import Combine

// MARK: – SRI Gauge (Canvas, mirrors the JS drawSRIGauge function)
struct SRIGaugeView: View {
    let score: Int
    @State private var pulsePhase: Double = 0

    private let timer = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            Canvas { ctx, size in
                drawGauge(ctx: ctx, size: size, score: score, pulse: pulsePhase)
            }
            .aspectRatio(1, contentMode: .fit)
            .onReceive(timer) { _ in
                withAnimation(.linear(duration: 0.05)) {
                    pulsePhase = pulsePhase + 0.05
                }
            }

            VStack(spacing: 2) {
                Text(score > 0 ? "\(score)" : "--")
                    .font(.system(size: 52, weight: .black, design: .rounded))
                    .foregroundStyle(scoreGradient)
                    .contentTransition(.numericText())
                    .animation(.spring(duration: 0.6), value: score)

                Text("SRI SCORE")
                    .font(.system(size: 11, weight: .bold))
                    .kerning(1.5)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var scoreGradient: LinearGradient {
        LinearGradient(
            colors: colorsForScore(score),
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }

    private func colorsForScore(_ s: Int) -> [Color] {
        switch s {
        case 75...: return [Color(hex: "#10b981"), Color(hex: "#22d3ee")]
        case 55..<75: return [Color(hex: "#22d3ee"), Color(hex: "#6366f1")]
        case 35..<55: return [Color(hex: "#f59e0b"), Color(hex: "#fb923c")]
        default:     return [Color(hex: "#ef4444"), Color(hex: "#f97316")]
        }
    }

    // MARK: – Drawing

    private func drawGauge(ctx: GraphicsContext, size: CGSize, score: Int, pulse: Double) {
        let center    = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius    = min(size.width, size.height) / 2.8
        let lineWidth = max(size.width / 15, 8)

        let startAngle = Angle.degrees(135)
        let endAngle   = Angle.degrees(45)   // clockwise via 270°

        // ── Background track
        drawArc(ctx: ctx, center: center, radius: radius,
                lineWidth: lineWidth, from: startAngle, to: endAngle,
                color: Color.white.opacity(0.08))

        // ── Coloured band segments (dim)
        let bands: [(from: Double, to: Double, hex: String)] = [
            (0, 35,  "#ef4444"),
            (35, 55, "#f59e0b"),
            (55, 75, "#22d3ee"),
            (75, 100,"#10b981")
        ]
        for band in bands {
            let a1 = Angle.degrees(135 + (band.from / 100) * 270)
            let a2 = Angle.degrees(135 + (band.to   / 100) * 270)
            drawArc(ctx: ctx, center: center, radius: radius,
                    lineWidth: lineWidth, from: a1, to: a2,
                    color: Color(hex: band.hex).opacity(0.20))
        }

        // ── Score arc
        if score > 0 {
            let scoreAngle = Angle.degrees(135 + (Double(score) / 100) * 270)
            let c1 = colorsForScore(score)[0]
            let c2 = colorsForScore(score).last ?? c1

            // Glow
            drawArc(ctx: ctx, center: center, radius: radius,
                    lineWidth: lineWidth + 4, from: startAngle, to: scoreAngle,
                    color: c1.opacity(0.3))

            // Main
            var innerCtx = ctx
            innerCtx.addFilter(.shadow(color: c1.opacity(0.7), radius: 8))
            drawArc(ctx: innerCtx, center: center, radius: radius,
                    lineWidth: lineWidth, from: startAngle, to: scoreAngle,
                    color: c1)
            _ = c2 // used in gradient when SwiftUI Charts draws — here use solid

            // Tip dot
            let tipAngle = CGFloat(scoreAngle.radians)
            let tipPt = CGPoint(
                x: center.x + radius * cos(tipAngle),
                y: center.y + radius * sin(tipAngle)
            )
            var dot = Path()
            dot.addArc(center: tipPt, radius: 7, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
            ctx.fill(dot, with: .color(.white))
        }

        // ── Tick marks
        for i in stride(from: 0, through: 100, by: 10) {
            let a = CGFloat(Angle.degrees(135 + (Double(i) / 100) * 270).radians)
            let isMajor = i % 25 == 0
            let inner = radius - lineWidth / 2 - (isMajor ? 10 : 5)
            let outer = radius - lineWidth / 2 + 2
            var tick = Path()
            tick.move(to: CGPoint(x: center.x + inner * cos(a), y: center.y + inner * sin(a)))
            tick.addLine(to: CGPoint(x: center.x + outer * cos(a), y: center.y + outer * sin(a)))
            ctx.stroke(tick, with: .color(.white.opacity(isMajor ? 0.35 : 0.15)),
                       lineWidth: isMajor ? 2 : 1)
        }

        // ── Excellent pulse ring
        if score >= 75 {
            let alpha = 0.25 + 0.2 * sin(pulse * 2)
            var ring = Path()
            ring.addArc(center: center, radius: radius + lineWidth / 2 + 6,
                        startAngle: .zero, endAngle: .degrees(360), clockwise: false)
            ctx.stroke(ring, with: .color(Color(hex: "#10b981").opacity(alpha)), lineWidth: 2)
        }
    }

    private func drawArc(ctx: GraphicsContext, center: CGPoint, radius: CGFloat,
                         lineWidth: CGFloat, from: Angle, to: Angle, color: Color) {
        var path = Path()
        path.addArc(center: center, radius: radius,
                    startAngle: from, endAngle: to, clockwise: false)
        ctx.stroke(path, with: .color(color),
                   style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
    }
}

// MARK: – SRI Status badge
struct SRIStatusView: View {
    let score: Int

    private var info: (icon: String, label: String, color: Color) {
        switch score {
        case 75...: return ("🌟", "Excellent Recovery", Color(hex: "#10b981"))
        case 55..<75: return ("✅", "Good Recovery",      Color(hex: "#22d3ee"))
        case 35..<55: return ("⚠️", "Fair Recovery",      Color(hex: "#f59e0b"))
        case 1..<35:  return ("⚡", "Poor Recovery",      Color(hex: "#ef4444"))
        default:      return ("⏱️", "Need 50 RR intervals", .secondary)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(info.icon).font(.title2)
            Text(info.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(info.color)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(info.color.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(info.color.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: – Color hex extension
extension Color {
    init(hex: String) {
        var h = hex.trimmingCharacters(in: .init(charactersIn: "#"))
        if h.count == 6 { h = "FF" + h }
        let val = UInt64(h, radix: 16) ?? 0
        self.init(
            red:   Double((val >> 16) & 0xFF) / 255,
            green: Double((val >>  8) & 0xFF) / 255,
            blue:  Double( val        & 0xFF) / 255,
            opacity: Double((val >> 24) & 0xFF) / 255
        )
    }
}
