// 移动端布局探针：用系统 Chrome(CDP) 在指定视口量一遍 dsh-pocket 的窄屏布局。
//
// 用法：
//   node tools/verify-mobile.mjs <url> [out.png] [width] [height] [drawer]
//   node tools/verify-mobile.mjs "http://192.168.5.66:3081/?token=XXXXXXXX" shot.png 390 844
//   node tools/verify-mobile.mjs "http://192.168.5.66:3081/?token=XXXXXXXX" shot.png 390 844 drawer
//
// 取 url：先 GET <lan-ip>:3081/dsh-pocket/entry.json 拿 publicPin，再拼 ?token=<pin>。
// 注意 loopback(127.0.0.1:3081) 会被代理拒（503），请用局域网 IP 或 Tailscale IP。
//
// 绿色判据（见 适配-0.2.2-rc.5.md 第三节）：
//   ≤1023 宽：frameComputedCols = "Npx 0px 0px"，centerGridColumn="1"，
//             center.x=0、center.w=视口宽，hOverflow=false
//   1024 宽：走官方原生布局（如 280/744），centerGridColumn="2"
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2]
if (!URL_ARG) {
  console.error('usage: node verify-mobile.mjs <url> [out.png] [w] [h] [drawer]')
  process.exit(2)
}
const OUT = process.argv[3] || 'mobile-probe.png'
const W = Number(process.argv[4] || 390)
const H = Number(process.argv[5] || 844)
const OPEN_DRAWER = process.argv[6] === 'drawer'
const PORT = Number(process.env.PROBE_PORT || 9333)

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const CHROME = CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
  console.error('no Chrome/Edge found; set CHROME_PATH')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pickPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('chrome devtools not reachable')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const hit = msg.id && this.pending.get(msg.id)
      if (!hit) return
      this.pending.delete(msg.id)
      msg.error ? hit.reject(new Error(JSON.stringify(msg.error))) : hit.resolve(msg.result)
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new CDP(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const frame = q('[data-mobile-nav="frame"]') || q('[class*="_frame"]');
  const center = frame ? frame.querySelector('[class*="_centerCol"]') : null;
  const sidebar = frame ? frame.querySelector('[class*="_sidebarCol"]') : null;
  const phase = q('[data-phase]');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (el) => el ? getComputedStyle(el) : null;
  const sc = document.scrollingElement;
  return {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    hasFrame: !!frame,
    frameClass: frame ? frame.className : null,
    frameInlineCols: frame ? frame.style.gridTemplateColumns : null,
    frameComputedCols: frame ? cs(frame).gridTemplateColumns : null,
    frameAttrs: frame ? [...frame.attributes].map(a => a.name + '=' + a.value) : [],
    center: box(center),
    centerGridColumn: center ? cs(center).gridColumn : null,
    sidebar: box(sidebar),
    sidebarPosition: sidebar ? cs(sidebar).position : null,
    phase: box(phase),
    docScrollW: sc.scrollWidth,
    docClientW: sc.clientWidth,
    hOverflow: sc.scrollWidth > innerWidth + 1,
    bodyText: (document.body.innerText || '').trim().slice(0, 160),
  };
})()`

const page = await pickPage()
const cdp = await CDP.connect(page.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true })
await cdp.send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  platform: 'Linux armv8l',
})
await cdp.send('Page.navigate', { url: URL_ARG })

let measured = null
for (let i = 0; i < 20; i++) {
  const r = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  measured = r.result?.value
  if (measured?.hasFrame) break
  await sleep(500)
}
await sleep(2500)
const fin = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })

let drawer = null
let clickSel = null
if (OPEN_DRAWER) {
  const c = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const sels = ['[data-mobile-nav="toggle"]', '[data-shell-leading] button', '[data-shell-leading] *[role="button"]'];
      for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return s } }
      return null
    })()`,
    returnByValue: true,
  })
  clickSel = c.result?.value
  await sleep(1400)
  const d = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  drawer = d.result?.value
}

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))

const probe = fin.result?.value || {}
const verdict = (() => {
  if (!probe.hasFrame) return 'FAIL: no frame element (auth? wrong url?)'
  if (probe.hOverflow) return 'FAIL: horizontal overflow'
  const narrow = probe.viewport.w < 1024
  if (narrow) {
    const ok = probe.centerGridColumn === '1' && probe.center.x === 0 && probe.center.w === probe.viewport.w
    return ok ? 'PASS (mobile override)' : 'FAIL: center column not on track 1 / not full width'
  }
  const ok = probe.centerGridColumn === '2' && probe.center.x > 0
  return ok ? 'PASS (native desktop layout)' : 'FAIL: desktop layout unexpected'
})()

console.log(JSON.stringify({ verdict, clickSel, final: probe, drawer, png: OUT }, null, 2))
cdp.ws.close()
chrome.kill()
process.exit(verdict.startsWith('PASS') ? 0 : 1)
