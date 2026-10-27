// scripts/bench-memory-3d.mjs — reproducible harness for the issue #62 performance
// criteria: frame time and pick latency at 2k/10k/50k nodes, on the real modules the
// app ships (memory-graph-webgl, memory-graph-gl-attach, memory-3d, memory-atlas,
// the synthetic demo generator and the overview contract).
//
// It boots the app's own Vite dev server, drives headless Chrome over CDP and runs
// each phase of each size as its own evaluation with a timeout, on a fresh page per
// size (a 38 MiB 50k payload otherwise degrades the next phase).
//
//   node scripts/bench-memory-3d.mjs                 # all sizes
//   node scripts/bench-memory-3d.mjs --sizes 50000   # one size
//   CHROME_PATH=/path/to/chrome node scripts/bench-memory-3d.mjs
//
// Results are written to benchmark-memory-3d-results.json; the measured tree is the
// repository itself, so the numbers are reproducible with the pinned toolchain.
//
// Honest caveats recorded with the results:
//  - the layout is invoked synchronously here; in the app the same generator runs in
//    memory-network-layout.worker.ts, so layout seconds are compute cost, not a UI stall;
//  - the JSON payload is generated from the same synthetic generator the demo uses,
//    not from a running API (see the PR description).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WEB = resolve(REPO, 'apps', 'web');
const VITE_BIN = resolve(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const CONTRACTS = '/@fs/' + resolve(REPO, 'packages', 'contracts', 'src', 'schemas.ts').replace(/\\/g, '/');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');
const PORT = Number(flag('port', '5210'));
const CDP_PORT = PORT + 1000;
const OUT = resolve(REPO, flag('out', 'benchmark-memory-3d-results.json'));
const PROFILE = resolve(REPO, '.bench-chrome-profile');
const selected = flag('sizes', '2000,10000,50000').split(',').map((s) => Number(s.trim()));

const log = [];
const p = (s) => { log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 120, gap = 1000) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch { /* retry */ }
    await sleep(gap);
  }
  return false;
}

p(`bench-memory-3d: sizes=${selected.join(',')} port=${PORT} chrome=${CHROME}`);
p('starting vite dev server');
const dev = spawn(process.execPath, [VITE_BIN, '--port', String(PORT), '--strictPort'], { cwd: WEB });
if (!(await waitFor(`http://127.0.0.1:${PORT}/`))) {
  p('vite did not start');
  process.exit(1);
}
p('vite up');

p(`starting headless chrome on cdp port ${CDP_PORT}`);
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1600,1000', '--use-angle=d3d11', '--enable-unsafe-swiftshader', 'about:blank',
], { windowsHide: true });
if (!(await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 60, 500))) {
  p('cdp did not come up');
  process.exit(1);
}
const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
p('browser: ' + version.Browser);

const sock = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { sock.onopen = () => res(); sock.onerror = (e) => rej(new Error(String(e.message))); });
let msgId = 0;
const pending = new Map();
sock.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => {
  const id = ++msgId;
  return new Promise((res) => { pending.set(id, res); sock.send(JSON.stringify({ id, method, params, sessionId })); });
};

let sid = null;
let targetId = null;
async function openPage() {
  if (targetId) { await send('Target.closeTarget', { targetId }); targetId = null; }
  const created = await send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/` });
  targetId = created.result.targetId;
  const att = await send('Target.attachToTarget', { targetId, flatten: true });
  sid = att.result.sessionId;
  await send('Runtime.enable', {}, sid);
  for (let i = 0; i < 120; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sid);
    if ((r.result?.result?.value || '') === 'complete') break;
    await sleep(500);
  }
  return sid;
}

const RESULTS = { browser: version.Browser, capturedAt: new Date().toISOString(), sizes: [] };
const dump = () => writeFileSync(OUT, JSON.stringify(RESULTS, null, 2), 'utf8');

async function call(label, expression, timeoutMs) {
  const t0 = Date.now();
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), timeoutMs); });
  const evaluated = send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  const r = await Promise.race([evaluated, timeout]);
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (r.timedOut) { p(`[${label}] TIMEOUT after ${timeoutMs} ms`); return { timedOut: true, ms }; }
  const res = r.result || {};
  if (res.exceptionDetails) {
    p(`[${label}] EXCEPTION (${ms} ms): ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
    return { error: JSON.stringify(res.exceptionDetails).slice(0, 400), ms };
  }
  p(`[${label}] ${ms} ms`);
  return { value: res.result?.value, ms };
}

const IMPORTS = `(async () => {
  const b = window.__bench = window.__bench || {};
  b.webgl = await import('/src/features/memory-workspace/memory-graph-webgl.ts');
  b.glAttach = await import('/src/features/memory-workspace/memory-graph-gl-attach.ts');
  b.m3d = await import('/src/features/memory-workspace/memory-3d.ts');
  b.atlas = await import('/src/features/memory-workspace/memory-atlas.ts');
  b.synth = await import('/src/demo/synthetic-memory.ts');
  try { b.contracts = await import('${CONTRACTS}'); } catch (e) { b.contracts = null; b.contractsError = String(e && e.message); }
  b.longTasks = [];
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) b.longTasks.push(+e.duration.toFixed(2)); })
    .observe({ entryTypes: ['longtask'] }); } catch {}
  const c = document.createElement('canvas');
  const g = c.getContext('webgl2');
  const dbg = g && g.getExtension('WEBGL_debug_renderer_info');
  b.env = {
    webgl2: b.webgl.isWebGL2Supported(),
    renderer: g ? (dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : null,
    vendor: g && dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
  };
  return { ...b.env, contracts: !!b.contracts, contractsError: b.contractsError || null };
})()`;

const qExpr = `const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };`;

const PHASES = {
  synth: (size) => `(() => { const b = window.__bench; const t = performance.now();
    b.g = b.synth.createSyntheticMemoryGraph(${size});
    return { ms: +(performance.now() - t).toFixed(2), nodes: b.g.nodes.length, edges: b.g.edges.length }; })()`,
  layoutStart: () => `(() => { const b = window.__bench;
    b.it = b.m3d.layoutMemoryNetwork3DStream(b.g.nodes, b.g.edges); b.layoutMs = 0; b.steps = 0;
    return { started: true }; })()`,
  layoutChunk: (chunk) => `(() => { const b = window.__bench; const t = performance.now();
    let r = b.it.next();
    while (!r.done && b.steps < ${chunk}) { b.steps += 1; r = b.it.next(); }
    const ms = performance.now() - t; b.layoutMs += ms;
    if (r.done) { b.coordinates = r.value; return { chunkMs: +ms.toFixed(2), cumulativeMs: +b.layoutMs.toFixed(2), steps: b.steps, done: true }; }
    return { chunkMs: +ms.toFixed(2), cumulativeMs: +b.layoutMs.toFixed(2), steps: b.steps, done: false }; })()`,
  atlas: () => `(() => { const b = window.__bench; const t = performance.now();
    b.atlasData = b.atlas.createMemoryAtlas(b.g.nodes, b.g.edges, false);
    return { ms: +(performance.now() - t).toFixed(2), nodes: b.atlasData.nodes.length, edges: b.atlasData.edges.length }; })()`,
  payload: () => `(() => { const b = window.__bench;
    const json = JSON.stringify(b.g);
    const bytes = new TextEncoder().encode(json).length;
    const t1 = performance.now(); const parsed = JSON.parse(json); const parseMs = +(performance.now() - t1).toFixed(2);
    let validateMs = null, validateError = null;
    const t2 = performance.now();
    try {
      const overview = { ...parsed, totalMatchingNodes: b.g.nodes.length, totalMatchingEdges: b.g.edges.length, truncated: false };
      if (b.contracts && b.contracts.memoryGraphOverviewPayloadSchema) {
        b.contracts.memoryGraphOverviewPayloadSchema.parse(overview);
        validateMs = +(performance.now() - t2).toFixed(2);
      } else validateError = 'schema unavailable: ' + (b.contractsError || '');
    } catch (e) { validateError = String((e && e.message) || e).slice(0, 160); }
    return { bytes, parseMs, validateMs, validateError }; })()`,
  attach: () => `(() => { const b = window.__bench;
    const canvas = document.createElement('canvas'); const overlay = document.createElement('canvas');
    canvas.style.cssText = 'width:1600px;height:1000px;position:fixed;left:0;top:0';
    overlay.style.cssText = 'width:1600px;height:1000px;position:fixed;left:0;top:0;pointer-events:none';
    document.body.appendChild(canvas); document.body.appendChild(overlay);
    b.canvas = canvas; b.overlay = overlay;
    b.state = { nodes: b.atlasData.nodes, edges: b.atlasData.edges, positions: b.atlasData.positions, coordinates: b.coordinates, showTitles: true, selectedNodeId: null };
    b.cameraRef = { current: { ...b.m3d.DEFAULT_MEMORY_CAMERA } };
    const t1 = performance.now();
    b.att = b.glAttach.attachWebGLGraph({ canvas, overlay, getState: () => b.state, cameraRef: b.cameraRef });
    const attachMs = +(performance.now() - t1).toFixed(2);
    const t2 = performance.now(); b.att.render(); const firstRenderMs = +(performance.now() - t2).toFixed(2);
    b.renderMs = []; b.gapMs = [];
    return { attachMs, firstRenderMs }; })()`,
  frames: (n) => `(async () => { const b = window.__bench; ${qExpr}
    await new Promise((resolve) => { let i = 0, last = performance.now();
      const step = () => { b.cameraRef.current.yaw += 0.004; b.cameraRef.current.zoom = 1 + (i % 400) * 0.002;
        const s = performance.now(); b.att.render(); const e = performance.now();
        b.renderMs.push(e - s); b.gapMs.push(s - last); last = s; i += 1;
        if (i < ${n}) requestAnimationFrame(step); else resolve(); };
      requestAnimationFrame(step); });
    const rm = b.renderMs.slice(-${n}); const gm = b.gapMs.slice(-${n});
    return { frames: ${n}, renderP50: q(rm, .5), renderP95: q(rm, .95), renderMax: +Math.max(...rm).toFixed(3),
      gapP50: q(gm, .5), gapP95: q(gm, .95) }; })()`,
  picks: (grid, steady) => `(() => { const b = window.__bench; ${qExpr}
    const g1 = []; for (let i = 0; i < ${grid}; i++) { b.cameraRef.current.yaw += 0.01; const s = performance.now(); b.att.hit(Math.random() * 1600, Math.random() * 1000); g1.push(performance.now() - s); }
    const g2 = []; for (let i = 0; i < ${steady}; i++) { const s = performance.now(); b.att.hit(Math.random() * 1600, Math.random() * 1000); g2.push(performance.now() - s); }
    return { gridP50: q(g1, .5), gridP95: q(g1, .95), steadyP50: q(g2, .5), steadyP95: q(g2, .95), steadyMax: +Math.max(...g2).toFixed(4) }; })()`,
  longtasks: () => `(() => { const b = window.__bench; const lt = b.longTasks || [];
    return { count: lt.length, max: lt.length ? Math.max(...lt) : 0, sum: +(lt.reduce((a, x) => a + x, 0)).toFixed(2) }; })()`,
  dispose: () => `(() => { const b = window.__bench; try { b.att.dispose(); } catch {}
    b.canvas.remove(); b.overlay.remove(); b.it = null; b.renderMs = null; b.gapMs = null; return true; })()`,
};

// 50k gets fewer camera changes inside the pick phase: every camera change rebuilds the
// hit grid, so the phase is pared down to stay inside its timeout. A fresh page per size
// keeps the 38 MiB payload of the previous size from degrading the next one.
const PLAN = [
  { size: 2000, framesPer: 250, frameCalls: 2, grid: 200, steady: 1000, layoutChunk: 8, layoutTimeoutMs: 240000, framesTimeoutMs: 120000, pickTimeoutMs: 180000 },
  { size: 10000, framesPer: 200, frameCalls: 2, grid: 200, steady: 1000, layoutChunk: 8, layoutTimeoutMs: 300000, framesTimeoutMs: 180000, pickTimeoutMs: 240000 },
  { size: 50000, framesPer: 120, frameCalls: 1, grid: 20, steady: 500, layoutChunk: 1, layoutTimeoutMs: 600000, framesTimeoutMs: 300000, pickTimeoutMs: 420000 },
].filter((plan) => selected.includes(plan.size));

for (const plan of PLAN) {
  const entry = { size: plan.size };
  RESULTS.sizes.push(entry);
  p(`\n===== size ${plan.size} (fresh page) =====`);

  await openPage();
  const imp = await call(`imports ${plan.size}`, IMPORTS, 180000);
  entry.env = imp.value;
  dump();

  entry.synth = (await call(`synth ${plan.size}`, PHASES.synth(plan.size), 300000)).value; dump();
  await call(`layoutStart ${plan.size}`, PHASES.layoutStart(), 60000);
  for (let chunk = 1; chunk <= 200; chunk++) {
    const r = await call(`layoutChunk ${plan.size} #${chunk}`, PHASES.layoutChunk(plan.layoutChunk), plan.layoutTimeoutMs);
    if (!r.value) { entry.layoutError = r.error || 'timeout'; break; }
    entry.layout = { chunkMs: r.value.chunkMs, cumulativeMs: r.value.cumulativeMs, steps: r.value.steps };
    if (r.value.done) break;
  }
  entry.atlas = (await call(`atlas ${plan.size}`, PHASES.atlas(), 300000)).value; dump();
  entry.payload = (await call(`payload ${plan.size}`, PHASES.payload(), 300000)).value; dump();
  entry.attach = (await call(`attach ${plan.size}`, PHASES.attach(), 120000)).value; dump();

  for (let i = 0; i < plan.frameCalls; i++) {
    const r = await call(`frames ${plan.size} #${i + 1}`, PHASES.frames(plan.framesPer), plan.framesTimeoutMs);
    entry[`frames${i + 1}`] = r.value; dump();
  }

  entry.picks = (await call(`picks ${plan.size}`, PHASES.picks(plan.grid, plan.steady), plan.pickTimeoutMs)).value; dump();
  entry.longTasks = (await call(`longtasks ${plan.size}`, PHASES.longtasks(), 60000)).value;
  await call(`dispose ${plan.size}`, PHASES.dispose(), 60000);
  dump();
}

if (targetId) { await send('Target.closeTarget', { targetId }); targetId = null; }

p('\n===== summary =====');
for (const s of RESULTS.sizes) {
  const f = s.frames2 || s.frames1 || {};
  const pay = s.payload || {};
  const pick = s.picks || {};
  p(`${s.size}: layout=${s.layout?.cumulativeMs}ms attach=${s.attach?.attachMs}ms`
    + ` frames=${(s.frames1?.frames || 0)}+${(s.frames2?.frames || 0)} renderP95=${f.renderP95}ms gapP50=${f.gapP50}ms`
    + ` payload=${pay.bytes ? (pay.bytes / 1048576).toFixed(1) + 'MiB' : 'n/a'} parse=${pay.parseMs}ms validate=${pay.validateMs}ms`
    + ` pickP95=${pick.steadyP95}ms atlas=${s.atlas?.ms}ms`);
}
RESULTS.note = 'layout is called synchronously by the harness; the app runs the same generator in memory-network-layout.worker.ts';
dump();
try { chrome.kill(); } catch { /* ignore */ }
try { dev.kill(); } catch { /* ignore */ }
p(`results: ${OUT}`);
process.exit(0);
