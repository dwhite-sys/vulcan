export const PASTE_TEXT_THRESHOLD = 500;

export function nextPastedTextFilename(existingNames: Iterable<string>): string {
  const used = new Set(existingNames);
  if (!used.has('pasted-text.txt')) return 'pasted-text.txt';
  let index = 2;
  while (used.has(`pasted-text-${index}.txt`)) index += 1;
  return `pasted-text-${index}.txt`;
}

export function makePastedTextFile(text: string, existingNames: Iterable<string>): File {
  return new File([text], nextPastedTextFilename(existingNames), { type: 'text/plain' });
}
