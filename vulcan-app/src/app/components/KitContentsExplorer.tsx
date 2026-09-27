import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FileImage, FileText, Folder, FolderOpen, Wrench } from 'lucide-react';
import type { KitWithTools, Tool } from '../types/vulcan';
import { buildSkillFileTree, stripSkillFrontmatter, type SkillFileTreeNode } from '../services/skillPackageFiles';
import type { SkillFileResult } from '../services/vulcanClient';
import { listEtnaSkillFiles, readEtnaSkill, readEtnaSkillFile } from '../services/etnaRegistry';
import { MarkdownRenderer } from './MarkdownRenderer';

type Selection =
  | { kind: 'tool'; name: string }
  | { kind: 'skill-file'; path: string };

const imageFilePattern = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const codeFilePattern = /\.(c|cc|cpp|css|go|html?|java|js|json|jsx|mjs|py|rs|sh|toml|ts|tsx|xml|ya?ml)$/i;

function collectFolderPaths(nodes: SkillFileTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'directory'
    ? [node.path, ...collectFolderPaths(node.children ?? [])]
    : []);
}

function foldersFirst(nodes: SkillFileTreeNode[]): SkillFileTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function KitContentsExplorer({
  kit,
  skillName,
  disabledTools,
  onToggleTool,
}: {
  kit: KitWithTools;
  skillName?: string;
  disabledTools: Set<string>;
  onToggleTool: (toolKey: string) => void;
}) {
  const [skillOpen, setSkillOpen] = useState(true);
  const [toolFileOpen, setToolFileOpen] = useState(true);
  const [folderPaths, setFolderPaths] = useState<Set<string>>(() => new Set());
  const [skillFiles, setSkillFiles] = useState<string[]>([]);
  const [skillLoading, setSkillLoading] = useState(Boolean(kit.skill));
  const [skillError, setSkillError] = useState('');
  const [selection, setSelection] = useState<Selection | null>(() =>
    kit.tools[0] ? { kind: 'tool', name: kit.tools[0].name } : null);
  const [fileContent, setFileContent] = useState<SkillFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const requestGeneration = useRef(0);
  const userSelected = useRef(false);
  const legacySkillBody = useRef<string | null>(null);
  const skillTree = useMemo(() => foldersFirst(buildSkillFileTree(skillFiles)), [skillFiles]);
  const resolvedSkillName = skillName || kit.skill?.split('/').filter(Boolean).pop() || '';
  const etnaSource = kit.effective_source;

  const openSkillFile = useCallback(async (path: string, userInitiated = true) => {
    if (!resolvedSkillName) return;
    if (userInitiated) userSelected.current = true;
    const generation = ++requestGeneration.current;
    setSelection({ kind: 'skill-file', path });
    setFileError('');
    if (path === 'SKILL.md' && legacySkillBody.current !== null) {
      setFileContent({ skill: resolvedSkillName, file: path, content: legacySkillBody.current });
      setFileLoading(false);
      return;
    }
    setFileContent(null);
    setFileLoading(true);
    try {
      if (!etnaSource) throw new Error('This kit has no resolved Etna source.');
      const result = await readEtnaSkillFile(etnaSource, resolvedSkillName, path, kit.skill ?? undefined);
      if (requestGeneration.current === generation) setFileContent(result);
    } catch (error) {
      if (requestGeneration.current === generation) {
        setFileError(errorMessage(error, `Could not open ${path}.`));
      }
    } finally {
      if (requestGeneration.current === generation) setFileLoading(false);
    }
  }, [resolvedSkillName, etnaSource]);

  useEffect(() => {
    let current = true;
    userSelected.current = false;
    legacySkillBody.current = null;
    setSkillFiles([]);
    setSkillError('');
    if (!kit.skill || !resolvedSkillName) {
      setSkillLoading(false);
      return () => { current = false; requestGeneration.current += 1; };
    }
    setSkillLoading(true);
    if (!etnaSource) { setSkillLoading(false); setSkillError('This kit has no resolved Etna source.'); return () => { current = false; }; }
    void listEtnaSkillFiles(etnaSource, resolvedSkillName, kit.skill ?? undefined)
      .then(({ files }) => {
        if (!current) return;
        const tree = buildSkillFileTree(files);
        setSkillFiles(files);
        setFolderPaths(new Set(collectFolderPaths(tree)));
        const initial = files.includes('SKILL.md') ? 'SKILL.md' : files[0];
        if (initial && !userSelected.current) void openSkillFile(initial, false);
      })
      .catch(async (fileApiError) => {
        // Older Etna servers expose the paired skill as one document but do not
        // yet implement list_skill_files/read_skill_file. Keep those installs
        // useful by projecting that document as skill/SKILL.md.
        try {
          const legacy = await readEtnaSkill(etnaSource, resolvedSkillName, kit.skill ?? undefined);
          if (!current) return;
          legacySkillBody.current = legacy.body;
          setSkillFiles(['SKILL.md']);
          if (!userSelected.current) {
            requestGeneration.current += 1;
            setSelection({ kind: 'skill-file', path: 'SKILL.md' });
            setFileContent({ skill: resolvedSkillName, file: 'SKILL.md', content: legacy.body });
            setFileError('');
            setFileLoading(false);
          }
        } catch {
          if (current) setSkillError(errorMessage(fileApiError, 'Could not load the paired skill.'));
        }
      })
      .finally(() => {
        if (current) setSkillLoading(false);
      });
    return () => { current = false; requestGeneration.current += 1; };
  }, [kit.kit_name, kit.skill, resolvedSkillName, etnaSource, openSkillFile]);

  const selectTool = (tool: Tool) => {
    userSelected.current = true;
    requestGeneration.current += 1;
    setSelection({ kind: 'tool', name: tool.name });
    setFileContent(null);
    setFileError('');
    setFileLoading(false);
  };

  const toggleFolder = (path: string) => {
    setFolderPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderSkillNode = (node: SkillFileTreeNode, depth = 1): ReactNode => {
    const paddingLeft = `${0.6 + depth * 0.8}rem`;
    if (node.kind === 'directory') {
      const expanded = folderPaths.has(node.path);
      return (
        <div key={node.path}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => toggleFolder(node.path)}
            style={{ paddingLeft }}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-ash-400 hover:bg-ash-800/70 hover:text-ash-200"
          >
            {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            {expanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{node.name}</span>
          </button>
          {expanded && foldersFirst(node.children ?? []).map((child) => renderSkillNode(child, depth + 1))}
        </div>
      );
    }

    const Icon = imageFilePattern.test(node.name) ? FileImage : codeFilePattern.test(node.name) ? FileCode2 : FileText;
    const selected = selection?.kind === 'skill-file' && selection.path === node.path;
    return (
      <button
        key={node.path}
        type="button"
        title={`skill/${node.path}`}
        onClick={() => { void openSkillFile(node.path); }}
        aria-current={selected ? 'true' : undefined}
        style={{ paddingLeft }}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${
          selected ? 'bg-ash-800 text-ash-100' : 'text-ash-400 hover:bg-ash-800/70 hover:text-ash-200'
        }`}
      >
        <span className="w-3 shrink-0" aria-hidden="true" />
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  const selectedTool = selection?.kind === 'tool'
    ? kit.tools.find((tool) => tool.name === selection.name)
    : undefined;

  const renderFile = () => {
    if (fileLoading) return <p className="text-xs text-ash-500">Loading file…</p>;
    if (fileError) return <p className="text-xs text-red-400">{fileError}</p>;
    if (!fileContent) return <p className="text-xs text-ash-500">Choose a skill file or tool to inspect it.</p>;
    if (fileContent.binary === true) {
      const dataUrl = `data:${fileContent.contentType};base64,${fileContent.base64}`;
      if (fileContent.contentType.startsWith('image/')) {
        return <img src={dataUrl} alt={fileContent.file} className="mx-auto max-h-72 max-w-full rounded object-contain" />;
      }
      return <a href={dataUrl} download={fileContent.file.split('/').pop()} className="text-xs text-coral-400 hover:text-coral-300">Download binary file</a>;
    }
    if (/\.(md|mdx)$/i.test(fileContent.file)) return <MarkdownRenderer content={stripSkillFrontmatter(fileContent.content)} />;
    return <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ash-300">{fileContent.content}</pre>;
  };

  const renderTool = (tool: Tool) => {
    const properties = tool.parameters?.properties ?? {};
    const required = new Set(tool.parameters?.required ?? []);
    return (
      <div>
        <div className="border-t border-ash-700/70">
          <div className="py-2 text-xs font-medium text-ash-400">Prompt</div>
          <p className="whitespace-pre-wrap border-t border-ash-700/50 py-2 text-sm leading-5 text-ash-300">{tool.description}</p>
        </div>
        <div className="mt-2 border-t border-ash-700/70">
          <div className="py-2 text-xs font-medium text-ash-400">Parameters</div>
          {Object.keys(properties).length === 0 ? (
            <p className="pb-2 text-xs text-ash-500">No parameters.</p>
          ) : Object.entries(properties).map(([name, schema]) => {
            const detail = schema as Record<string, any>;
            return (
              <div key={name} className="grid grid-cols-[minmax(7rem,0.45fr)_minmax(0,1fr)] gap-3 border-t border-ash-700/50 py-2 text-xs">
                <div className="min-w-0">
                  <div className="break-words font-mono text-ash-200">{name}{required.has(name) && <span className="text-coral-400"> *</span>}</div>
                  <div className="text-ash-500">{String(detail.type ?? 'value')}{detail.default !== undefined ? ` · default ${String(detail.default)}` : ''}</div>
                </div>
                <div className="text-ash-400">{detail.description || (Array.isArray(detail.enum) ? `Options: ${detail.enum.join(', ')}` : 'No additional description.')}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const selectedTitle = selectedTool?.name
    ?? (selection?.kind === 'skill-file' ? `skill/${selection.path}` : 'Contents');

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-md border border-ash-700/70 bg-ash-900/50">
        <div className="border-b border-ash-700/70 px-3 py-2 text-xs font-medium text-ash-300">Contents</div>
        <nav aria-label={`${kit.kit_name} contents`} className="max-h-96 min-w-0 overflow-x-hidden overflow-y-auto p-1">
          {kit.skill && (
            <div>
              <button type="button" aria-expanded={skillOpen} onClick={() => setSkillOpen((open) => !open)} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-ash-300 hover:bg-ash-800/70">
                {skillOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                {skillOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">skill</span>
              </button>
              {skillOpen && (
                skillLoading ? <p className="py-1.5 pl-8 text-xs text-ash-500">Loading…</p>
                  : skillError ? <p className="py-1.5 pl-8 pr-2 text-xs text-red-400">{skillError}</p>
                    : skillTree.map((node) => renderSkillNode(node))
              )}
            </div>
          )}
          <div className="min-w-0 overflow-hidden">
            <button type="button" aria-expanded={toolFileOpen} onClick={() => setToolFileOpen((open) => !open)} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-ash-300 hover:bg-ash-800/70">
              {toolFileOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{kit.filename}</span>
            </button>
            {toolFileOpen && kit.tools.map((tool) => {
              const toolKey = `${kit.kit_name}::${tool.name}`;
              const enabled = !disabledTools.has(toolKey);
              const selected = selection?.kind === 'tool' && selection.name === tool.name;
              return (
                <div key={tool.name} className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-1">
                  <button
                    type="button"
                    onClick={() => selectTool(tool)}
                    aria-current={selected ? 'true' : undefined}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 pl-7 pr-1 text-left text-xs transition-colors ${
                      selected ? 'bg-ash-800 text-ash-100' : 'text-ash-400 hover:bg-ash-800/70 hover:text-ash-200'
                    }`}
                  >
                    <Wrench className="h-3.5 w-3.5 shrink-0 text-coral-400" />
                    <span className="truncate">{tool.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleTool(toolKey)}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} tool ${tool.name}`}
                    className={`relative mr-0.5 h-4 w-8 shrink-0 rounded-full transition-colors ${enabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </nav>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border border-ash-700/70 bg-ash-900/50">
        <div className="flex min-h-9 items-center justify-between gap-2 border-b border-ash-700/70 px-3 py-2">
          <span className="truncate font-mono text-xs text-ash-300" title={selectedTitle}>{selectedTitle}</span>
          <span className="shrink-0 text-xs text-ash-500">{selectedTool ? 'Tool' : 'Skill file'}</span>
        </div>
        <div className="max-h-96 overflow-auto p-3">{selectedTool ? renderTool(selectedTool) : renderFile()}</div>
      </div>
    </div>
  );
}
