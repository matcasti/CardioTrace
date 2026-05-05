import Foundation
import CoreBluetooth
import Combine

// MARK: – GATT UUIDs (matching engine.js)
extension CBUUID {
    static let hrService      = CBUUID(string: "180D")
    static let hrMeasurement  = CBUUID(string: "2A37")
    static let batteryService = CBUUID(string: "180F")
    static let batteryLevel   = CBUUID(string: "2A19")
    static let pmdService     = CBUUID(string: "FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8")
    static let pmdControl     = CBUUID(string: "FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8")
    static let pmdData        = CBUUID(string: "FB005C82-02E7-F387-1CAD-8ACD2D8DF0C8")
}

struct DiscoveredDevice: Identifiable {
    let id: UUID          // peripheral.identifier
    let name: String
    fileprivate let peripheral: CBPeripheral
}

enum ConnectionState: Equatable {
    case idle, scanning, connecting, calibrating, connected, failed(String)

    var displayLabel: String {
        switch self {
        case .idle:          return "Not Connected"
        case .scanning:      return "Scanning…"
        case .connecting:    return "Connecting…"
        case .calibrating:   return "Calibrating…"
        case .connected:     return "Connected"
        case .failed(let m): return "Failed: \(m)"
        }
    }
    var isConnected: Bool {
        if case .connected   = self { return true }
        if case .calibrating = self { return true }
        return false
    }
}

enum SignalQuality: String {
    case unknown, excellent, good, fair, poor
}

final class BluetoothManager: NSObject, ObservableObject {

    static let shared = BluetoothManager()

    @Published var state:         ConnectionState = .idle
    @Published var heartRate:     Int             = 0
    @Published var batteryLevel:  Int             = 0
    @Published var ecgSupported:  Bool            = false
    @Published var signalQuality: SignalQuality   = .unknown
    @Published var discoveredDevices: [DiscoveredDevice] = []

    /// Emits (rrMs, wallClockTimestamp)
    let rrPublisher  = PassthroughSubject<(Double, Date), Never>()
    /// Emits raw ECG samples (µV) at 130 Hz
    let ecgPublisher = PassthroughSubject<[Int32], Never>()

    private var central:         CBCentralManager!
    private var peripheral:      CBPeripheral?
    private var pmdControlChar:  CBCharacteristic?
    private var restoredPeripheral: CBPeripheral?
    private var pmdDataChar:     CBCharacteristic?
    private var pendingScan = false

    private var lastPacketTime   = Date()
    private var signalTimer:     Timer?

    private override init() {
        super.init()
        // CBCentralManagerOptionRestoreIdentifierKey enables background state restoration
        central = CBCentralManager(
            delegate: self,
            queue: DispatchQueue.global(qos: .userInitiated),
            options: [CBCentralManagerOptionRestoreIdentifierKey: "com.cardiotrace.central"]
        )
    }

    // MARK: – Public API

    func startScan() {
        guard central.state == .poweredOn else {
            pendingScan = true   // will fire once BT powers on
            return
        }
        pendingScan = false
        DispatchQueue.main.async {
            self.discoveredDevices = []
            self.state = .scanning
        }
        central.scanForPeripherals(
            withServices: [.hrService],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard case .scanning = self?.state else { return }
            self?.central.stopScan()
            self?.state = .idle
        }
    }

    func connect(to device: DiscoveredDevice) {
        central.stopScan()
        peripheral = device.peripheral
        peripheral?.delegate = self
        DispatchQueue.main.async { self.state = .connecting }
        central.connect(device.peripheral, options: nil)
    }

    func cancelScan() {
        central.stopScan()
        DispatchQueue.main.async {
            self.discoveredDevices = []
            self.state = .idle
        }
    }

    func disconnect() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        cleanUp()
    }

    // MARK: – Private

    private func cleanUp() {
        signalTimer?.invalidate()
        peripheral     = nil
        pmdControlChar = nil
        pmdDataChar    = nil
        DispatchQueue.main.async {
            self.state         = .idle
            self.heartRate     = 0
            self.batteryLevel  = 0
            self.ecgSupported  = false
            self.signalQuality = .unknown
        }
    }

    private func monitorSignal() {
        signalTimer?.invalidate()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.signalTimer = Timer.scheduledTimer(timeInterval: 1,
                                                    target: self,
                                                    selector: #selector(self.updateSignal),
                                                    userInfo: nil,
                                                    repeats: true)
            RunLoop.main.add(self.signalTimer!, forMode: .common)
        }
    }

    @objc private func updateSignal() {
        let dt = -lastPacketTime.timeIntervalSinceNow
        let q: SignalQuality = dt > 5 ? .poor : dt > 3 ? .fair : dt > 1.5 ? .good : .excellent
        signalQuality = q   // already on main thread
    }

    // MARK: – HR parsing (identical logic to engine.js handleHRData)
    private func parseHR(_ data: Data) {
        let bytes = [UInt8](data)
        guard bytes.count >= 2 else { return }
        let flags    = bytes[0]
        let hrFormat = flags & 0x01
        let hr       = hrFormat == 0 ? Int(bytes[1]) : Int(bytes[1]) | (Int(bytes[2]) << 8)

        lastPacketTime = Date()
        DispatchQueue.main.async { self.heartRate = hr }

        guard flags & 0x10 != 0 else { return }
        var offset = hrFormat == 0 ? 2 : 3
        while offset + 1 < bytes.count {
            let raw  = UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
            let rrMs = Double(raw) / 1024.0 * 1000.0
            rrPublisher.send((rrMs, Date()))
            offset += 2
        }
    }

    // MARK: – ECG parsing (identical to engine.js handleECGData)
    private func parseECG(_ data: Data) {
        let bytes = [UInt8](data)
        guard bytes.count >= 10, bytes[0] == 0x00 else { return }
        let dataStart   = 10
        let sampleCount = (bytes.count - dataStart) / 3
        var samples = [Int32]()
        for i in 0..<sampleCount {
            let off = dataStart + i * 3
            var s = Int32(bytes[off]) | (Int32(bytes[off+1]) << 8) | (Int32(bytes[off+2]) << 16)
            if s & 0x800000 != 0 { s |= Int32(bitPattern: 0xFF000000) }
            samples.append(s)
        }
        ecgPublisher.send(samples)
    }

    private func startECGStream() {
        guard let char = pmdControlChar, let p = peripheral else { return }
        let cmd: [UInt8] = [0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]
        p.writeValue(Data(cmd), for: char, type: .withResponse)
        DispatchQueue.main.async { self.ecgSupported = true }
    }
}

// MARK: – CBCentralManagerDelegate
extension BluetoothManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else { return }

        // Resume a scan that was requested before Bluetooth was ready
        if pendingScan {
            pendingScan = false
            startScan()
            return
        }

        guard let p = restoredPeripheral ?? peripheral else { return }
        switch p.state {
        case .connected:
            p.discoverServices([.hrService, .batteryService, .pmdService])
            monitorSignal()
            DispatchQueue.main.async { self.state = .connected }
        case .connecting:
            break   // already in progress, wait for didConnect
        case .disconnected, .disconnecting:
            central.connect(p, options: nil)
        @unknown default:
            break
        }
        restoredPeripheral = nil
    }

    func centralManager(_ central: CBCentralManager,
                        willRestoreState dict: [String: Any]) {
        guard let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let p = peripherals.first else { return }
        p.delegate = self
        peripheral = p
        restoredPeripheral = p
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? "Unknown Device"
        let device = DiscoveredDevice(id: peripheral.identifier,
                                      name: name,
                                      peripheral: peripheral)
        DispatchQueue.main.async {
            if !self.discoveredDevices.contains(where: { $0.id == device.id }) {
                self.discoveredDevices.append(device)
            }
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didConnect peripheral: CBPeripheral) {
        DispatchQueue.main.async { self.state = .calibrating }
        peripheral.discoverServices([.hrService, .batteryService, .pmdService])
        monitorSignal()
    }

    func centralManager(_ central: CBCentralManager,
                        didFailToConnect peripheral: CBPeripheral, error: Error?) {
        DispatchQueue.main.async { self.state = .failed(error?.localizedDescription ?? "Unknown error") }
        cleanUp()
    }

    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        cleanUp()
    }
}

// MARK: – CBPeripheralDelegate
extension BluetoothManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverServices error: Error?) {
        guard error == nil else { return }
        peripheral.services?.forEach { svc in
            switch svc.uuid {
            case .hrService:      peripheral.discoverCharacteristics([.hrMeasurement], for: svc)
            case .batteryService: peripheral.discoverCharacteristics([.batteryLevel], for: svc)
            case .pmdService:     peripheral.discoverCharacteristics([.pmdControl, .pmdData], for: svc)
            default: break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        guard error == nil else { return }
        service.characteristics?.forEach { char in
            switch char.uuid {
            case .hrMeasurement:
                peripheral.setNotifyValue(true, for: char)
            case .batteryLevel:
                peripheral.setNotifyValue(true, for: char)
                peripheral.readValue(for: char)
            case .pmdControl:
                pmdControlChar = char
                peripheral.setNotifyValue(true, for: char)
                peripheral.writeValue(Data([0x01, 0x00]), for: char, type: .withResponse)
                // Mirror JS: always attempt ECG start after 500 ms without waiting for a
                // specific PMD frame type — the device will NACK silently if unsupported.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.startECGStream()
                }
            case .pmdData:
                pmdDataChar = char
                peripheral.setNotifyValue(true, for: char)
            default: break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard error == nil, let data = characteristic.value else { return }
        switch characteristic.uuid {
        case .hrMeasurement:  parseHR(data)
        case .batteryLevel:
            DispatchQueue.main.async { self.batteryLevel = Int(data[0]) }
        case .pmdControl:
            break   // ECG start is issued proactively in didDiscoverCharacteristics
        case .pmdData:
            parseECG(data)
        default: break
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didWriteValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let e = error { print("Write error for \(characteristic.uuid): \(e)") }
    }
}
