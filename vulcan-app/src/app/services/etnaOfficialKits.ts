import type { ToolResult } from '../types/vulcan';
import { uploadWorkspaceFile } from './vulcan';

const PLAYWRIGHT_KIT_NAME = 'Playwright';
const PLAYWRIGHT_SCREENSHOT_TOOL = 'browser_screenshot';

export function isOfficialPlaywrightScreenshot(kitName: string | undefined, toolName: string): boolean {
  return kitName === PLAYWRIGHT_KIT_NAME && toolName === PLAYWRIGHT_SCREENSHOT_TOOL;
}

export function prepareOfficialEtnaArguments(
  kitName: string | undefined,
  toolName: string,
  args: Record<string, any>,
): Record<string, any> {
  // Vulcan needs the bytes because Etna/Chrome lives on the host while the model's
  // workspace lives in the per-chat container. Do not rely on Etna's host save_path.
  if (isOfficialPlaywrightScreenshot(kitName, toolName)) {
    return { ...args, save_path: `/tmp/vulcan-playwright-${Date.now()}.png`, return_base64: true };
  }
  return args;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeFragment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'shot';
}

export function playwrightScreenshotWorkspacePath(toolCallId: string, requestedSavePath?: string, now = Date.now()): string {
  const requested = String(requestedSavePath ?? '').trim().replace(/\\/g, '/');
  const relative = requested.startsWith('/workspace/') ? requested.slice('/workspace/'.length) : requested;
  if (relative && !relative.startsWith('/') && !relative.endsWith('/')
      && !relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    return relative;
  }
  return `screenshots/playwright-${now}-${safeFragment(toolCallId)}.png`;
}

export async function materializeOfficialPlaywrightScreenshot(
  chatId: string,
  toolCallId: string,
  result: ToolResult,
  requestedSavePath?: string,
): Promise<ToolResult> {
  const payload = result?.result;
  if (!payload || typeof payload !== 'object' || typeof payload.png_base64 !== 'string' || !payload.png_base64) {
    return result;
  }

  const bytes = decodeBase64(payload.png_base64);
  const workspacePath = playwrightScreenshotWorkspacePath(toolCallId, requestedSavePath);
  const file = new File([bytes], workspacePath.split('/').pop() || 'screenshot.png', { type: 'image/png' });
  const storedPath = await uploadWorkspaceFile(chatId, file, workspacePath, {
    transferId: `playwright-screenshot:${chatId}:${toolCallId}`,
    silent: true,
  });

  // Never persist or send the base64 blob through the transcript/model history.
  // The original PNG now exists as an ordinary workspace file, which the model can
  // inspect with the normal workspace/view_file flow when it needs visual context.
  const { png_base64: _discarded, ...clean } = payload;
  return {
    ...result,
    result: {
      ...clean,
      saved_to: `/workspace/${storedPath.replace(/^\/+/, '')}`,
      workspace_path: storedPath,
    },
  };
}
