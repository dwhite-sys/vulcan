import { useState, useEffect } from 'react';
import { FileText, FileCode, Image, File, ChevronLeft, Download } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { readFileBase64 } from '../services/vulcan';
import type { PresentedFile } from '../types/vulcan';

interface ArtifactsPanelProps {
  chatId: string | null;
  presentedFiles: PresentedFile[];
  openFilePath?: string | null; // auto-open this file when set (e.g. after agent presents)
  onFileOpened?: () => void;    // called after auto-open so parent can clear the prop
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt'].includes(ext)) return <FileText className="w-3.5 h-3.5 text-ash-400 flex-shrink-0" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <Image className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />;
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'json', 'yml', 'yaml', 'sh', 'rs', 'go'].includes(ext))
    return <FileCode className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />;
  return <File className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />;
}

function isEditable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const nonEditable = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz'];
  return !nonEditable.includes(ext);
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ArtifactsPanel({ chatId, presentedFiles, openFilePath, onFileOpened }: ArtifactsPanelProps) {
  const [openFile, setOpenFile] = useState<PresentedFile | null>(null);

  // Auto-open a file when the agent calls present()
  useEffect(() => {
    if (!openFilePath || !chatId) return;
    const name = openFilePath.split('/').pop() ?? openFilePath;
    setOpenFile({ path: openFilePath, name, presentedAt: new Date(), messageId: '' });
    onFileOpened?.();
  }, [openFilePath, chatId, onFileOpened]);

  if (!chatId) {
    return (
      <div className="flex flex-col h-full bg-ash-900 border-l border-ash-800">
        <div className="px-3 py-3 border-b border-ash-800">
          <h2 className="text-xs font-semibold text-ash-400 uppercase tracking-wide">Artifacts</h2>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-ash-600 p-4 text-center">
          Start a conversation to see files presented by the agent
        </div>
      </div>
    );
  }

  if (openFile) {
    return (
      <div className="flex flex-col h-full bg-ash-900 border-l border-ash-800">
        {/* Panel header when file is open */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ash-800 bg-ash-900 flex-shrink-0">
          <button
            onClick={() => setOpenFile(null)}
            className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-400 hover:text-ash-200"
            title="Back to artifacts"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="text-xs font-semibold text-ash-400 uppercase tracking-wide">Artifacts</h2>
        </div>
        <div className="flex-1 overflow-hidden">
          <FileEditor
            chatId={chatId}
            path={openFile.path}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-ash-900 border-l border-ash-800">
      {/* Header */}
      <div className="px-3 py-3 border-b border-ash-800 flex-shrink-0">
        <h2 className="text-xs font-semibold text-ash-400 uppercase tracking-wide">
          Artifacts
          {presentedFiles.length > 0 && (
            <span className="ml-1.5 text-ash-600">({presentedFiles.length})</span>
          )}
        </h2>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {presentedFiles.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-ash-600 p-4 text-center">
            No files presented yet
          </div>
        ) : (
          <div className="py-1">
            {presentedFiles.map((file, idx) => (
              <div
                key={idx}
                className="group flex items-center gap-2.5 px-3 py-2.5 border-b border-ash-800/50 last:border-0 hover:bg-ash-800/40 transition-colors"
              >
                <button
                  onClick={() => isEditable(file.name) ? setOpenFile(file) : undefined}
                  className={`flex items-center gap-2.5 flex-1 min-w-0 text-left ${isEditable(file.name) ? 'cursor-pointer' : 'cursor-default opacity-60'}`}
                >
                  {fileIcon(file.name)}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-ash-200 font-mono truncate">{file.name}</p>
                    <p className="text-xs text-ash-600 mt-0.5">{formatTime(file.presentedAt)}</p>
                  </div>
                </button>
                <button
                  onClick={async () => {
                    if (!chatId) return;
                    try {
                      const { base64, mimeType } = await readFileBase64(chatId, file.path);
                      const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = file.name;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch { /* ignore */ }
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-ash-500 hover:text-ash-200 transition-all flex-shrink-0"
                  title="Download"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
