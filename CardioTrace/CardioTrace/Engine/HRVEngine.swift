import Foundation

/// Pure-function HRV calculation engine.
/// All methods are thread-safe and may be called from any queue.
final class HRVEngine {

    static let shared = HRVEngine()

    // Physiological limits – mirrors engine.js
    static let minRR:   Double = 250   // 200 BPM max
    static let maxRR:   Double = 2000  // 30 BPM min
    static let maxDiff: Double = 300   // max consecutive RR change

    // MARK: – Validation

    func isValidRR(_ rr: Double, previous: Double?) -> Bool {
        guard rr >= Self.minRR, rr <= Self.maxRR else { return false }
        if let p = previous, abs(rr - p) > Self.maxDiff { return false }
        return true
    }

    func cleanRRData(rr: [Double], times: [Double]) -> (rr: [Double], times: [Double]) {
        var cleanRR: [Double] = []
        var cleanT:  [Double] = []
        for i in 0..<rr.count {
            let v = rr[i]
            guard v >= Self.minRR, v <= Self.maxRR else { continue }
            if let last = cleanRR.last, abs(v - last) > Self.maxDiff { continue }
            guard i < times.count, times[i].isFinite else { continue }
            cleanRR.append(v)
            cleanT.append(times[i])
        }
        return (cleanRR, cleanT)
    }

    // MARK: – Time-domain metrics

    func calculateRMSSD(_ rr: [Double]) -> Double {
        guard rr.count > 1 else { return 0 }
        var sumSq = 0.0
        for i in 1..<rr.count { let d = rr[i] - rr[i-1]; sumSq += d * d }
        return sqrt(sumSq / Double(rr.count - 1))
    }

    func calculateSDNN(_ rr: [Double]) -> Double {
        guard rr.count > 1 else { return 0 }
        let mean = rr.reduce(0, +) / Double(rr.count)
        let variance = rr.map { pow($0 - mean, 2) }.reduce(0, +) / Double(rr.count)
        return sqrt(variance)
    }

    func calculatePNN50(_ rr: [Double]) -> Double {
        guard rr.count > 1 else { return 0 }
        var count = 0
        for i in 1..<rr.count { if abs(rr[i] - rr[i-1]) > 50 { count += 1 } }
        return Double(count) / Double(rr.count - 1) * 100
    }

    func calculateMeanRR(_ rr: [Double]) -> Double {
        guard !rr.isEmpty else { return 0 }
        return rr.reduce(0, +) / Double(rr.count)
    }

    // MARK: – Frequency domain (Lomb–Scargle)

    func calculatePSD(rr: [Double], times: [Double]) -> PSDResult? {
        guard rr.count >= 50 else { return nil }

        let mean = rr.reduce(0, +) / Double(rr.count)
        let centered = rr.map { $0 - mean }

        // Frequency grid – matches JS (0.003–0.4 Hz, step 0.0005)
        var frequencies: [Double] = []
        var f = 0.003
        while f <= 0.4 + 1e-9 { frequencies.append(f); f += 0.0005 }

        let raw      = lombScargle(times: times, values: centered, frequencies: frequencies)
        let smoothed = smoothSpectrum(raw, windowSize: 5)

        let vlf   = integrateBand(freq: frequencies, psd: smoothed, fMin: 0.003, fMax: 0.04)
        let lf    = integrateBand(freq: frequencies, psd: smoothed, fMin: 0.04,  fMax: 0.15)
        let hf    = integrateBand(freq: frequencies, psd: smoothed, fMin: 0.15,  fMax: 0.40)
        let total = integrateBand(freq: frequencies, psd: smoothed, fMin: 0.003, fMax: 0.40)
        let lfhf  = hf > 0 && lf.isFinite && hf.isFinite ? lf / hf : 0

        return PSDResult(
            frequencies: frequencies,
            power:       smoothed,
            lfPower:     lf,
            hfPower:     hf,
            vlfPower:    vlf,
            lfhfRatio:   lfhf,
            totalPower:  total
        )
    }

    // Trapezoidal band-power integral – identical to JS integrateBandPower
    func integrateBand(freq: [Double], psd: [Double], fMin: Double, fMax: Double) -> Double {
        guard freq.count == psd.count, freq.count >= 2,
              fMax > fMin, fMax.isFinite, fMin.isFinite else { return 0 }
        var area = 0.0
        for i in 0..<(freq.count - 1) {
            let f0 = freq[i], f1 = freq[i+1]
            let p0 = psd[i],  p1 = psd[i+1]
            guard f1 > f0 else { continue }
            let left  = max(f0, fMin)
            let right = min(f1, fMax)
            guard right > left else { continue }
            let tL = (left  - f0) / (f1 - f0)
            let tR = (right - f0) / (f1 - f0)
            let pL = p0 + tL * (p1 - p0)
            let pR = p0 + tR * (p1 - p0)
            area += 0.5 * (pL + pR) * (right - left)
        }
        return max(0, area)
    }

    // MARK: – SRI

    func calculateSRI(rr: [Double], times: [Double],
                      psdResult: PSDResult? = nil) -> (score: Int, components: SRIComponents, peakHR: Double)? {
        guard rr.count >= 50 else { return nil }

        // Component 1 – RMSSD (35%)
        let rmssd = calculateRMSSD(rr)
        let rmssdNorm = min(100, max(0, (rmssd / 100) * 100))

        // Component 2 – LF/HF (35%)
        let psd = psdResult ?? calculatePSD(rr: rr, times: times)
        let lfhf = psd?.lfhfRatio ?? 0
        let lfhfNorm: Double
        switch lfhf {
        case ...0.5:          lfhfNorm = 100
        case 0.5...2:         lfhfNorm = 100 - ((lfhf - 0.5) / 1.5) * 30
        case 2...3:           lfhfNorm = 70  - ((lfhf - 2.0) / 1.0) * 30
        default:              lfhfNorm = max(0, 40 - ((lfhf - 3.0) / 2.0) * 40)
        }

        // Component 3 – HR Recovery (30%)
        let hrVals  = rr.map { 60000 / $0 }
        let peakHR  = hrVals.max() ?? 0
        let avgHR   = hrVals.reduce(0, +) / Double(hrVals.count)
        let minHR   = hrVals.min() ?? 0
        let r1      = peakHR > 0 ? ((peakHR - avgHR) / peakHR) * 100 : 0
        let r2      = peakHR > 0 ? ((peakHR - minHR) / peakHR) * 100 : 0
        let recovery = max(r1, r2)
        let recovNorm = min(100, max(0, recovery))

        let score = Int((rmssdNorm * 0.35) + (lfhfNorm * 0.35) + (recovNorm * 0.30))

        return (
            score,
            SRIComponents(rmssd: rmssd, lfhf: lfhf, hrRecovery: recovery),
            peakHR
        )
    }

    // MARK: – Rolling RMSSD

    func rollingRMSSD(rr: [Double], times: [Double],
                      windowSec: Double = 60) -> [(time: Double, value: Double)] {
        guard rr.count >= 2 else { return [] }
        var result: [(time: Double, value: Double)] = []
        for i in 0..<rr.count {
            let t = times[i]
            guard t >= 30 else { continue }
            let wStart = t - windowSec
            var wRR: [Double] = []
            for j in 0...i { if times[j] >= wStart { wRR.append(rr[j]) } }
            if wRR.count >= 2 {
                result.append((t, calculateRMSSD(wRR)))
            }
        }
        return result
    }

    // MARK: – Private helpers

    private func lombScargle(times: [Double], values: [Double],
                             frequencies: [Double]) -> [Double] {
        let n = times.count
        guard n >= 2 else { return frequencies.map { _ in 0.0 } }

        let mean = values.reduce(0, +) / Double(n)
        let y = values.map { $0 - mean }
        var rawPower = [Double](repeating: 0, count: frequencies.count)

        for (fi, freq) in frequencies.enumerated() {
            let omega = 2 * Double.pi * freq

            var ss2 = 0.0, sc2 = 0.0
            for t in times { ss2 += sin(2 * omega * t); sc2 += cos(2 * omega * t) }
            let tau = atan2(ss2, sc2) / (2 * omega)

            var cosN = 0.0, cosD = 0.0, sinN = 0.0, sinD = 0.0
            for i in 0..<n {
                let ct = cos(omega * (times[i] - tau))
                let st = sin(omega * (times[i] - tau))
                cosN += y[i] * ct; cosD += ct * ct
                sinN += y[i] * st; sinD += st * st
            }
            let c = cosD > 0 ? (cosN * cosN) / cosD : 0
            let s = sinD > 0 ? (sinN * sinN) / sinD : 0
            rawPower[fi] = 0.5 * (c + s)
        }

        // Normalise so ∫PSD·df == variance (ms²)
        let variance = y.map { $0 * $0 }.reduce(0, +) / Double(n)
        var integral = 0.0
        for i in 1..<frequencies.count {
            let df = frequencies[i] - frequencies[i-1]
            if df > 0 { integral += 0.5 * (rawPower[i] + rawPower[i-1]) * df }
        }
        let norm = integral > 0 ? variance / integral : 0
        return rawPower.map { $0 * norm }
    }

    private func smoothSpectrum(_ power: [Double], windowSize: Int) -> [Double] {
        let half = windowSize / 2
        return power.enumerated().map { (i, _) in
            let lo = max(0, i - half)
            let hi = min(power.count - 1, i + half)
            let slice = power[lo...hi]
            return slice.reduce(0, +) / Double(slice.count)
        }
    }
}
