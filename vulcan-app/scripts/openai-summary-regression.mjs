import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  plugins: [{name: 'offline-fixture', setup(build) {
    build.onLoad({filter: /\/services\/ws\.ts$/}, () => ({loader: 'ts', contents: 'export const generalWS = {hasServerCapability:()=>false,sessionToken:""}; export const wsRequest = async()=>({});'}));
  }}],
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ThinkingStep} from './src/app/components/ChatMessage';
    createRoot(document.getElementById('root')).render(<div style={{padding:24,maxWidth:700}}>
      <section id="summary"><ThinkingStep summary thinking={'**Checking evidence**\\n\\n- Read the file\\n- Run the test\\n\\n[Source](https://example.com)'} durationMs={3000}/></section>
      <section id="raw"><ThinkingStep thinking="Existing provider reasoning" durationMs={3000}/></section>
      <section id="empty"><ThinkingStep summary thinking="" streaming={false}/></section>
    </div>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
});
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 800, height: 600}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://vulcan.test/**', route => route.fulfill({contentType: 'text/html', body: '<body class="bg-ash-950 text-ash-100"><div id="root"></div></body>'}));
  await page.goto('https://vulcan.test/');
  for (const style of (await readdir(`${project}/dist/assets`)).filter(name => name.endsWith('.css'))) {
    await page.addStyleTag({content: await readFile(`${project}/dist/assets/${style}`, 'utf8')});
  }
  await page.addScriptTag({content: bundle.outputFiles[0].text});
  await page.getByRole('button', {name: 'Reasoning summary', exact: true}).click();
  assert.equal(await page.locator('#summary strong').innerText(), 'Checking evidence');
  assert.equal(await page.locator('#summary li').count(), 2);
  assert.equal(await page.locator('#summary a').getAttribute('href'), 'https://example.com');
  assert.doesNotMatch(await page.locator('#summary').innerText(), /Thought for/);
  assert.match(await page.locator('#raw').innerText(), /Thought for/);
  assert.equal(await page.locator('#empty button').count(), 0);
  assert.deepEqual(errors, []);
  if (process.env.OPENAI_SUMMARY_SCREENSHOT) await page.screenshot({path: process.env.OPENAI_SUMMARY_SCREENSHOT});
  console.log('OpenAI summary display: Markdown, accurate label, existing reasoning, and absent-summary rendering verified.');
} finally { await browser.close(); }
