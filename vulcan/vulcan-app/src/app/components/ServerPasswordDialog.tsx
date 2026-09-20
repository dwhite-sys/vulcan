import { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import {
  setServerPasswordPromptHandler,
  type ServerPasswordCredentials,
  type ServerPasswordPrompt,
} from '../services/serverPasswordPrompt';

type Resolver = (credentials: ServerPasswordCredentials) => void;
type Rejecter = (error: Error) => void;

export function ServerPasswordDialog() {
  const [details, setDetails] = useState<ServerPasswordPrompt | null>(null);
  const [resolver, setResolver] = useState<Resolver | null>(null);
  const [rejecter, setRejecter] = useState<Rejecter | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  useEffect(() => setServerPasswordPromptHandler((next) => new Promise<ServerPasswordCredentials>((resolve, reject) => {
    setDetails(next);
    setPassword('');
    setRemember(false);
    setResolver(() => resolve);
    setRejecter(() => reject);
  })), []);

  if (!details || !resolver || !rejecter) return null;

  const cancel = () => {
    rejecter(new Error('Authentication cancelled'));
    setDetails(null);
    setResolver(null);
    setRejecter(null);
    setPassword('');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    resolver({ password, remember: remember && Boolean(details.canRemember), remembered: false });
    setDetails(null);
    setResolver(null);
    setRejecter(null);
    setPassword('');
  };

  return (
    <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6">
      <form onSubmit={submit} className="w-full max-w-[440px] overflow-hidden rounded-[14px] border border-ash-700 bg-ash-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ash-800 px-[22px] py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-coral-500">
              <KeyRound className="h-4.5 w-4.5 text-white" />
            </div>
            <h2 className="text-lg font-semibold text-ash-100">Harness Password Required</h2>
          </div>
          <button type="button" onClick={cancel} className="rounded p-1 text-ash-500 transition-colors hover:bg-ash-800 hover:text-ash-300" aria-label="Cancel authentication">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-[22px] py-5">
          <p className="mb-4 text-sm leading-6 text-ash-300">
            This harness has a server password. Enter it to finish connecting over the encrypted Vulcan session.
          </p>
          <div className="mb-4 rounded-lg border border-ash-700 bg-ash-950/35 px-3.5 py-3 text-sm">
            <span className="text-ash-500">Endpoint</span>
            <span className="ml-4 select-text font-mono text-ash-100">{details.endpoint}</span>
          </div>
          <label className="block text-sm text-ash-300">
            Password
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-2 w-full rounded-lg border border-ash-700 bg-ash-950 px-3 py-2.5 text-ash-100 outline-none transition-colors focus:border-coral-500"
            />
          </label>
          {details.canRemember && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ash-300">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 accent-coral-500"
              />
              Remember password for this server
            </label>
          )}
          {details.error && (
            <div className="mt-3 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
              {details.error}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2.5">
            <button type="button" onClick={cancel} className="rounded-lg border border-ash-700 bg-ash-900 px-4 py-2.5 text-sm text-ash-200 transition-colors hover:bg-ash-800">Cancel</button>
            <button type="submit" disabled={!password} className="rounded-lg border border-coral-500 bg-coral-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-coral-600 disabled:cursor-not-allowed disabled:opacity-50">Connect</button>
          </div>
        </div>

        <div className="border-t border-ash-800 px-[22px] py-3.5 text-xs text-ash-500">
          {details.canRemember
            ? 'Remembered passwords are protected by your device’s secure credential storage.'
            : 'The password is sent only inside this encrypted connection and is not stored on this device.'}
        </div>
      </form>
    </div>
  );
}
