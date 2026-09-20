import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  displayQuotedContent,
  elementReferenceToken,
  escapeQuoteXml,
  fileReferenceToken,
  projectQuotedContent,
  quoteReferenceToken,
  stripQuoteReferenceTokens,
} from '../src/app/services/quoteProjection.ts';
import { rehydrateChatEvents } from '../src/app/services/transcript.ts';
import { insertQuoteSourceMarks, mergeQuoteTextRects, quoteConnectorPath, type QuoteMarkupNode } from '../src/app/services/quoteGeometry.ts';
import type { MessageElementReference, MessageFileReference, MessageQuote } from '../src/app/types/vulcan.ts';

const first: MessageQuote = {
  id: 'quote-first', text: 'host networking <shares> ports & sockets',
  messageId: 'assistant-one', sourceRole: 'assistant', start: 10, end: 48,
};
const second: MessageQuote = {
  id: 'quote-second', text: 'a browser uses its own localhost',
  messageId: 'assistant-two', sourceRole: 'assistant', start: 0, end: 31,
};
const liveFile: MessageFileReference = { id: 'file-live', path: 'src/parser.py' };
const historicalFile: MessageFileReference = {
  id: 'file-history', path: 'src/a"b&c.py', startLine: 42, endLine: 57, revision: 'a3f91bc',
  selectedText: 'this text must never enter provider context',
};
const designElement: MessageElementReference = {
  id: 'element-reset',
  designId: 'evidence-board',
  locator: "getByRole('button', { name: 'Reset' })",
  hierarchyAddress: 'html > body > #app > main > .toolbar > button.reset',
  tagName: 'button',
  text: 'Reset',
  route: '/',
};

assert.equal(projectQuotedContent('ordinary message'), 'ordinary message');
assert.equal(projectQuotedContent('ordinary message', []), 'ordinary message');
assert.equal(escapeQuoteXml('</quote>&<quote>'), '&lt;/quote&gt;&amp;&lt;quote&gt;');

assert.equal(
  projectQuotedContent('Explain this.', [first]),
  '<quotes>\n  <quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote>\n</quotes>\n\nExplain this.',
);

const inline = quoteReferenceToken(first.id);
assert.equal(
  projectQuotedContent(`How does ${inline} affect isolation?`, [first]),
  'How does <quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote> affect isolation?',
);
assert.equal(
  projectQuotedContent(`Compare ${inline} with the other claim.`, [first, second]),
  '<quotes>\n  <quote id="2">a browser uses its own localhost</quote>\n</quotes>\n\nCompare <quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote> with the other claim.',
);
assert.equal(
  projectQuotedContent(`${inline} then ${inline}`, [first]),
  '<quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote> then <quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote>',
);
assert.equal(projectQuotedContent(`before${quoteReferenceToken('missing')}after`, [first]),
  '<quotes>\n  <quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote>\n</quotes>\n\nbeforeafter');
assert.equal(displayQuotedContent(`Check ${inline}`, [first]), 'Check ¹');
assert.equal(displayQuotedContent(`Check ${quoteReferenceToken(second.id)}`, [first, second]), 'Check ²');
assert.equal(stripQuoteReferenceTokens(`Check ${inline} now`), 'Check  now');
assert.equal(projectQuotedContent('```python\nprint("ok")\n```', [first]).endsWith('```python\nprint("ok")\n```'), true);
assert.equal(projectQuotedContent('Inspect it.', [], [liveFile]),
  '<references>\n  <reference id="1" path="src/parser.py"></reference>\n</references>\n\nInspect it.');
assert.equal(projectQuotedContent(`Compare ${fileReferenceToken(historicalFile.id)} and ${inline}.`,
  [first], [historicalFile], [first.id, historicalFile.id]),
  'Compare <reference id="2" path="src/a&quot;b&amp;c.py" start_line="42" end_line="57" revision="a3f91bc"></reference> and ' +
  '<quote id="1">host networking &lt;shares&gt; ports &amp; sockets</quote>.');
assert.equal(projectQuotedContent('Both.', [first], [liveFile], [liveFile.id, first.id]),
  '<quotes>\n  <quote id="2">host networking &lt;shares&gt; ports &amp; sockets</quote>\n</quotes>\n\n' +
  '<references>\n  <reference id="1" path="src/parser.py"></reference>\n</references>\n\nBoth.');
assert.equal(projectQuotedContent('safe', [], [historicalFile]).includes('this text must never'), false);
assert.equal(projectQuotedContent('live', [], [liveFile]).includes('revision='), false);
assert.equal(displayQuotedContent(`${fileReferenceToken(liveFile.id)} ${inline}`, [first], [liveFile], [liveFile.id, first.id]), '¹ ²');
assert.equal(stripQuoteReferenceTokens(`${fileReferenceToken(liveFile.id)} ${inline}`), ' ');
assert.equal(projectQuotedContent('Point here.', [], [], [designElement.id], [designElement]),
  '<elements>\n  <element id="1" design="evidence-board" locator="getByRole(&#x27;button&#x27;, { name: &#x27;Reset&#x27; })" hierarchy="html &gt; body &gt; #app &gt; main &gt; .toolbar &gt; button.reset" tag="button" text="Reset" route="/"></element>\n</elements>\n\nPoint here.');
assert.equal(projectQuotedContent(`Change ${elementReferenceToken(designElement.id)}.`, [], [], [designElement.id], [designElement]),
  'Change <element id="1" design="evidence-board" locator="getByRole(&#x27;button&#x27;, { name: &#x27;Reset&#x27; })" hierarchy="html &gt; body &gt; #app &gt; main &gt; .toolbar &gt; button.reset" tag="button" text="Reset" route="/"></element>.');
assert.equal(displayQuotedContent(`${elementReferenceToken(designElement.id)}`, [], [], [designElement.id], [designElement]), '¹');
assert.equal(stripQuoteReferenceTokens(`${elementReferenceToken(designElement.id)}`), '');


const persisted = rehydrateChatEvents(JSON.parse(JSON.stringify([{
  id: 'user-one', type: 'user_message', content: `Explain ${inline}`,
  quotes: [first], references: [historicalFile], contextOrder: [first.id, historicalFile.id], timestamp: new Date('2026-08-23T12:00:00Z'),
}])));
assert.deepEqual((persisted[0] as any).quotes, [first], 'SQLite event payload round-trips retain quotation provenance');
assert.deepEqual((persisted[0] as any).references, [historicalFile], 'SQLite event payload round-trips retain historical file provenance');

const textRect = (left: number, top: number, width: number, height = 16) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});
assert.deepEqual(
  mergeQuoteTextRects([textRect(42, 10, 35), textRect(10, 10, 28)]),
  [textRect(10, 10, 67)],
  'neighboring Markdown text runs merge into one continuous highlight',
);
assert.deepEqual(
  mergeQuoteTextRects([textRect(10, 10, 45), textRect(22, 10, 18)]),
  [textRect(10, 10, 45)],
  'overlapping inline Markdown rectangles never create nested highlights',
);
assert.deepEqual(
  mergeQuoteTextRects([textRect(10, 32, 70), textRect(10, 10, 45)]),
  [textRect(10, 10, 45), textRect(10, 32, 70)],
  'different lines remain independent instead of filling intervening whitespace',
);
assert.deepEqual(
  mergeQuoteTextRects([textRect(10, 10, 20), textRect(100, 10, 20)]),
  [textRect(10, 10, 20), textRect(100, 10, 20)],
  'distant runs never highlight unselected whitespace',
);
assert.equal(
  quoteConnectorPath({ x: 20, y: 10 }, { x: 80, y: 110 }),
  'M 20 10 C 20 56, 80 64, 80 110',
  'quote connectors smoothly join the source, card, and deliberate inline references',
);
assert.equal(
  quoteConnectorPath({ x: 20, y: 10 }, { x: 80, y: 1010 }),
  'M 20 10 C 20 140, 80 880, 80 1010',
  'long connector curves retain the projection’s 130px maximum bend',
);
const markedTree: QuoteMarkupNode = {
  type: 'root',
  children: [{
    type: 'element',
    tagName: 'p',
    children: [
      { type: 'text', value: 'A highlighted ' },
      { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'phrase' }] },
      { type: 'text', value: '. Following text.' },
    ],
  }],
};
insertQuoteSourceMarks(markedTree, [{ id: 'quote-1', offset: 20, number: 1, color: '#ed7884' }]);
const markedParagraph = markedTree.children![0];
const markedStrong = markedParagraph.children![1];
assert.equal(markedStrong.children![1].tagName, 'sup', 'source superscript is inserted directly after quoted Markdown text');
assert.equal(markedStrong.children![1].children![0].value, '1');
assert.equal(markedParagraph.children![2].value, '. Following text.', 'following text remains after the genuine inline superscript');
assert.equal(markedStrong.children![1].properties!['data-vulcan-quote-marker-id'], 'quote-1');

const twoMarks: QuoteMarkupNode = { type: 'root', children: [{ type: 'text', value: 'first second' }] };
insertQuoteSourceMarks(twoMarks, [
  { id: 'two', offset: 12, number: 2, color: '#a996f4' },
  { id: 'one', offset: 5, number: 1, color: '#ed7884' },
]);
assert.deepEqual(twoMarks.children!.map((node) => node.value ?? node.children?.[0].value),
  ['first', '1', ' second', '2'], 'multiple markers preserve original offsets and source-text ordering');

const interfaceSource = readFileSync(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../src/app/components/QuoteComposer.tsx', import.meta.url), 'utf8');
const messageSource = readFileSync(new URL('../src/app/components/ChatMessage.tsx', import.meta.url), 'utf8');
const quoteSource = readFileSync(new URL('../src/app/components/QuoteSource.tsx', import.meta.url), 'utf8');
const markdownSource = readFileSync(new URL('../src/app/components/MarkdownRenderer.tsx', import.meta.url), 'utf8');
const connectionSource = readFileSync(new URL('../src/app/components/ContextConnections.tsx', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
assert.match(quoteSource, /range\.setStart\(node, start\)/);
assert.match(quoteSource, /range\.setEnd\(node, end\)/);
assert.match(quoteSource, /!value\.slice\(start, end\)\.trim\(\)/);
assert.match(quoteSource, /data-vulcan-quote-source-id=\{rect\.quoteId\}/);
assert.match(quoteSource, /FILTER_REJECT/);
assert.match(quoteSource, /finalPiece\.right = Math\.max\(finalPiece\.right, mark\.right\)/);
assert.doesNotMatch(quoteSource, /<sup className="vulcan-source-quote-number"/);
assert.match(markdownSource, /rehypePlugins=\{sourceMarks\.length/);
assert.match(interfaceSource, /prefix\.querySelectorAll\('\[data-vulcan-quote-marker-id\]'\)/);
assert.match(composerSource, /data-vulcan-quote-card-id=\{item\.id\}/);
assert.match(interfaceSource, /<ContextConnections items=\{editComposerActive \? editingContextItems : contextItems\} \/>/);
assert.match(connectionSource, /window\.addEventListener\('pointermove', follow/);
assert.match(connectionSource, /createPortal\(/);
assert.match(connectionSource, /r="2\.4"/);
assert.match(connectionSource, /vulcan-context-linked/);
assert.match(connectionSource, /vulcan-context-target-/);
assert.match(connectionSource, /data-vulcan-element-reference-id/);
assert.match(styleSource, /\.vulcan-quote-connection\s*\{[^}]*stroke-dasharray:/s);
assert.match(styleSource, /stroke-dasharray:\s*4 4/);
assert.match(styleSource, /stroke-linecap:\s*round/);
assert.match(styleSource, /stroke-dashoffset:\s*-8/);
assert.match(styleSource, /\.vulcan-quote-connection-subdued\s*\{\s*opacity:\s*0\.5/);
assert.match(styleSource, /\.vulcan-quote-connections\s*\{[^}]*pointer-events:\s*none/s);
assert.doesNotMatch(styleSource, /vulcan-quote-outline-march/);
assert.match(styleSource, /\.vulcan-source-quote-number\s*\{[^}]*position:\s*relative[^}]*top:\s*-0\.06em/s);
assert.match(messageSource, /<span className="vulcan-message-quote-number">\{index \+ 1\}<\/span>/);
assert.match(styleSource, /\.vulcan-message-quote\s*\{[^}]*align-items:\s*center/s);
assert.match(styleSource, /\.vulcan-message-quote-number\s*\{[^}]*font-size:\s*12px/s);
assert.match(styleSource, /\.vulcan-quote-card\s*\{[^}]*width:\s*172px[^}]*height:\s*78px/s);
assert.match(styleSource, /\.vulcan-quote-card::before\s*\{[^}]*left:\s*6px/s);
assert.match(styleSource, /\.vulcan-quote-card-number\s*\{[^}]*right:\s*7px/s);
assert.match(styleSource, /\.vulcan-quote-card-remove\s*\{[^}]*right:\s*5px[^}]*bottom:\s*5px/s);
assert.doesNotMatch(styleSource, /\.vulcan-quote-card:hover\s+\.vulcan-quote-card-number\s*\{[^}]*opacity:\s*0/s);
assert.match(interfaceSource, /onMouseUp=\{handleQuoteSelection\}/);
assert.match(interfaceSource, /const quoteSelectionRangeRef = useRef<Range \| null>\(null\)/,
  'quote menu must retain the actual native browser Range');
assert.match(interfaceSource, /quoteSelectionRangeRef\.current = range\.cloneRange\(\)/,
  'opening Quote\/Copy must clone the active native selection before rendering the menu');
assert.match(interfaceSource, /useLayoutEffect\(\(\) => \{[\s\S]*selection\.removeAllRanges\(\);[\s\S]*selection\.addRange\(range\);[\s\S]*\}, \[quoteMenu\]\)/,
  'native selection must be reasserted before paint while Quote\/Copy is visible');
assert.match(interfaceSource, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/,
  'Quote\/Copy menu pointerdown must not steal focus and collapse the native selection');
assert.match(interfaceSource, /Quote selection/);
assert.match(interfaceSource, /vulcan:file-reference/);
const quoteInsertion = interfaceSource.match(/const insertQuote = \(candidate: MessageQuote\) => \{([\s\S]*?)\n  \};/);
assert.ok(quoteInsertion, 'quote insertion handler remains available');
assert.doesNotMatch(quoteInsertion[1], /insertReference\(/, 'adding a quote must not insert an inline reference');
const fileReception = interfaceSource.match(/const receive = \(event: Event\) => \{([\s\S]*?)\n    \};/);
assert.ok(fileReception, 'file reference reception handler remains available');
assert.doesNotMatch(fileReception[1], /insertReference\(/, 'attaching a file must not insert an inline reference');
assert.match(composerSource, /application\/x-vulcan-quote/);
assert.match(composerSource, /insertAt\(itemsRef\.current\[index\], index \+ 1, target, existing\)/);
assert.match(composerSource, /dropEffect === 'none'/);
assert.match(composerSource, /vulcan-composer-code-block/);

const editorSource = readFileSync(new URL('../src/app/components/FileEditor.tsx', import.meta.url), 'utf8');
assert.match(editorSource, /Attach selection/);
assert.match(editorSource, /Attach file/);
assert.match(editorSource, /createDecorationsCollection/);
assert.match(editorSource, /data-vulcan-workspace-file=\{path\}/);
assert.match(editorSource, /historical && entry\?\.kind === 'commit'/);
assert.match(editorSource, /gitRestoreFile\(chatId, selectedEntry\.commit\.hash, path\)/);
assert.doesNotMatch(editorSource, /gitRestore\(chatId, selectedEntry\.commit\.hash\)/);

console.log('General quote/file/element context projection, live source links, persistence, drag/drop, selection menus, safe restores, and Markdown regression checks passed.');
