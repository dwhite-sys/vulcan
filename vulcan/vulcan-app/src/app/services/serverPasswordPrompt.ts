import { getServerCredentialStore } from './serverCredentialStore';

export type ServerPasswordPrompt = {
  endpoint: string;
  error?: string;
  canRemember?: boolean;
};

export type ServerPasswordCredentials = {
  password: string;
  remember: boolean;
  remembered: boolean;
};

type PasswordPromptHandler = (details: ServerPasswordPrompt) => Promise<ServerPasswordCredentials>;

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

export async function requestServerPassword(details: ServerPasswordPrompt): Promise<ServerPasswordCredentials> {
  const store = getServerCredentialStore();
  let canRemember = false;
  if (store) {
    try {
      canRemember = await store.isAvailable();
      if (canRemember && !details.error) {
        const password = await store.get(details.endpoint);
        if (password) return { password, remember: true, remembered: true };
      }
    } catch {
      canRemember = false;
    }
  }
  const current = await waitForHandler();
  return current({ ...details, canRemember });
}

export async function confirmServerPassword(endpoint: string, credentials: ServerPasswordCredentials): Promise<void> {
  if (!credentials.remember || credentials.remembered) return;
  try {
    const store = getServerCredentialStore();
    if (store && await store.isAvailable()) await store.set(endpoint, credentials.password);
  } catch {
    // A keyring outage must not turn an already successful server login into a failure.
  }
}

export async function rejectServerPassword(endpoint: string, credentials: ServerPasswordCredentials): Promise<void> {
  if (!credentials.remembered) return;
  try {
    await getServerCredentialStore()?.remove(endpoint);
  } catch {
    // Still present the manual password prompt when a native credential cannot be removed.
  }
}
