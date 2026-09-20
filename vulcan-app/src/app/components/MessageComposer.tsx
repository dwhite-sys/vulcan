import { useRef } from 'react';
import { File, FileArchive, FileCode, FileText, Paperclip, Send, Square, X } from 'lucide-react';
import { QuoteComposer, type QuoteComposerHandle } from './QuoteComposer';
import { KitToggleMenu } from './KitToggleMenu';
import { SkillToggleMenu, type SkillMeta } from './SkillToggleMenu';
import type { ComposerContextItem, Kit, MessageAttachment } from '../types/vulcan';
import { stripQuoteReferenceTokens } from '../services/quoteProjection';

type FileKind = 'image' | 'pdf' | 'text' | 'code' | 'archive' | 'other';

function classifyFileLike(name: string, type: string): FileKind {
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || /\.(txt|md|csv|log|json|yaml|yml|toml|xml)$/i.test(name)) return 'text';
  if (/\.(js|ts|tsx|jsx|py|rb|go|rs|c|cpp|h|java|swift|kt|sh|bash|zsh|fish|css|html|htm|sql)$/i.test(name)) return 'code';
  if (/\.(zip|tar|gz|bz2|xz|7z|rar)$/i.test(name)) return 'archive';
  return 'other';
}

function FileKindIcon({ kind }: { kind: FileKind }) {
  switch (kind) {
    case 'pdf': return <FileText className="w-4 h-4 text-red-400 shrink-0" />;
    case 'text': return <FileText className="w-4 h-4 text-ash-300 shrink-0" />;
    case 'code': return <FileCode className="w-4 h-4 text-blue-400 shrink-0" />;
    case 'archive': return <FileArchive className="w-4 h-4 text-yellow-400 shrink-0" />;
    default: return <File className="w-4 h-4 text-ash-400 shrink-0" />;
  }
}

function NewAttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const kind = classifyFileLike(file.name, file.type);
  if (kind === 'image') {
    const url = URL.createObjectURL(file);
    return (
      <div className="relative group flex flex-col items-center gap-1 bg-ash-700 rounded-lg p-1.5 w-20 shrink-0">
        <img src={url} alt={file.name} className="w-16 h-16 object-cover rounded-md" onLoad={() => URL.revokeObjectURL(url)} />
        <span className="text-[10px] text-ash-300 truncate w-full text-center leading-tight">{file.name}</span>
        <button type="button" onClick={onRemove} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-ash-600 hover:bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <X className="w-2.5 h-2.5 text-ash-100" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative group flex items-center gap-2 bg-ash-700 text-ash-300 px-2.5 py-1.5 rounded-lg max-w-[180px]">
      <FileKindIcon kind={kind} />
      <span className="text-xs truncate">{file.name}</span>
      <button type="button" onClick={onRemove} className="ml-1 text-ash-500 hover:text-ash-100 shrink-0 transition-colors"><X className="w-3 h-3" /></button>
    </div>
  );
}

function ExistingAttachmentChip({ attachment, onRemove }: { attachment: MessageAttachment; onRemove: () => void }) {
  const kind = classifyFileLike(attachment.name, attachment.type);
  if (kind === 'image' && attachment.dataUrl) {
    return (
      <div className="relative group flex flex-col items-center gap-1 bg-ash-700 rounded-lg p-1.5 w-20 shrink-0">
        <img src={attachment.dataUrl} alt={attachment.name} className="w-16 h-16 object-cover rounded-md" />
        <span className="text-[10px] text-ash-300 truncate w-full text-center leading-tight">{attachment.name}</span>
        <button type="button" onClick={onRemove} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-ash-600 hover:bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <X className="w-2.5 h-2.5 text-ash-100" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative group flex items-center gap-2 bg-ash-700 text-ash-300 px-2.5 py-1.5 rounded-lg max-w-[180px]">
      <FileKindIcon kind={kind} />
      <span className="text-xs truncate">{attachment.name}</span>
      <button type="button" onClick={onRemove} className="ml-1 text-ash-500 hover:text-ash-100 shrink-0 transition-colors"><X className="w-3 h-3" /></button>
    </div>
  );
}

export interface MessageComposerProps {
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: React.FormEvent, files: File[]) => void;
  onStop: () => void;
  isProcessing?: boolean;
  kits: Kit[];
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
  files: File[];
  addFiles: (incoming: File[]) => void;
  removeFile: (file: File) => void;
  existingAttachments?: MessageAttachment[];
  onRemoveExistingAttachment?: (index: number) => void;
  isDragging: boolean;
  contextItems: ComposerContextItem[];
  onRemoveContextItem: (id: string) => void;
  composerRef: React.RefObject<QuoteComposerHandle | null>;
  onFocus?: () => void;
  compact?: boolean;
  submitLabel?: string;
  onCancel?: () => void;
}

export function MessageComposer({
  input, setInput, onSubmit, onStop, isProcessing, kits, onToggleKit, skills, onToggleSkill,
  files, addFiles, removeFile, existingAttachments = [], onRemoveExistingAttachment,
  isDragging, contextItems, onRemoveContextItem, composerRef, onFocus, compact = false,
  submitLabel, onCancel,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(Array.from(event.target.files));
  };
  const PASTE_TEXT_THRESHOLD = 500;
  const handlePaste = (event: React.ClipboardEvent) => {
    const items = Array.from(event.clipboardData.items);
    const pastedFiles = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      addFiles(pastedFiles);
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (text && text.length > PASTE_TEXT_THRESHOLD) {
      event.preventDefault();
      addFiles([new File([new Blob([text], { type: 'text/plain' })], 'pasted-text.txt', { type: 'text/plain' })]);
    }
  };
  const handleSubmit = (event: React.FormEvent) => {
    onSubmit(event, files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const hasPayload = !!stripQuoteReferenceTokens(input).trim() || files.length > 0 || existingAttachments.length > 0 || contextItems.length > 0;

  return (
    <form onSubmit={handleSubmit} className={compact ? '' : 'w-full'} onFocus={onFocus}>
      <div className={`relative flex flex-col bg-ash-800 border rounded-xl focus-within:ring-2 focus-within:ring-coral-600 transition-all ${isDragging ? 'border-coral-500 ring-2 ring-coral-500/40' : 'border-ash-700'} ${compact ? '' : 'shadow-lg'}`}>
        {isDragging && <div className="absolute inset-0 rounded-xl bg-coral-500/10 border-2 border-coral-500 border-dashed flex items-center justify-center pointer-events-none z-10"><span className="text-coral-400 text-sm font-medium">Drop files to attach</span></div>}
        {(existingAttachments.length > 0 || files.length > 0) && (
          <div className="flex flex-wrap items-end gap-2 px-4 pt-3">
            {existingAttachments.map((attachment, index) => <ExistingAttachmentChip key={`existing-${index}-${attachment.name}`} attachment={attachment} onRemove={() => onRemoveExistingAttachment?.(index)} />)}
            {files.map((file, index) => <NewAttachmentChip key={`new-${index}-${file.name}`} file={file} onRemove={() => removeFile(file)} />)}
          </div>
        )}
        <QuoteComposer ref={composerRef} value={input} onChange={setInput} items={contextItems} onRemoveItem={onRemoveContextItem} onPaste={handlePaste} onSubmit={() => fileInputRef.current?.form?.requestSubmit()} disabled={isProcessing} onFocus={onFocus} />
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-1">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="p-1.5 text-ash-400 hover:text-ash-200 hover:bg-ash-700 rounded-md transition-colors" title="Attach files"><Paperclip className="w-4 h-4" /></button>
            <KitToggleMenu kits={kits} onToggleKit={onToggleKit} />
            <SkillToggleMenu skills={skills} onToggleSkill={onToggleSkill} />
          </div>
          <div className="flex items-center gap-2">
            {onCancel && <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-ash-700 hover:bg-ash-600 text-ash-200 text-xs rounded-md transition-colors">Cancel</button>}
            {isProcessing ? (
              <button type="button" onClick={onStop} className="p-2 bg-ash-700 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center" title="Stop generation"><Square className="w-4 h-4 fill-current" /></button>
            ) : submitLabel ? (
              <button type="submit" disabled={!hasPayload} className="px-3 py-1.5 bg-coral-500 text-white text-xs rounded-md hover:bg-coral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{submitLabel}</button>
            ) : (
              <button type="submit" disabled={!hasPayload} className="p-2 bg-coral-500 text-white rounded-lg hover:bg-coral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center" title="Send"><Send className="w-4 h-4" /></button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
