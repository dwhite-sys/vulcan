import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({stdin:{resolveDir:project,loader:'tsx',contents:`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Panel,PanelGroup,PanelResizeHandle} from 'react-resizable-panels';
import {useSidebarWidths} from './src/app/hooks/useSidebarWidths';
function Fixture(){
 const [left,L]=useState(true),[right,R]=useState(true);const w=useSidebarWidths(left,right);
 window.layout=()=>w.groupRef.current.getLayout();
 return <><button onClick={()=>L(!left)}>Chat</button><button onClick={()=>R(!right)}>Workspace</button>
 <div style={{width:1000,height:400}}><PanelGroup direction="horizontal" ref={w.groupRef} onLayout={w.onLayout}>
 {left&&<><Panel id="left" order={1} defaultSize={w.widths.chat} minSize={15} maxSize={30}/><PanelResizeHandle id="left-handle" style={{width:4}} onDragging={w.onDragging} onKeyDownCapture={w.onKeyDownCapture}/></>}
 <Panel id="center" order={2} minSize={30}/>
 {right&&<><PanelResizeHandle id="right-handle" style={{width:4}} onDragging={w.onDragging} onKeyDownCapture={w.onKeyDownCapture}/><Panel id="right" order={3} defaultSize={w.widths.workspace} minSize={20} maxSize={50}/></>}
 </PanelGroup></div></>;
}createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,write:false,format:'iife',jsx:'automatic'});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1200,height:600}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://sidebar.test/**',route=>route.fulfill({body:'<div id="root"></div>',contentType:'text/html'}));
 async function mount(){await page.goto('http://sidebar.test/');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.getByRole('button',{name:'Chat',exact:true}).waitFor();}
 const layout=()=>page.evaluate(()=>window.layout());
 const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.1,`${actual} should equal ${expected}`);
 async function drag(id,dx){const b=await page.locator('[data-panel-resize-handle-id="'+id+'"]').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+100);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+100,{steps:8});await page.mouse.up();}
 await mount();near((await layout())[0],20);near((await layout())[2],20);
 await page.getByRole('button',{name:'Chat',exact:true}).click();await drag('right-handle',-80);
 const workspace=(await layout())[1];assert.ok(workspace>25);
 await page.getByRole('button',{name:'Chat',exact:true}).click();near((await layout())[2],workspace);
 await drag('left-handle',35);const chat=(await layout())[0];assert.ok(chat>22);
 await page.getByRole('button',{name:'Workspace',exact:true}).click();near((await layout())[0],chat);
 await page.getByRole('button',{name:'Workspace',exact:true}).click();near((await layout())[0],chat);near((await layout())[2],workspace);
 const handle=page.locator('[data-panel-resize-handle-id="right-handle"]');await handle.focus();await page.waitForTimeout(100);await page.keyboard.press('ArrowLeft');const keyboardWorkspace=(await layout())[2];assert.ok(keyboardWorkspace>workspace);
 await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByRole('button',{name:'Workspace',exact:true}).click();near((await layout())[0],100);
 await mount();near((await layout())[0],chat);near((await layout())[2],keyboardWorkspace);
 assert.deepEqual(errors,[]);console.log('Sidebar widths OK: cross-sidebar toggles, pointer and keyboard resizing, both closed, and restart persistence.');
}finally{await browser.close();}
