#!/usr/bin/env python3
"""
CardioTrace automated browser tests (headless Chromium + simulated Polar H10).

  cd tests && npm install            # test-only copies of Plotly, GridStack and JSZip (versions pinned as in index.html)
  pip install playwright && playwright install chromium
  python run_tests.py                # exit code 0 = all checks passed

The app is served from the repository root; the three CDN libraries are answered from tests/node_modules,
and navigator.bluetooth is replaced by a mock device that exposes the Heart Rate, Battery and PMD
characteristics and lets the tests inject Heart Rate and ECG notifications, or drop the link.
"""
import functools, http.server, json, os, socketserver, sys, threading, zipfile, traceback
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
NM = os.path.join(HERE, 'node_modules')
LIBS = {'plotly': f'{NM}/plotly.js-dist-min/plotly.min.js', 'jszip': f'{NM}/jszip/dist/jszip.min.js',
        'gridstack-all.js': f'{NM}/gridstack/dist/gridstack-all.js', 'gridstack.min.css': f'{NM}/gridstack/dist/gridstack.min.css'}

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
def serve():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'

MOCK_BLE = r"""
(() => {
  const chars = {};
  const mk = u => { const c = new EventTarget(); c.uuid = u; c.value = null; c.writes = [];
    c.startNotifications = async () => c; c.readValue = async () => new DataView(new Uint8Array([87]).buffer);
    c.writeValueWithResponse = async v => { c.writes.push(Array.from(v)); };
    c.writeValueWithoutResponse = c.writeValueWithResponse;
    c.writeValue = async () => { throw new Error('deprecated writeValue() must not be used'); }; return c; };
  const get = u => chars[u] || (chars[u] = mk(u));
  const server = { getPrimaryService: async () => ({ getCharacteristic: async u => get(u) }) };
  const device = new EventTarget();
  device.gatt = { connected: false, connect: async () => { device.gatt.connected = true; return server; },
    disconnect: () => { if (!device.gatt.connected) return; device.gatt.connected = false; setTimeout(() => device.dispatchEvent(new Event('gattserverdisconnected')), 0); } };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device }, configurable: true });
  const fire = (c, bytes) => { c.value = new DataView(new Uint8Array(bytes).buffer); c.dispatchEvent(new Event('characteristicvaluechanged')); };
  window.__chars = chars;
  window.__ble = {
    hr(rrMs, hr = 70) { const b = [0x10, hr]; for (const ms of rrMs) { const u = Math.round(ms / 1000 * 1024); b.push(u & 255, u >> 8); } fire(get('00002a37-0000-1000-8000-00805f9b34fb'), b); },
    ecg(n = 73, start = 0) { const b = new Array(10).fill(0); for (let i = 0; i < n; i++) { const v = start + i; b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255); } fire(get('fb005c82-02e7-f387-1cad-8acd2d8df0c8'), b); },
    drop() { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); }
  };
})();
"""
SEED_RR = """(n) => { rrIntervals=[];timestamps=[];rawRRIntervals=[];rawTimestamps=[]; let t=0;
  for (let i=0;i<n;i++){ const r=850+40*Math.sin(2*Math.PI*0.1*t)+25*Math.sin(2*Math.PI*0.25*t)+(Math.random()-0.5)*20;
    rrIntervals.push(r);timestamps.push(t);rawRRIntervals.push(r);rawTimestamps.push(t); t+=r/1000; } return t; }"""
SESSION = """async(o)=>{ const ts=[],rr=[]; for(let i=0;i<o.n;i++){ts.push(i+1);rr.push(800);}
  return await saveSession({startTime:Date.parse('2026-01-02T10:00:00Z'),filename:o.name,rrIntervals:rr,timestamps:ts,rawRRIntervals:rr,rawTimestamps:ts,
  eventMarkers:o.events||[],annotations:[],tags:o.tags||[],avgRR:800,rmssd:0,sri:0,sriComponents:{rmssd:0,lfhf:0,hrRecovery:0},peakHR:75}); }"""
DB_COUNT = "new Promise(res=>{const r=indexedDB.open('PolarH10Monitor');r.onsuccess=()=>{const t=r.result.transaction('sessions').objectStore('sessions').count();t.onsuccess=()=>res(t.result)}})"

class App:
    """One isolated browser context per test."""
    def __init__(self, browser, base, w=1280, h=900, settings=None):
        self.ctx = browser.new_context(viewport={'width': w, 'height': h}, accept_downloads=True)
        self.base = base; self.dialogs = []; self.errors = []
        self.ctx.route('**/*', self._route)
        self.p = self.ctx.new_page(); p = self.p
        p.on('pageerror', lambda e: self.errors.append(str(e)))
        p.on('console', lambda m: self.errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        p.on('dialog', lambda d: (self.dialogs.append(d.message), d.accept()))
        p.add_init_script(MOCK_BLE)
        s = json.dumps({'calibrationSecs': 1, 'autosaveSecs': 10, **(settings or {})})
        p.add_init_script(f"if(!localStorage.getItem('cardioTraceSettings')) localStorage.setItem('cardioTraceSettings', '{s}');")
    def _route(self, r):
        u = r.request.url
        if u.startswith(self.base): return r.continue_()
        for k, path in LIBS.items():
            if k in u: return r.fulfill(path=path, content_type='text/css' if path.endswith('.css') else 'application/javascript')
        return r.abort()
    def open(self, wait=1000):
        self.p.goto(self.base + '/index.html'); self.p.wait_for_timeout(wait); return self.p
    def connect(self, wait=1600):
        self.p.click('#connectBtn'); self.p.wait_for_timeout(wait)
    def close(self): self.ctx.close()

RESULTS = []
def check(cond, msg):
    RESULTS.append((bool(cond), msg)); print(('  PASS ' if cond else '  FAIL ') + msg)
    return bool(cond)
TESTS = []
def test(fn): TESTS.append(fn); return fn

# ───────────────────────────── BLE / acquisition ─────────────────────────────
@test
def ble_connect_and_ecg_start(b, base):
    "Connect, calibrate, start ECG through writeValueWithResponse"
    a = App(b, base); p = a.open(); a.connect(2200)
    w = p.evaluate("__chars['fb005c81-02e7-f387-1cad-8acd2d8df0c8'].writes")
    check(p.inner_text('#status').strip().upper() == 'CONNECTED', 'status CONNECTED after calibration')
    check(w and w[0] == [1, 0] and w[1][:2] == [2, 0], f'PMD control writes use writeValueWithResponse: {w}')
    check(not a.errors, f'no page errors {a.errors[:1]}'); a.close()

@test
def ble_disconnect_confirm_and_link_loss(b, base):
    "Disconnect asks for confirmation; a dropped link saves the session"
    a = App(b, base); p = a.open(); a.connect()
    p.click('#disconnectBtn'); p.wait_for_timeout(400)
    check(any('isconnect' in m for m in a.dialogs), 'Disconnect button asks for confirmation'); a.close()
    a = App(b, base); p = a.open(); a.connect()
    for i in range(12): p.evaluate("__ble.hr([800+Math.round(Math.random()*60)],70)"); p.wait_for_timeout(30)
    p.evaluate("__ble.drop()"); p.wait_for_timeout(1200)
    check('SESSION SAVED' in p.inner_text('#status').upper(), 'link loss reported as saved')
    check(p.evaluate(DB_COUNT) == 1, 'exactly one session stored after link loss'); a.close()

@test
def ble_ecg_clock_under_bursts(b, base):
    "ECG timestamps stay monotonic and unscrambled under bursty BLE delivery"
    a = App(b, base); p = a.open(); a.connect(1500)
    p.evaluate("""(()=>{let idx=0,k=0; window.__stop=false; const gaps=[150,973,300,823,100,1023,561,561];
        const tick=()=>{ if(window.__stop) return; __ble.ecg(73,idx); idx+=73; setTimeout(tick,gaps[k++%gaps.length]); }; tick();})()""")
    p.wait_for_timeout(9000); p.evaluate("window.__stop=true")
    d = p.evaluate("(()=>{const g=document.getElementById('ecgChart').data[0];return {x:g.x,y:g.y}})()")
    dts = [d['x'][i+1]-d['x'][i] for i in range(len(d['x'])-1)]
    check(all(t > 0 for t in dts), 'timestamps strictly increasing')
    check(all(d['y'][i] < d['y'][i+1] for i in range(len(d['y'])-1)), 'sample order preserved (ramp input stays a ramp)')
    check(max(dts) < 0.01 and min(dts) > 0.007, f'constant 130 Hz spacing ({min(dts)*1000:.2f}-{max(dts)*1000:.2f} ms)'); a.close()

@test
def ble_reset_and_reconnect_during_calibration(b, base):
    "Reset during calibration, and quick reconnect, do not corrupt calibration"
    a = App(b, base, settings={'calibrationSecs': 4}); p = a.open(800)
    p.click('#connectBtn'); p.wait_for_timeout(1200); p.evaluate("resetSession()"); p.wait_for_timeout(300)
    check(p.evaluate("isCalibrating && calibrationStartTime===null"), 'calibration untouched by reset')
    p.evaluate("__ble.hr([800],70)"); check(p.evaluate("rawRRIntervals.length") == 0, 'no beats recorded during calibration'); a.close()
    a = App(b, base, settings={'calibrationSecs': 5}); p = a.open(800)
    p.click('#connectBtn'); p.wait_for_timeout(1500); p.click('#disconnectBtn'); p.wait_for_timeout(400)
    p.click('#connectBtn'); p.wait_for_timeout(3800)
    check(p.evaluate("isCalibrating"), 'old calibration timer cannot end the new calibration'); a.close()

@test
def ble_no_duplicate_session_on_slow_autosave(b, base):
    "Disconnect during a slow first auto-save updates that record (no duplicate)"
    a = App(b, base, settings={'autosaveSecs': 1}); p = a.open()
    p.evaluate("saveSession = (function(o){ return async function(...x){ await new Promise(r=>setTimeout(r,900)); return o.apply(this,x); }; })(saveSession); true")
    a.connect(1500); p.evaluate("for(let i=0;i<8;i++) __ble.hr([800+i*5],70)")
    p.wait_for_function("_autoSaveInProgress===true", timeout=5000); p.evaluate("disconnect(true)"); p.wait_for_timeout(3500)
    check(p.evaluate(DB_COUNT) == 1, 'one stored session'); a.close()

# ───────────────────────────── protocols, SRI, settings ─────────────────────────────
@test
def protocols_any_time(b, base):
    "A protocol can be started, replaced and stopped at any time while recording"
    a = App(b, base); p = a.open(); a.connect()
    p.click('#changeProtocolBtn'); p.wait_for_timeout(300); p.click('#builtinProtocolList .protocol-option:nth-child(2) button'); p.wait_for_timeout(400)
    check(p.evaluate("protocolRunning"), 'started immediately mid-recording')
    check(p.evaluate("eventMarkers.some(m=>m.type.startsWith('Start: '))"), 'phase-start marker written automatically')
    p.click('#changeProtocolBtn'); p.wait_for_timeout(300); p.click('#builtinProtocolList .protocol-option:nth-child(1) button'); p.wait_for_timeout(400)
    check(any('already running' in m for m in a.dialogs) and p.evaluate("eventMarkers.some(m=>m.type==='Protocol switched')"), 'replacing asks for confirmation and is logged')
    p.click('#protocolStopBtn'); p.wait_for_timeout(200); p.click('#startProtocolBtn'); p.wait_for_timeout(300)
    check(p.evaluate("protocolRunning"), 'Start button restarts a stopped protocol'); a.close()

@test
def sri_can_be_switched_off(b, base):
    "SRI off hides every SRI element and skips its computation"
    a = App(b, base); p = a.open()
    vis = lambda sel: p.evaluate(f"(()=>{{const e=document.querySelector('{sel}');return !!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0}})()")
    check(vis('.sri-container'), 'SRI panel visible by default')
    p.click('#settingsBtn'); p.wait_for_timeout(400); p.evaluate("document.getElementById('showSRIToggle').click()"); p.evaluate("closeSettings()")
    check(not vis('.sri-container'), 'SRI panel hidden'); p.evaluate("switchTab('history')"); p.wait_for_timeout(250)
    check(not vis('#tab-history th.sri-el'), 'history SRI column hidden'); p.evaluate("switchTab('record')")
    a.connect(1500); p.evaluate("for(let i=0;i<60;i++) __ble.hr([800+Math.round(Math.random()*40)],70)"); p.wait_for_timeout(400)
    check(p.evaluate("sriScore===0 && rrIntervals.length>=50"), 'no SRI computed while off'); a.close()

@test
def settings_persist_export_import_reset(b, base):
    "Appearance and per-plot settings persist; export/import/reset round-trip"
    a = App(b, base); p = a.open()
    p.click('#settingsBtn'); p.wait_for_timeout(400); p.click('#accentGroup [data-val="emerald"]'); p.click('#densityGroup [data-val="compact"]'); p.wait_for_timeout(400)
    p.evaluate("saveChartPref('rr',{color:'#123456'})")
    p.reload(); p.wait_for_timeout(1200)
    css = lambda v: p.evaluate(f"getComputedStyle(document.documentElement).getPropertyValue('{v}').trim()")
    check(css('--accent-primary') == '#10b981' and p.evaluate("document.body.classList.contains('density-compact')"), 'appearance persists after reload')
    p.click('#settingsBtn'); p.wait_for_timeout(400)
    with p.expect_download() as d: p.click('#exportSettingsBtn')
    data = json.load(open(d.value.path()))
    check(data['app'] == 'CardioTrace' and data['settings']['chartPrefs']['rr']['color'] == '#123456', 'settings file contains appearance and plot preferences')
    p.evaluate("appSettings.appearance.accent='rose'; appSettings.chartPrefs={}; saveSettings()")
    p.set_input_files('#importSettingsFile', d.value.path()); p.wait_for_timeout(1800)
    check(css('--accent-primary') == '#10b981' and p.evaluate("appSettings.chartPrefs.rr.color") == '#123456', 'import restores everything')
    p.click('#settingsBtn'); p.wait_for_timeout(300); p.click('#resetAllSettingsBtn'); p.wait_for_timeout(1800)
    check(css('--accent-primary') == '#6366f1', 'reset returns to defaults'); a.close()

# ───────────────────────────── plots, report, history, export ─────────────────────────────
@test
def plot_tools_and_downloads(b, base):
    "Per-plot settings are applied, persist and reset; PNG, SVG and CSV downloads are valid"
    a = App(b, base); p = a.open(); p.evaluate(SEED_RR, 400); p.evaluate("refreshAllCharts()"); p.wait_for_timeout(800)
    p.click('#rrItem .ct-btn[data-act="cfg"]'); p.wait_for_timeout(250)
    p.evaluate("""(()=>{const s=(f,v)=>{const e=document.querySelector(`#chartPopover [data-f="${f}"]`); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));};
        s('color','#00ff88'); s('yMode','fixed'); s('yMin','700'); s('yMax','1000'); s('win','60');})()"""); p.wait_for_timeout(500)
    g = p.evaluate("(()=>{const c=document.getElementById('rrChart');return {c:c.data[0].line.color,yr:c._fullLayout.yaxis.range.map(Math.round),span:c.data[0].x[c.data[0].x.length-1]-c.data[0].x[0]}})()")
    check(g['c'] == '#00ff88' and g['yr'] == [700, 1000] and g['span'] <= 61, f"colour, fixed y-range and 60 s window applied ({g})")
    p.click('#chartPopover [data-act="reset"]'); p.wait_for_timeout(400)
    check(p.evaluate("document.getElementById('rrChart').data[0].line.color") == '#ec4899', 'reset restores defaults'); p.keyboard.press('Escape')
    for fmt, magic in (('png', b'\x89PNG'), ('svg', b'<svg'), ('csv', b'time_s,rmssd_ms')):
        p.click('#rollingRMSSDItem .ct-btn[data-act="menu"]'); p.wait_for_timeout(200)
        with p.expect_download(timeout=60000) as d: p.click(f'#chartPopover [data-dl="{fmt}"]')
        check(magic in open(d.value.path(), 'rb').read(400), f'{fmt.upper()} download is valid')
    check(not a.errors, 'no page errors'); a.close()

@test
def report_sections(b, base):
    "The report contains only the selected sections"
    a = App(b, base); p = a.open(); p.evaluate(SEED_RR, 300); p.evaluate("refreshAllCharts(); updateStats(); appSettings.report.scale=2"); p.wait_for_timeout(800)
    def rep():
        with p.expect_popup(timeout=120000) as pop: p.evaluate("generatePDFReport()")
        pg = pop.value; pg.wait_for_load_state(); h = pg.content(); pg.close(); return h
    p.evaluate("(()=>{const on=new Set(REPORT_PRESETS.tables()); REPORT_SECTIONS.forEach(s=>appSettings.report.sections[s.id]=on.has(s.id));})()")
    h = rep(); check('<img' not in h and 'Time Domain Analysis' in h and 'Signal Overview' not in h, 'tables preset: no plots, no empty plot sections')
    p.evaluate("(()=>{const on=new Set(REPORT_PRESETS.charts()); REPORT_SECTIONS.forEach(s=>appSettings.report.sections[s.id]=on.has(s.id)); appSettings.report.sections.hr=false; appSettings.report.sections.vagal=false;})()")
    h = rep(); check(h.count('<img') == 4 and 'Time Domain Analysis' not in h, 'charts preset: only the 4 selected plots are embedded')
    p.evaluate("REPORT_SECTIONS.forEach(s=>appSettings.report.sections[s.id]=true); appSettings.showSRI=false")
    h = rep(); check('Stress Recovery Index' not in h and 'Time Domain Analysis' in h, 'SRI off removes every SRI element'); a.close()

@test
def export_header_of_stored_session(b, base):
    "A stored session's exported header describes that session, not the live recording"
    a = App(b, base); p = a.open()
    p.evaluate(SESSION, {'n': 100, 'name': 'stored'}); p.evaluate("rrIntervals=[800,810];timestamps=[1,2];eventMarkers=[]")
    p.evaluate("switchTab('history')"); p.wait_for_timeout(400)
    with p.expect_download() as d: p.evaluate("bulkDownloadSessions()")
    z = zipfile.ZipFile(d.value.path()); txt = z.read(z.namelist()[0]).decode()
    check('# Duration: 1m 40s' in txt, 'header duration comes from the stored session'); a.close()

@test
def history_filter_and_tag_escaping(b, base):
    "History filters survive auto-save refreshes; hostile tags are rendered as text"
    a = App(b, base); p = a.open()
    p.evaluate(SESSION, {'n': 5, 'name': 'a', 'tags': ['alpha']}); p.evaluate(SESSION, {'n': 5, 'name': 'b', 'tags': ['beta']}); p.evaluate("updateHistoryBadge()")
    p.evaluate("switchTab('history')"); p.wait_for_timeout(400); p.select_option('#tagFilter', 'beta'); p.evaluate("updateHistoryBadge()"); p.wait_for_timeout(400)
    check(p.evaluate("document.getElementById('tagFilter').value") == 'beta', 'tag filter keeps its selection')
    p.evaluate("switchTab('record'); sessionTags=['a\"b<i>x</i>']; renderTags();"); p.wait_for_timeout(200)
    check(p.evaluate("document.querySelectorAll('.tag-chip i').length") == 0, 'tag with HTML is rendered as text')
    p.evaluate("document.querySelector('.tag-chip-remove').click()"); check(p.evaluate("sessionTags.length") == 0, 'such a tag can still be removed'); a.close()

@test
def responsive_layout_without_overflow(b, base):
    "No clipped or overflowing content from 240 px to 3440 px on every tab"
    js = """(tab)=>{ switchTab(tab); const iw=innerWidth;
      const ok=e=>{ for(let a=e;a&&a!==document.body&&a!==document.documentElement;a=a.parentElement){ const cs=getComputedStyle(a);
        if(cs.position==='fixed'||cs.display==='none'||cs.visibility==='hidden') return false;
        if(a!==e&&cs.overflowX!=='visible'&&a.getBoundingClientRect().right<=iw+1) return false;} return true; };
      return [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.right>iw+1&&ok(e)}).length; }"""
    bad = []
    for (w, h) in [(240, 500), (280, 560), (320, 568), (360, 740), (390, 844), (768, 1024), (1280, 800), (1920, 1080), (2560, 1080), (3440, 1440)]:
        a = App(b, base, w, h); p = a.open(600)
        for tab in ('record', 'history', 'analyze', 'subjects', 'export'):
            n = p.evaluate(js, tab); p.wait_for_timeout(80)
            if n: bad.append((f'{w}x{h}', tab, n))
        a.close()
    check(not bad, f'0 overflowing elements in 50 size/tab combinations {bad[:3]}')

# ───────────────────────────── Maintenance review (2026-11) ─────────────────────────────
HR_UUID = '00002a37-0000-1000-8000-00805f9b34fb'

@test
def stored_session_edits_keep_data(b, base):
    "Renaming a stored session keeps its date and statistics; editing a subject keeps createdAt / notes"
    a = App(b, base); p = a.open()
    sid = p.evaluate(SESSION, {'n': 5, 'name': 'orig'})
    before = p.evaluate(f"loadSession({sid})")
    p.wait_for_timeout(50)
    p.evaluate(f"updateSession({sid}, {{filename: 'renamed'}})")
    after = p.evaluate(f"loadSession({sid})")
    check(after['filename'] == 'renamed', 'rename applied')
    check(after['stats'] == before['stats'] and after['date'] == before['date'] and after['timestamp'] == before['timestamp'],
          f"stats and date unchanged by rename {after['stats']}")
    r = p.evaluate("""async()=>{ const id = await saveSubject({name:'Ana',age:30,createdAt:'2020-01-01T00:00:00.000Z',notes:'n'});
        document.getElementById('editSubjectId').value=id; document.getElementById('editSubjectName').value='Ana B';
        document.getElementById('editSubjectAge').value='31'; await saveSubjectEdit(); return await loadSubject(id); }""")
    check(r['name'] == 'Ana B' and r['createdAt'].startswith('2020') and r['notes'] == 'n', f'subject edit keeps createdAt/notes {r}')
    a.close()

@test
def protocol_runner_edge_cases(b, base):
    "Deleting the running protocol stops it cleanly; a finished protocol's banner cannot hide the next one"
    a = App(b, base); p = a.open(); a.connect(1800)
    p.evaluate("""async()=>{ window.confirm=()=>true; const id = await saveProtocol({name:'P',phases:[{name:'A',durationSecs:2,autoMark:true}]});
        chooseProtocol(await loadProtocol(id)); await confirmDeleteProtocol(id); }""")
    p.wait_for_timeout(3000)
    check(not a.errors and not p.evaluate("protocolRunning"), f'no timer errors after deleting the running protocol {a.errors[:1]}')
    p.evaluate("()=>{ chooseProtocol({id:'x',name:'Q',phases:[{name:'A',durationSecs:1}]}); }")
    p.wait_for_timeout(2500)
    p.evaluate("()=>{ chooseProtocol({id:'y',name:'R',phases:[{name:'B',durationSecs:60}]}); }")
    p.wait_for_timeout(6000)
    check(p.evaluate("protocolRunning && document.getElementById('protocolRunnerPanel').style.display !== 'none'"),
          'runner of a new protocol stays visible after the previous completion banner times out'); a.close()

@test
def hr_packet_parsing(b, base):
    "HR parser honours the Energy Expended flag and ignores a malformed trailing byte"
    a = App(b, base); p = a.open(); a.connect(1800)
    fire = f"""(bytes)=>{{ const c=__chars['{HR_UUID}']; c.value=new DataView(new Uint8Array(bytes).buffer); c.dispatchEvent(new Event('characteristicvaluechanged')); }}"""
    u = round(0.8 * 1024)
    p.evaluate(fire, [0x18, 70, 0x2C, 0x01, u & 255, u >> 8])
    rr = p.evaluate("rawRRIntervals")
    check(len(rr) == 1 and abs(rr[0] - 799.8) < 0.1, f'Energy Expended is not read as an RR interval {rr}')
    p.evaluate(fire, [0x10, 70, u & 255, u >> 8, 0x01])
    check(not a.errors and p.evaluate("rawRRIntervals.length") == 2, f'trailing byte ignored without error {a.errors[:1]}'); a.close()

@test
def export_metadata_and_csv_escaping(b, base):
    "CSV header states the real calibration; annotations are RFC 4180 quoted; every event appears once; long sessions do not overflow"
    a = App(b, base, settings={'calibrationSecs': 2}); p = a.open(); a.connect(3000)
    for _ in range(5): p.evaluate("__ble.hr([800],70)"); p.wait_for_timeout(250)
    hdr = p.evaluate("generateMetadataHeader({live:true})")
    check('Calibration Period: 2 seconds' in hdr, 'live header uses the configured calibration (2 s)')
    csv = p.evaluate("""()=>rrCsvBody([800,810,820],[1,2,3],[{time:1.1,type:'Note',annotation:'a, "b"\\nc'},{time:9,type:'Late',annotation:''}])""")
    check('"a, ""b""\nc"' in csv and csv.count('Late') == 1 and csv.count('Note') == 1, f'quoted annotation, no lost or duplicated events: {csv!r}')
    sid = p.evaluate(SESSION, {'n': 3, 'name': 'old'})
    check('Calibration Period: not recorded' in p.evaluate(f"(async()=>storedSessionCSV(await loadSession({sid})))()"),
          'stored session without calibration info is not given a made-up value')
    check(p.evaluate("()=>{ try { computeSessionMetrics({rrIntervals:new Array(200000).fill(800)}); return true } catch(e) { return false } }"),
          'session metrics on 200 000 beats do not overflow the stack'); a.close()

@test
def user_text_is_escaped(b, base):
    "Names with quotes or markup render as text and stay selectable"
    a = App(b, base); p = a.open()
    p.evaluate("""async()=>{ await saveSubject({name:'Ana "La" <b>P</b>',age:40}); openSubjectPicker(); }""")
    p.wait_for_timeout(300)
    p.locator('#subjectPickerList .subject-option').nth(1).click(); p.wait_for_timeout(200)
    check(p.evaluate("currentSubjectName") == 'Ana "La" <b>P</b>' and not a.errors, f'subject with quotes selectable {a.errors[:1]}')
    p.evaluate(SESSION, {'n': 3, 'name': '<img src=x onerror=window.__xss=1>', 'tags': ['<i>t</i>']})
    p.evaluate("switchTab('history')"); p.wait_for_timeout(400)
    p.evaluate("switchTab('export')"); p.wait_for_timeout(400)
    check(not p.evaluate("window.__xss") and p.evaluate("!document.querySelector('.session-card img, .export-session-name img, .session-tag i')"),
          'session names and tags are not interpreted as HTML'); a.close()

@test
def restored_session_and_deletions(b, base):
    "A restored session is dated by its own start; deleted subjects unassign sessions; the live session cannot be deleted"
    a = App(b, base); p = a.open(); a.connect(1800)
    for _ in range(4): p.evaluate("__ble.hr([800],70)"); p.wait_for_timeout(100)
    p.evaluate("window.confirm=()=>true; window.alert=()=>{}; autoSaveSession()"); p.wait_for_timeout(400)
    live = p.evaluate("currentSessionId")
    p.evaluate(f"(async()=>{{ await confirmAndDeleteSession({live}); }})()")
    sid = p.evaluate(SESSION, {'n': 3, 'name': 'other'})
    p.evaluate("clearAllSessions()"); p.wait_for_timeout(300)
    check(p.evaluate(DB_COUNT) == 1 and p.evaluate(f"loadSession({live}).then(s=>!!s)") and not p.evaluate(f"loadSession({sid}).then(s=>!!s)"),
          'the session being recorded survives Delete and Delete-all; other sessions are removed')
    p.evaluate("disconnect(true)"); p.wait_for_timeout(500)
    old = p.evaluate(SESSION, {'n': 60, 'name': 'old'})
    p.evaluate(f"restoreSession({old})"); p.wait_for_timeout(800)
    check('# Date: 2026-01-02' in p.evaluate("generateMetadataHeader({live:true})"),
          'export of a restored session is dated by that session, not by the previous live recording')
    r = p.evaluate("""async()=>{ const id=await saveSubject({name:'Bo',age:40}); currentSubjectId=id; currentSubjectName='Bo';
        const sid=await saveSession({startTime:Date.now(),filename:'s',rrIntervals:[800,800],timestamps:[1,2],eventMarkers:[],avgRR:800,rmssd:0});
        await confirmDeleteSubject(id); return await loadSession(sid); }""")
    check(r['subjectId'] is None and r['subjectName'] == 'Bo', f"deleting a subject unassigns its sessions {r['subjectId']}"); a.close()

@test
def events_during_calibration(b, base):
    "An event marked during calibration gets a negative time on the RR clock, not 0"
    a = App(b, base, settings={'calibrationSecs': 3}); p = a.open(); p.click('#connectBtn'); p.wait_for_timeout(600)
    p.evaluate("addEventMarker()")
    t = p.evaluate("eventMarkers[0].time")
    check(-3 < t < -1, f'event time during calibration is negative ({t:.2f} s)'); a.close()

@test
def robustness_third_scan(b, base):
    "Late auto-save after a reset; dates across midnight; whole-recording metrics in views; no IndexedDB; half-failed connect"
    a = App(b, base); p = a.open(); a.connect(1800)
    for _ in range(4): p.evaluate("__ble.hr([800],70)"); p.wait_for_timeout(50)
    r = p.evaluate("""async()=>{ const orig = saveSession; window.saveSession = async (...x) => { await new Promise(r=>setTimeout(r,400)); return orig(...x); };
        const pending = autoSaveSession(); await new Promise(r=>setTimeout(r,50));
        await performSessionReset(false); await pending; window.saveSession = orig; return currentSessionId; }""")
    check(r is None, f'an auto-save finishing after a reset does not re-attach the pre-reset record ({r})')
    check(p.evaluate("""()=>{ const y=new Date(); y.setDate(y.getDate()-1); y.setHours(23,59,0,0); return formatDate(y.toISOString()).startsWith('Yesterday'); }"""),
          'late yesterday is shown as "Yesterday", not "Today"')
    m = p.evaluate("""async()=>{ const rr=[]; const ts=[]; let t=0; for(let i=0;i<120;i++){ const v=800+(i%2?50:-50); rr.push(v); t+=v/1000; ts.push(t);}
        const id = await saveSession({startTime:Date.now(),filename:'w',rrIntervals:rr,timestamps:ts,eventMarkers:[],avgRR:800,rmssd:1});
        switchTab('analyze'); switchAnalyzeSubtab('summary'); await new Promise(r=>setTimeout(r,400));
        return { shown: document.getElementById('analyzeSummaryContent').innerText, whole: computeSessionMetrics(await loadSession(id)).rmssd }; }""")
    check(f"{m['whole']:.1f} ms" in m['shown'], f"Analyze summary shows the whole-recording RMSSD ({m['whole']:.1f} ms)"); a.close()

    a = App(b, base)
    a.p.add_init_script("indexedDB.open = () => { const r = {}; setTimeout(() => { r.error = new DOMException('blocked'); r.onerror && r.onerror(); }, 0); return r; };")
    p = a.open(1500)
    check(p.evaluate("!!grid") and any('not available' in d for d in a.dialogs), 'without IndexedDB the app still initialises and warns the user')
    for tab in ('history', 'analyze', 'subjects', 'export', 'record'): p.evaluate(f"switchTab('{tab}')"); p.wait_for_timeout(150)
    check(not [e for e in a.errors if 'IndexedDB unavailable' not in e], f'all tabs render without storage {a.errors[:2]}'); a.close()

    a = App(b, base); p = a.open()
    p.evaluate("""()=>{ const orig = navigator.bluetooth.requestDevice; navigator.bluetooth.requestDevice = async (...x) => { const d = await orig(...x);
        const c = d.gatt.connect; d.gatt.connect = async () => { const s = await c(); return { getPrimaryService: async u => { if (u.startsWith('0000180d')) throw new Error('boom'); return s.getPrimaryService(u); } }; }; window.__dev=d; return d; }; }""")
    p.click('#connectBtn'); p.wait_for_timeout(800)
    check(not p.evaluate("__dev.gatt.connected"), 'a connection that fails half-way closes the Bluetooth link'); a.close()

@test
def artifact_filter_reanchoring(b, base):
    "One wrong reference beat no longer locks the filter; ectopic pairs are still rejected; live and batch agree"
    a = App(b, base); p = a.open(); a.connect(1800)
    p.evaluate("__ble.hr([1500],70)")
    for _ in range(20): p.evaluate("__ble.hr([800,805],70)"); p.wait_for_timeout(20)
    q = p.evaluate("({raw: rawRRIntervals.length, clean: rrIntervals.length})")
    check(q['clean'] == q['raw'], f"after a wrong first beat the following 40 normal beats are kept ({q['clean']}/{q['raw']})")
    clean = lambda rr: p.evaluate("(rr)=>cleanRRData(rr, rr.map((_,i)=>i)).rr", rr)
    ect = clean([800, 800, 800, 480, 1120, 800, 800, 450, 1150, 800])
    check(ect == [800, 800, 800, 800, 800, 800], f'isolated short-long ectopic pairs are rejected {ect}')
    step = clean([900] * 5 + [550] * 5)
    check(step == [900] * 5 + [550] * 5, f'a sustained level change is accepted after {3} consistent beats {step}')
    live = p.evaluate("rrIntervals.slice()")
    batch = p.evaluate("cleanRRData(rawRRIntervals, rawTimestamps).rr")
    check(live == batch, 'live filter and batch cleaning give the same clean series'); a.close()

@test
def beat_times_within_a_packet(b, base):
    "Several RR values in one notification get distinct beat times (cumulative RR); time never runs backwards"
    a = App(b, base); p = a.open(); a.connect(1800)
    p.wait_for_timeout(1500)
    p.evaluate("__ble.hr([800,820,780],70)"); p.wait_for_timeout(300)
    p.evaluate("__ble.hr([2000,2000],70)")      # intervals longer than the gap since the last packet
    t = p.evaluate("rawTimestamps.slice()")
    d = [round(t[i+1] - t[i], 3) for i in range(len(t) - 1)]
    check(len(t) == 5 and abs(d[0] - 0.82) < 0.002 and abs(d[1] - 0.78) < 0.002, f'beats of one packet spaced by their RR intervals {d[:2]}')
    check(all(x >= 0 for x in d) and t[0] >= 0, f'beat times never decrease and never go below 0 {d}')
    check(p.evaluate("timestamps.length === rrIntervals.length && timestamps.every((v,i)=>!i||v>=timestamps[i-1])"),
          'clean series keeps monotonic time stamps')
    check(p.evaluate("JSON.stringify(packetBeatTimes([800,800],10,9.5)) === JSON.stringify([9.5,10])"),
          'a beat that would precede the previous one is clamped to it'); a.close()

def main():
    if not os.path.isdir(NM):
        sys.exit('Run `npm install` inside tests/ first (test-only copies of Plotly, GridStack and JSZip).')
    srv, base = serve(); failed = 0
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS:
            print(f'\n{fn.__name__}: {fn.__doc__}')
            try: fn(b, base)
            except Exception: print('  FAIL (exception)'); traceback.print_exc(); RESULTS.append((False, fn.__name__))
        b.close()
    passed = sum(1 for ok, _ in RESULTS if ok); failed = len(RESULTS) - passed
    print(f'\n{passed}/{len(RESULTS)} checks passed in {len(TESTS)} tests'); sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
