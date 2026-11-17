// Runs CardioTrace's own Lipponen & Tarvainen (2019) artifact functions (verbatim from ../engine.js) in Node.
// Usage: node app_artifacts.js <in.json>   in.json = {"cases":[{"peaks":[...ms...]}, ...]}  → JSON on stdout
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
function grab(name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`function ${name} not found`);
    let depth = 0;
    for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {      // body brace, not a default-parameter {}
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}
const names = ['_median', '_rollingCentered', '_quantileLinear', '_lipponenThreshold', 'lipponenFindArtifacts',
               '_updateIdx', 'lipponenCorrectPeaks', 'lipponenFixPeaks'];
const ctx = { Math, Float64Array, Array, Number, Set, console };
vm.createContext(ctx);
vm.runInContext(names.map(grab).join('\n') + ';this.api={lipponenFindArtifacts,lipponenFixPeaks};', ctx);
const { cases } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = cases.map(c => {
    const first = ctx.api.lipponenFindArtifacts(c.peaks);
    const fixed = ctx.api.lipponenFixPeaks(c.peaks, true);
    return { first, peaks: fixed.peaks, iterations: fixed.iterations };
});
process.stdout.write(JSON.stringify(out));
