export type ServerPasswordPrompt = {
  endpoint: string;
  error?: string;
};

type PasswordPromptHandler = (details: ServerPasswordPrompt) => Promise<string>;

let handler: PasswordPromptHandler | null = null;
let waiter: ((next: PasswordPromptHandler) => void) | null = null;

export function setServerPasswordPromptHandler(next: PasswordPromptHandler | null) {
  handler = next;
  if (handler && waiter) {
    waiter(handler);
    waiter = null;
  }
  return () => {
    if (handler === next) handler = null;
  };
}

async function waitForHandler(): Promise<PasswordPromptHandler> {
  if (handler) return handler;
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export async function requestServerPassword(details: ServerPasswordPrompt): Promise<string> {
  const current = await waitForHandler();
  return current(details);
}
