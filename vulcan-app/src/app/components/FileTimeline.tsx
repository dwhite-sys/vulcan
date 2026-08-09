import { useEffect, useState } from 'react';
import { GitBranch, Camera, ChevronRight } from 'lucide-react';
import type { TimelineEntry } from '../types/vulcan';
import { getTimeline } from '../services/vulcan';

interface FileTimelineProps {
  chatId: string;
  path: string;
  onSelectEntry: (entry: TimelineEntry) => void;
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function FileTimeline({ chatId, path, onSelectEntry }: FileTimelineProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getTimeline(chatId, path)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [chatId, path]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-ash-500">
        Loading history…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-ash-500">
        No history yet
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-y-auto">
      {entries.map((entry, idx) => {
        const isCommit = entry.kind === 'commit';
        const timestamp = isCommit ? entry.commit.timestamp : entry.snapshot.timestamp;
        const label = isCommit ? entry.commit.message : `Autosave`;
        const author = isCommit ? entry.commit.author : entry.snapshot.source;
        const shortId = isCommit ? entry.commit.shortHash : entry.snapshot.id.slice(0, 7);

        return (
          <button
            key={idx}
            onClick={() => onSelectEntry(entry)}
            className="flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-ash-800/60 transition-colors group border-b border-ash-800/50 last:border-0"
          >
            <div className="flex-shrink-0 mt-0.5">
              {isCommit
                ? <GitBranch className="w-3.5 h-3.5 text-coral-400" />
                : <Camera className="w-3.5 h-3.5 text-ash-500" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-ash-200 truncate leading-snug">{label}</p>
              <p className="text-xs text-ash-500 mt-0.5">
                <span className={author === 'agent' ? 'text-green-500' : 'text-coral-400'}>
                  {author === 'agent' ? 'Agent' : 'You'}
                </span>
                {' · '}
                <span className="font-mono">{shortId}</span>
                {' · '}
                {formatRelativeTime(timestamp)}
              </p>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-ash-600 group-hover:text-ash-400 flex-shrink-0 mt-0.5 transition-colors" />
          </button>
        );
      })}
    </div>
  );
}
