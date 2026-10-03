/** Real widget + xterm + Docker PTY behavioral test. No live app/config used.
 * PLAYWRIGHT_MODULE optionally supplies an external scratch installation.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Session } from '../../vulcan/terminal_host/session.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const container = 'vulcan-browser-test-' + process.pid;
const integration = fileURLToPath(new URL('../../vulcan/terminal_host/vendor/shellIntegration-bash.sh', import.meta.url));
const run = args => { const result = spawnSync('docker', args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout; };
run(['run', '-d', '--name', container, '-v', `${integration}:/integration.sh:ro`, 'ubuntu:24.04', 'sleep', '600']);
process.on('exit', () => spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' }));
const session = new Session({ file: 'docker', args: ['exec', '-it', '-e', 'VSCODE_NONCE=browser-test', container, '/bin/bash', '--noprofile', '--rcfile', '/integration.sh', '-i'], cols: 80, rows: 24, env: process.env, nonce: 'browser-test' });
let browser;
let timer;
const sockets = new Set();
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TerminalSlotWidget} from './src/app/components/TerminalSlotWidget';import {measureTerminal} from './src/app/terminalDimensions';window.expectedGrid=()=>measureTerminal(window.vulcanTerm); function App(){const [active,setActive]=React.useState(true);window.setActive=setActive;return <div id="panel" style={{position:'relative',width:720,height:350,visibility:active?'visible':'hidden'}}><TerminalSlotWidget chatId="test" kind="user" slot={1} active={active}/></div>}; createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, jsx: 'automatic', bundle: true, write: false, outdir: 'build', format: 'esm', plugins: [{ name: 'test-transport', setup(builder) {
  builder.onResolve({ filter: /services\/(secureWebSocket|vulcan|vulcanEndpoint)$/ }, args => ({ path: args.path, namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path.endsWith('secureWebSocket') ? `export class SecureWebSocket {constructor(){this.ws=new WebSocket('ws://'+location.host);window.connections=(window.connections||[]);window.connections.push(this);this.ws.onopen=()=>{this.connected=true;this.onopen?.()};this.ws.onmessage=e=>this.onmessage?.(JSON.parse(e.data));this.ws.onclose=()=>{this.connected=false;this.onclose?.()};this.ws.onerror=()=>this.onerror?.()};async send(msg){this.ws.send(JSON.stringify(msg))};close(){this.ws.close()}}` : args.path.endsWith('vulcanEndpoint') ? `export const getVulcanBaseUrl=()=>location.origin;export const getVulcanWsBaseUrl=()=> 'ws://'+location.host;` : `export const generalWS={sessionToken:'test',ensureConnected:async()=>{}};export const slotStreamUrl=()=>'';export const ensureContainer=async()=>{};` }));
  builder.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: 'xterm', namespace: 'capture' }));
  builder.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ resolveDir: root, contents: `import {Terminal as Real} from ${JSON.stringify(path.join(root,'node_modules/@xterm/xterm/lib/xterm.mjs'))};export class Terminal extends Real {constructor(options){super(options);window.vulcanTerm=this}};` }));
} }] });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
let font;
for(const candidate of ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf','/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf']) { try {font=await fs.readFile(candidate);break;}catch{} }
const server = http.createServer((req, res) => { if(req.url === '/font.ttf' && font){setTimeout(()=>res.end(font),300);return;} if(req.url === '/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js)}else if(req.url === '/app.css'){res.setHeader('Content-Type','text/css');res.end(css + '.h-full{height:100%}.w-full{width:100%}')}else res.end('<html><link rel="stylesheet" href="/app.css"><body style="background:#181818"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); });
const wss = new WebSocketServer({ server });
wss.on('connection', socket => {
  let sequence = 0;
  let generation = '';
  let chain = Promise.resolve();
  sockets.add(socket);
  const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
  socket.on('message', raw => { chain = chain.then(async () => { const msg = JSON.parse(raw); if(msg.type === 'open'){ const snapshot = await session.snapshot(); sequence=snapshot.sequence;generation=snapshot.generation;send({type:'scrollback',...snapshot});send({type:'status',connected:true}); }else if(msg.type==='resize') await session.resize(msg.cols,msg.rows);else if(msg.type==='input') await session.input(msg.text); }).catch(error => send({type:'error',message:error.message})); });
  const interval = setInterval(() => { chain = chain.then(async () => { if(!generation)return;const state=await session.poll(sequence,generation);for(const event of state.events || [])send({type:'chunk',generation,...event});sequence=state.sequence || sequence; }); },20);
  socket.on('close',()=>{clearInterval(interval);sockets.delete(socket)});
});
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.vulcanTerm && window.vulcanTerm.cols !== 80);
  const text = async ()=>(await session.snapshot()).text;
  async function until(fn){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25))}throw new Error('Browser/PTY did not settle: '+JSON.stringify({host:await session.state(),viewer:await page.evaluate(()=>({cols:window.vulcanTerm?.cols,rows:window.vulcanTerm?.rows,parent:window.vulcanTerm?.element?.parentElement?.getBoundingClientRect().toJSON()})),errors}))}
  for(const width of [280,1200,430,720]){
    await page.evaluate(width=>document.getElementById('panel').style.width=width+'px',width);
    await until(async()=>{const dims=await page.evaluate(()=>({cols:window.vulcanTerm.cols,rows:window.vulcanTerm.rows}));const state=await session.state();return dims.cols===state.cols && dims.rows===state.rows && Math.abs(dims.cols-width/7.8)<10});
    const dims=await session.state();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`stty size; printf 'SIZE_OK_${width}\\n'`);await page.keyboard.press('Enter');
    await until(async()=> (await text()).includes(`SIZE_OK_${width}\n`));
    assert((await text()).includes(`${dims.rows} ${dims.cols}`));
    // Type beyond several wrap boundaries, edit at the beginning and end.
    const payload='abcdefghijklmnopqrstuvwxyz'.repeat(7);
    await page.keyboard.type(`printf '%s\\n' '${payload}'`);
    await page.keyboard.press('Control+a');await page.keyboard.type(' ');await page.keyboard.press('Control+e');
    await page.keyboard.press('Enter');
    await until(async()=> (await text()).replace(/\n/g, '').includes(payload));
  }
  // Burst layout changes must settle at the last geometry barrier.
  await page.evaluate(()=>{for(let width=300;width<1100;width+=13) document.getElementById('panel').style.width=width+'px';document.getElementById('panel').style.width='720px'});
  await until(async()=> (await session.state()).cols === await page.evaluate(()=>window.vulcanTerm.cols));
  if(font){
    await page.evaluate(async()=>{const face=new FontFace('Cascadia Code','url(/font.ttf)');document.fonts.add(face);await face.load();await document.fonts.ready});
    await until(async()=>{const state=await session.state();const viewer=await page.evaluate(()=>({cols:window.vulcanTerm.cols,rows:window.vulcanTerm.rows}));const expected=await page.evaluate(()=>window.expectedGrid());return state.cols===viewer.cols && state.rows===viewer.rows && state.cols===expected.cols && state.rows===expected.rows});
    const fontDims=await session.state();
    assert.deepEqual({cols:fontDims.cols,rows:fontDims.rows},await page.evaluate(()=>({cols:window.vulcanTerm.cols,rows:window.vulcanTerm.rows})));
  }
  const before=await session.state();await page.evaluate(()=>window.setActive(false));await page.evaluate(()=>document.getElementById('panel').style.width='0px');await new Promise(r=>setTimeout(r,200));
  assert.equal((await session.state()).cols,before.cols);
  await page.evaluate(()=>{document.getElementById('panel').style.width='720px';window.setActive(true)});
  await new Promise(r=>setTimeout(r,250));
  await page.evaluate(()=>window.connections.at(-1).close());await page.waitForFunction(()=>window.connections.length>=2 && window.connections.at(-1).connected);await new Promise(r=>setTimeout(r,250));
  assert(!(await text()).includes('1;2c0;276;0c'));
  assert.deepEqual(errors,[]);
  if(process.env.VULCAN_TERMINAL_SCREENSHOT) await page.screenshot({path:process.env.VULCAN_TERMINAL_SCREENSHOT});
  console.log(JSON.stringify({widget:'actual TerminalSlotWidget',narrow_wide_wrap_edit:'passed',inner_docker_dimensions:'passed',hidden_zero_size:'passed',rapid_layout:'passed',deferred_font:font?'passed':'not available',reconnect:'passed',page_errors:errors}));
} finally {
  if(browser)await browser.close();for(const socket of sockets)socket.close();wss.close();server.close();await session.close();run(['rm','-f',container]);
}
