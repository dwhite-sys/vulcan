        import assert from 'node:assert/strict';
        import { readFile } from 'node:fs/promises';

        const transcript = await readFile(new URL('../src/app/components/TranscriptRenderer.tsx', import.meta.url), 'utf8');
        const visualization = await readFile(new URL('../src/app/components/RenderToUser.tsx', import.meta.url), 'utf8');
        const chat = await readFile(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');
        const vulcanTools = await readFile(new URL('../src/app/services/vulcanTools.ts', import.meta.url), 'utf8');
        const serverRuntime = await readFile(new URL('../../vulcan/agent_runtime.py', import.meta.url), 'utf8');
        const packagedServerRuntime = await readFile(new URL('../../vulcan/vulcan/agent_runtime.py', import.meta.url), 'utf8');

        assert.match(transcript, /if \(event\.type === 'tool' && event\.tool === 'visualize'\)\s*\{\s*flushActions\(\);[\s\S]*?<RenderToUser[\s\S]*?continue;\s*\}/, 'Visualizations must be rendered outside automatically collapsing action groups.');
        assert.match(visualization, /const MAX_VISUALIZATION_HEIGHT = 720;/, 'Visualizations may grow naturally up to the 720px ceiling.');
        assert.match(visualization, /const VISUALIZATION_VIEWPORT_LIMIT = 'min\(720px, 68vh\)';/, 'Visualizations must still respect the viewport.');
        assert.match(chat, /<div ref=\{messagesContentRef\}>/, 'Full-width variant must leave transcript unpadded.');
assert.doesNotMatch(chat, /ref=\{messagesContentRef\} style=\{\{ width:/, 'Full-width variant must not constrain transcript width.');
assert.match(vulcanTools, /return JSON\.stringify\(\{ width: ctx\.getRenderWidth\(\) \}\);/, 'Client width report must use full pane width.');
for (const runtime of [serverRuntime, packagedServerRuntime]) assert.match(runtime, /get_visualization_width[\s\S]{0,140}int\(run\.options\.get\("renderWidth", 680\)\)/, 'Server width report must use full pane width.');
        assert.match(visualization, /import \{[^}]*ChevronDown[^}]*ChevronRight[^}]*X[^}]*\} from 'lucide-react';/, 'Preview controls must retain their Lucide imports.');
        assert.match(visualization, /aria-label="Visualization actions"/, 'Visualizations must expose hover actions without permanent header chrome.');
        assert.match(visualization, /data-menu-dismiss="outside-and-escape"/, 'Visualization actions must dismiss on outside click and Escape.');
        assert.match(visualization, /if \(e\.source !== mermaidRef\.current\?\.contentWindow\) return;/, 'One Mermaid visualization must not resize another.');
        assert.match(visualization, /const frameHeightCache = new Map<string, number>\(\);/, 'Visualization iframe height must survive transcript virtualization remounts.');
        assert.match(visualization, /const mermaidSnapshotCache = new Map<string, string>\(\);[\s\S]*?vulcan-mermaid-ready[\s\S]*?setMermaidSnapshot\(sanitized\)/, 'Mermaid must snapshot rendered SVG for remounts.');
        console.log('Visualization persistence, full-width transcript geometry, hover chrome, and preview icon imports verified.');
