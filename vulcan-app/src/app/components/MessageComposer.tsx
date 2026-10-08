import { useEffect, useId, useRef, useState } from 'react';
import { File as FileIcon, FileArchive, FileCode, FileText, Paperclip, Play, Send, Square, X } from 'lucide-react';
import { QuoteComposer, type QuoteComposerHandle } from './QuoteComposer';
import { PASTE_TEXT_THRESHOLD, makePastedTextFile } from '../utils/composerPaste';
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
    default: return <FileIcon className="w-4 h-4 text-ash-400 shrink-0" />;
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
  onSubmit: (event: React.FormEvent, files: File[], mode?: 'steer' | 'queue') => void;
  onStop: () => void;
  onResume?: () => void;
  canResume?: boolean;
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
  input, setInput, onSubmit, onStop, onResume, canResume, isProcessing, kits, onToggleKit, skills, onToggleSkill,
  files, addFiles, removeFile, existingAttachments = [], onRemoveExistingAttachment,
  isDragging, contextItems, onRemoveContextItem, composerRef, onFocus, compact = false,
  submitLabel, onCancel,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionId = useId();
  const [followupChoice, setFollowupChoice] = useState(false);
  const [highlightedChoice, setHighlightedChoice] = useState<'steer' | 'queue' | null>(null);
  const chooseFollowup = (event: React.SyntheticEvent, mode: 'steer' | 'queue') => {
    event.preventDefault();
    setFollowupChoice(false);
    onSubmit(event as React.FormEvent, files, mode);
  };
  useEffect(() => {
    if (!isProcessing) setFollowupChoice(false);
  }, [isProcessing]);
  useEffect(() => {
    if (!followupChoice) return;
    const keydown = (event: KeyboardEvent) => {
      if (!formRef.current?.contains(document.activeElement) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') { event.preventDefault(); setFollowupChoice(false); }
      if (event.key === '1' || event.key === '2') {
        event.preventDefault();
        setFollowupChoice(false);
        onSubmit({ preventDefault() {} } as React.FormEvent, files, event.key === '1' ? 'steer' : 'queue');
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [followupChoice, files, onSubmit]);
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(Array.from(event.target.files));
  };
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
      addFiles([makePastedTextFile(text, files.map((file) => file.name))]);
    }
  };
  const handleSubmit = (event: React.FormEvent) => {
    if (isProcessing && !compact) {
      event.preventDefault();
      if (hasPayload) { setHighlightedChoice(null); setFollowupChoice(true); }
      return;
    }
    onSubmit(event, files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const hasPayload = !!stripQuoteReferenceTokens(input).trim() || files.length > 0 || existingAttachments.length > 0 || contextItems.length > 0;

  return (
    <form ref={formRef} onSubmit={handleSubmit} className={compact ? '' : 'w-full'} onFocus={onFocus}>
      <div className={`relative flex flex-col bg-ash-800 border rounded-xl focus-within:ring-2 focus-within:ring-coral-600 transition-all ${isDragging ? 'border-coral-500 ring-2 ring-coral-500/40' : 'border-ash-700'} ${compact ? '' : 'shadow-lg'}`}>
        {isDragging && <div className="absolute inset-0 rounded-xl bg-coral-500/10 border-2 border-coral-500 border-dashed flex items-center justify-center pointer-events-none z-10"><span className="text-coral-400 text-sm font-medium">Drop files to attach</span></div>}
        {(existingAttachments.length > 0 || files.length > 0) && (
          <div className="flex flex-wrap items-end gap-2 px-4 pt-3">
            {existingAttachments.map((attachment, index) => <ExistingAttachmentChip key={`existing-${index}-${attachment.name}`} attachment={attachment} onRemove={() => onRemoveExistingAttachment?.(index)} />)}
            {files.map((file, index) => <NewAttachmentChip key={`new-${index}-${file.name}`} file={file} onRemove={() => removeFile(file)} />)}
          </div>
        )}
        {followupChoice && <div className="absolute right-3 top-3 z-20 flex gap-1.5" role="group" aria-label="Choose follow-up behavior">
          {(['steer', 'queue'] as const).map((mode, index) => <button key={mode} type="button"
            onMouseEnter={() => setHighlightedChoice(mode)} onMouseLeave={() => setHighlightedChoice(null)}
            onFocus={() => setHighlightedChoice(mode)} onBlur={() => setHighlightedChoice(null)}
            onClick={(event) => chooseFollowup(event, mode)} aria-describedby={highlightedChoice === mode ? descriptionId : undefined}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs transition-colors ${highlightedChoice === mode ? 'border-coral-600 bg-ash-700 text-ash-100' : 'border-ash-600 bg-ash-700 text-ash-300'}`}>
            <kbd className="text-[11px] text-ash-400">{index + 1}</kbd>{mode === 'steer' ? 'Steer' : 'Queue'}
          </button>)}
          {highlightedChoice && <div id={descriptionId} role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+22px)] right-0 w-64 rounded-lg border border-ash-700 bg-ash-900 px-3 py-2.5 text-xs text-ash-200 shadow-xl">
            {highlightedChoice === 'steer' ? 'Update the current task when the current step finishes.' : 'Send this message after the current task finishes.'}
          </div>}
        </div>}
        <div className={followupChoice ? 'pr-[160px]' : ''}><QuoteComposer ref={composerRef} value={input} onChange={setInput} items={contextItems} onRemoveItem={onRemoveContextItem} onPaste={handlePaste} onSubmit={() => fileInputRef.current?.form?.requestSubmit()} disabled={compact && isProcessing} onFocus={onFocus} /></div>
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="p-1.5 text-ash-400 hover:text-ash-200 hover:bg-ash-700 rounded-md transition-colors" title="Attach files"><Paperclip className="w-4 h-4" /></button>
            <KitToggleMenu kits={kits} onToggleKit={onToggleKit} />
            <SkillToggleMenu skills={skills} onToggleSkill={onToggleSkill} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onCancel && <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-ash-700 hover:bg-ash-600 text-ash-200 text-xs rounded-md transition-colors">Cancel</button>}
            {isProcessing ? (
              <button type="button" onClick={onStop} className="p-2 bg-ash-700 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center" title="Stop generation" aria-label="Stop generation"><Square className="w-4 h-4 fill-current" /></button>
            ) : canResume && onResume ? (
              <button type="button" onClick={onResume} className="p-2 bg-ash-700 text-white rounded-lg hover:bg-ash-600 transition-colors flex items-center justify-center" title="Resume generation" aria-label="Resume generation"><Play className="w-4 h-4 fill-current" /></button>
            ) : null}
            {submitLabel ? (
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
