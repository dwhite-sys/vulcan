import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FileImage, FileText, Folder, FolderOpen } from 'lucide-react';
import { buildSkillFileTree, listSkillPackageFiles, readSkillPackageFile, stripSkillFrontmatter, type SkillFileTreeNode } from '../services/skillPackageFiles';
import type { SkillFileResult } from '../services/vulcanClient';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { SkillMeta } from './SkillToggleMenu';

const imageFilePattern = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const codeFilePattern = /\.(c|cc|cpp|css|go|html?|java|js|json|jsx|mjs|py|rs|sh|toml|ts|tsx|xml|ya?ml)$/i;

function collectFolderPaths(nodes: SkillFileTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'directory'
    ? [node.path, ...collectFolderPaths(node.children ?? [])]
    : []);
}

function firstFilePath(nodes: SkillFileTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === 'file') return node.path;
    const nested = firstFilePath(node.children ?? []);
    if (nested) return nested;
  }
  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SkillPackageExplorer({ skill }: { skill: SkillMeta }) {
  const descriptor = useMemo(() => ({ name: skill.name, source: skill.source }), [skill.name, skill.source]);
  const [files, setFiles] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SkillFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const requestGeneration = useRef(0);
  const tree = useMemo(() => buildSkillFileTree(files), [files]);

  const openFile = useCallback(async (path: string) => {
    const generation = ++requestGeneration.current;
    setSelectedPath(path);
    setSelectedFile(null);
    setFileError('');
    setFileLoading(true);
    try {
      const result = await readSkillPackageFile(descriptor, path);
      if (requestGeneration.current === generation) setSelectedFile(result);
    } catch (error) {
      if (requestGeneration.current === generation) {
        setFileError(errorMessage(error, `Could not open ${path}.`));
      }
    } finally {
      if (requestGeneration.current === generation) setFileLoading(false);
    }
  }, [descriptor]);

  useEffect(() => {
    let current = true;
    setTreeLoading(true);
    setTreeError('');
    setFiles([]);
    setSelectedPath(null);
    setSelectedFile(null);
    void listSkillPackageFiles(descriptor)
      .then((nextFiles) => {
        if (!current) return;
        const nextTree = buildSkillFileTree(nextFiles);
        setFiles(nextFiles);
        setExpandedFolders(new Set(collectFolderPaths(nextTree)));
        const initialPath = nextTree.some((node) => node.path === 'SKILL.md')
          ? 'SKILL.md'
          : firstFilePath(nextTree);
        if (initialPath) void openFile(initialPath);
      })
      .catch((error) => {
        if (current) setTreeError(errorMessage(error, 'Could not load skill files.'));
      })
      .finally(() => {
        if (current) setTreeLoading(false);
      });
    return () => {
      current = false;
      requestGeneration.current += 1;
    };
  }, [descriptor, openFile]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: SkillFileTreeNode, depth = 0): ReactNode => {
    const paddingLeft = `${0.5 + depth * 0.8}rem`;
    if (node.kind === 'directory') {
      const expanded = expandedFolders.has(node.path);
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
          {expanded && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const Icon = imageFilePattern.test(node.name) ? FileImage : codeFilePattern.test(node.name) ? FileCode2 : FileText;
    return (
      <button
        key={node.path}
        type="button"
        title={node.path}
        onClick={() => { void openFile(node.path); }}
        aria-current={selectedPath === node.path ? 'true' : undefined}
        style={{ paddingLeft }}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${
          selectedPath === node.path
            ? 'bg-ash-800 text-ash-100'
            : 'text-ash-400 hover:bg-ash-800/70 hover:text-ash-200'
        }`}
      >
        <Icon className="ml-4 h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  const renderFile = () => {
    if (fileLoading) return <p className="text-xs text-ash-500">Loading file…</p>;
    if (fileError) return <p className="text-xs text-red-400">{fileError}</p>;
    if (!selectedFile) return <p className="text-xs text-ash-500">Choose a file to inspect its contents.</p>;

    if (selectedFile.binary === true) {
      const dataUrl = `data:${selectedFile.contentType};base64,${selectedFile.base64}`;
      if (selectedFile.contentType.startsWith('image/')) {
        return <img src={dataUrl} alt={selectedFile.file} className="mx-auto max-h-72 max-w-full rounded object-contain" />;
      }
      return (
        <div className="space-y-2 text-xs text-ash-400">
          <p>This binary file cannot be previewed here.</p>
          <a href={dataUrl} download={selectedFile.file.split('/').pop()} className="text-coral-400 hover:text-coral-300">
            Download file
          </a>
        </div>
      );
    }

    if (/\.(md|mdx)$/i.test(selectedFile.file)) {
      return <MarkdownRenderer content={stripSkillFrontmatter(selectedFile.content)} />;
    }
    return <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ash-300">{selectedFile.content}</pre>;
  };

  if (treeLoading) return <p className="px-1 py-2 text-xs text-ash-500">Loading skill files…</p>;
  if (treeError) return <p className="px-1 py-2 text-xs text-red-400">{treeError}</p>;
  if (tree.length === 0) return <p className="px-1 py-2 text-xs text-ash-500">This skill package contains no readable files.</p>;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-md border border-ash-700/70 bg-ash-900/50">
        <div className="border-b border-ash-700/70 px-3 py-2 text-xs font-medium text-ash-300">Files</div>
        <nav aria-label={`${skill.name} files`} className="max-h-80 overflow-auto p-1">
          {tree.map((node) => renderNode(node))}
        </nav>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border border-ash-700/70 bg-ash-900/50">
        <div className="flex min-h-9 items-center justify-between gap-2 border-b border-ash-700/70 px-3 py-2">
          <span className="truncate font-mono text-xs text-ash-300" title={selectedPath ?? undefined}>{selectedPath ?? 'File preview'}</span>
          <span className="shrink-0 text-xs text-ash-500">{skill.source === 'vulcan' ? 'Vulcan' : 'Etna'}</span>
        </div>
        <div className="max-h-80 overflow-auto p-3">{renderFile()}</div>
      </div>
    </div>
  );
}
