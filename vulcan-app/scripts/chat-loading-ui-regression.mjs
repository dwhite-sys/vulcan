import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React, {useState,useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatLoadingBoundary} from './src/app/components/ChatLoadingBoundary';
    window.mounts=0;
    function Draft(){
      const [draft,setDraft]=useState('');
      useEffect(()=>{window.mounts++},[]);
      return <input aria-label="Message draft" value={draft} onChange={e=>setDraft(e.target.value)}/>;
    }
    function Fixture(){
      const [title,setTitle]=useState(null);
      return <div className="dark bg-ash-950 text-ash-100" style={{height:600}}>
        <button onClick={()=>setTitle('RBXL')}>Open RBXL</button>
        <button onClick={()=>setTitle('Other chat')}>Open other chat</button>
        <div style={{height:500}}><ChatLoadingBoundary title={title} onCancel={()=>setTitle(null)}>
          <Draft/>
        </ChatLoadingBoundary></div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
});
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setContent('<div id="root"></div>');
  for (const name of (await readdir(`${project}/dist/assets`)).filter((name) => name.endsWith('.css'))) {
    await page.addStyleTag({ content: await readFile(`${project}/dist/assets/${name}`, 'utf8') });
  }
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const draft = page.getByRole('textbox', { name: 'Message draft' });
  await draft.fill('Preserve this unsent message');
  await page.getByRole('button', { name: 'Open RBXL', exact: true }).click();
  const status = page.getByRole('status');
  await status.waitFor();
  assert.match(await status.innerText(), /Opening RBXL/);
  assert.equal(await page.locator('[aria-label="Message draft"]').evaluate((el) => !!el.closest('[inert]')), true);
  await page.getByRole('button', { name: 'Open other chat' }).click();
  assert.match(await status.innerText(), /Opening Other chat/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await status.waitFor({ state: 'detached' });
  assert.equal(await draft.inputValue(), 'Preserve this unsent message');
  assert.equal(await page.evaluate(() => window.mounts), 1);
  assert.deepEqual(errors, []);
  console.log('Chat loading UI regression: pending composer is inert, status updates, cancellation preserves the mounted draft.');
} finally { await browser.close(); }
