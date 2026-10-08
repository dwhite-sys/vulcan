import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({stdin:{resolveDir:project,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {UpdatePrompt} from './src/app/components/UpdatePrompt';
window.installCalls=0;window.handlers={};
window.electronAPI={updates:{
 getState:async()=>window.initialUpdate,
 onState:fn=>{window.handlers.state=fn;return()=>{};},
 onOpen:fn=>{window.handlers.open=fn;return()=>{};},
 onProgress:fn=>{window.handlers.progress=fn;return()=>{};},
 install:async()=>{window.installCalls++;}
}};
createRoot(document.getElementById('root')).render(<UpdatePrompt/>);
`},bundle:true,write:false,format:'iife',jsx:'automatic'});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const update={available:true,currentVersion:'1.0.0-rc.46',latestVersion:'1.0.0-rc.47',tag:'v1.0.0rc47'};
 async function mount(startup){await page.setContent('<div id="root"></div>');await page.evaluate(state=>{window.initialUpdate=state;}, {...update,promptOnStartup:startup});await page.addScriptTag({content:bundle.outputFiles[0].text});await page.waitForFunction(()=>!!window.handlers?.open);}
 await mount(true);await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:'Later',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 await page.evaluate(state=>window.handlers.state(state),{...update,tag:'v1.0.0rc48',promptOnStartup:false});
 await page.waitForTimeout(50);assert.equal(await page.getByRole('dialog').count(),0,'Periodic discovery stays quiet even for a newer release');
 await page.evaluate(state=>window.handlers.open(state),{...update,tag:'v1.0.0rc48',promptOnStartup:false});
 await page.getByRole('dialog').waitFor();assert.equal(await page.evaluate(()=>window.installCalls),0,'Tray opening must not install');
 await page.getByRole('button',{name:'Update and Restart',exact:true}).click();assert.equal(await page.evaluate(()=>window.installCalls),1);
 // A newly mounted renderer receiving a periodic result must also stay quiet.
 await page.goto('about:blank');await mount(false);await page.waitForTimeout(50);assert.equal(await page.getByRole('dialog').count(),0);
 await page.evaluate(state=>window.handlers.state(state),{...update,promptOnStartup:true});await page.getByRole('dialog').waitFor();
 assert.deepEqual(errors,[]);console.log('Update prompt OK: startup prompts, periodic discovery stays quiet, tray opens prompt, only explicit confirmation installs.');
}finally{await browser.close();}
