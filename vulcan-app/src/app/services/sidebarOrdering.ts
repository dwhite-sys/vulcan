import type { Chat, ChatFolder } from '../types/vulcan';

/**
 * Effective folder recency is the newest chat anywhere beneath the folder.
 * Empty folders use their creation timestamp so newly-created empty folders still
 * have a deterministic position among other folders.
 */
export function buildFolderRecency(chats: Chat[], folders: ChatFolder[]): Map<string, Date> {
  const result = new Map<string, Date>();
  const calculating = new Set<string>();

  const calculate = (folderId: string): Date => {
    const cached = result.get(folderId);
    if (cached) return cached;

    const folder = folders.find((candidate) => candidate.id === folderId);
    const fallback = new Date(folder?.createdAt ?? 0);
    if (calculating.has(folderId)) return fallback;
    calculating.add(folderId);

    let latest = fallback;
    for (const chat of chats) {
      if ((chat.folderId ?? null) !== folderId) continue;
      const timestamp = new Date(chat.updatedAt);
      if (timestamp > latest) latest = timestamp;
    }
    for (const child of folders) {
      if ((child.parentId ?? null) !== folderId) continue;
      const timestamp = calculate(child.id);
      if (timestamp > latest) latest = timestamp;
    }

    calculating.delete(folderId);
    result.set(folderId, latest);
    return latest;
  };

  folders.forEach((folder) => calculate(folder.id));
  return result;
}

export function directChatsByRecency(chats: Chat[], parentId: string | null): Chat[] {
  return chats
    .filter((chat) => (chat.folderId ?? null) === parentId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function directFoldersByRecency(
  folders: ChatFolder[],
  parentId: string | null,
  folderRecency: Map<string, Date>,
): ChatFolder[] {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => {
      const recencyDelta = (folderRecency.get(b.id)?.getTime() ?? 0) - (folderRecency.get(a.id)?.getTime() ?? 0);
      if (recencyDelta !== 0) return recencyDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
}

/** Preserve matching chats and every folder needed to keep their hierarchy visible. */
export function filterSidebarByQuery(
  chats: Chat[],
  folders: ChatFolder[],
  query: string,
  contentMatchedChatIds: ReadonlySet<string> = new Set(),
): { chats: Chat[]; folders: ChatFolder[] } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { chats, folders };

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const matchingFolders = new Set(
    folders.filter((folder) => words.every((word) => folder.name.toLowerCase().includes(word)))
      .map((folder) => folder.id),
  );
  const ancestorMatches = (folderId: string | null | undefined): boolean => {
    const visited = new Set<string>();
    let current = folderId;
    while (current && !visited.has(current)) {
      if (matchingFolders.has(current)) return true;
      visited.add(current);
      current = byId.get(current)?.parentId;
    }
    return false;
  };
  const visibleChats = chats.filter((chat) => {
    const searchable = `${chat.title ?? ''} ${(chat.tags ?? []).join(' ')}`.toLowerCase();
    return words.every((word) => searchable.includes(word))
      || contentMatchedChatIds.has(chat.id)
      || ancestorMatches(chat.folderId);
  });

  const visibleFolderIds = new Set<string>(matchingFolders);
  const addAncestors = (folderId: string | null | undefined): void => {
    const visited = new Set<string>();
    let current = folderId;
    while (current && !visited.has(current)) {
      visited.add(current);
      visibleFolderIds.add(current);
      current = byId.get(current)?.parentId;
    }
  };
  visibleChats.forEach((chat) => addAncestors(chat.folderId));
  matchingFolders.forEach(addAncestors);

  return {
    chats: visibleChats,
    folders: folders.filter((folder) => visibleFolderIds.has(folder.id)),
  };
}
