import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React, {useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MessageComposer} from './src/app/components/MessageComposer';
    window.submissions=[];
    function Fixture(){
      const [input,setInput]=useState('Keep the sidebar buttons working');
      const [processing,setProcessing]=useState(true);
      const [paused,setPaused]=useState(false);
      const ref=useRef(null);
      return <div style={{maxWidth:600,padding:16}}><MessageComposer input={input} setInput={setInput}
        onSubmit={(e,files,mode)=>{e.preventDefault();window.submissions.push({input,mode});setInput('');}}
        onStop={()=>{setTimeout(()=>{setProcessing(false);setPaused(true);},80);}}
        onResume={()=>{setProcessing(true);setPaused(false);}}
        canResume={paused} isProcessing={processing} kits={[]} skills={[]} files={[]}
        onToggleKit={()=>{}} onToggleSkill={()=>{}} addFiles={()=>{}} removeFile={()=>{}}
        isDragging={false} contextItems={[]} onRemoveContextItem={()=>{}} composerRef={ref}/></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle:true,write:false,format:'iife',jsx:'automatic',
});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}: {})});
try {
  const page=await browser.newPage({viewport:{width:736,height:500}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  const styles=(await readdir(`${project}/dist/assets`)).filter(name=>name.endsWith('.css'));
  for(const style of styles) await page.addStyleTag({content:await readFile(`${project}/dist/assets/${style}`,'utf8')});
  await page.addScriptTag({content:result.outputFiles[0].text});
  const editor=page.getByRole('textbox');
  const send=page.getByTitle('Send',{exact:true});
  const stop=page.getByRole('button',{name:'Stop generation'});
  await stop.waitFor();
  assert.equal(await editor.getAttribute('contenteditable'),'true');
  assert.ok((await stop.boundingBox()).x<(await send.boundingBox()).x,'Stop must be left of Send');
  await send.click();
  await page.getByRole('group',{name:'Choose follow-up behavior'}).waitFor();
  await page.getByRole('button',{name:'1 Steer'}).hover();
  assert.match(await page.getByRole('tooltip').innerText(),/current step finishes/);
  await page.keyboard.press('1');
  assert.deepEqual(await page.evaluate(()=>window.submissions),[{input:'Keep the sidebar buttons working',mode:'steer'}]);
  await editor.fill('Then add tests');await editor.press('Enter');
  await page.getByRole('button',{name:'2 Queue'}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await editor.innerText(),'Then add tests');
  await editor.press('Enter');await page.keyboard.press('2');
  assert.equal(await page.evaluate(()=>window.submissions.at(-1).mode),'queue');
  await editor.fill('Keep this draft');await stop.click();
  await page.getByRole('button',{name:'Resume generation'}).waitFor();
  assert.equal(await editor.innerText(),'Keep this draft');
  assert.ok((await page.getByRole('button',{name:'Resume generation'}).boundingBox()).x<(await send.boundingBox()).x);
  await page.getByRole('button',{name:'Resume generation'}).click();await stop.waitFor();
  assert.equal(await editor.innerText(),'Keep this draft');
  assert.equal(await page.evaluate(()=>window.submissions.length),2,'Resume must not submit the draft');
  await page.setViewportSize({width:360,height:600});
  await send.click();await page.getByRole('button',{name:'1 Steer'}).waitFor();
  const group=await page.getByRole('group',{name:'Choose follow-up behavior'}).boundingBox();
  assert.ok(group.x>=0&&group.x+group.width<=360,'choices fit narrow screens');
  assert.deepEqual(errors,[]);
  console.log('Composer controls regression OK: simultaneous Send/Stop, hover, 1/2, Escape, and Stop/Resume preserve draft.');
} finally { await browser.close(); }
