// Runs CardioTrace's own index computations (taken verbatim from ../engine.js) in Node, outside the browser.
// Usage: node app_indices.js <rr.json>   where rr.json is {"rr":[...ms...]}  → prints JSON to stdout.
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

// Pull a top-level `function name(...) {...}` out of engine.js by brace matching.
function grab(name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`function ${name} not found`);
    let depth = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}
// The wavelet block (constants + FFT helpers + computeMorletCWT) is contiguous in engine.js.
const a = src.indexOf('const CWT_FS');
const b = src.indexOf('// Update spectrogram chart');
const code = [src.slice(a, b), grab('computeSessionMetrics'), grab('computePoincareStats')].join('\n');
const ctx = { Math, Float64Array, Array, console, appSettings: {} };
vm.createContext(ctx);
vm.runInContext(code + ';this.api={computeMorletCWT,computeSessionMetrics,computePoincareStats};', ctx);

const rr = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).rr;
const m = ctx.api.computeSessionMetrics({ rrIntervals: rr, rawRRIntervals: rr });
const p = ctx.api.computePoincareStats(rr);
const c = ctx.api.computeMorletCWT(rr);
const unrounded = (() => {          // un-rounded SD1/SD2 for a fair comparison
    const n = rr.length, mean = rr.reduce((x, y) => x + y) / n;
    const sdnn = Math.sqrt(rr.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    const d = rr.slice(1).map((v, i) => v - rr[i]), dm = d.reduce((x, y) => x + y) / d.length;
    const sdsd = Math.sqrt(d.reduce((s, v) => s + (v - dm) ** 2, 0) / (d.length - 1));
    return { sd1: sdsd / Math.SQRT2, sd2: Math.sqrt(2 * sdnn ** 2 - 0.5 * sdsd ** 2) };
})();
console.log(JSON.stringify({
    n: rr.length, mean_rr: m.mean_rr, sdnn: m.sdnn, rmssd: m.rmssd, pnn50: m.pnn50, mean_hr: m.mean_hr,
    sd1: unrounded.sd1, sd2: unrounded.sd2, sd1_displayed: p && p.sd1, sd2_displayed: p && p.sd2,
    cwt: c ? { vlf: c.vlfPow, lf: c.lfPow, hf: c.hfPow, lfhf: c.lfhfRatio, dataLength: c.dataLength } : null
}));
