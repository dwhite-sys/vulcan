const KEY = 'vulcan:endpoint';
const DEFAULT_ENDPOINT = 'http://localhost:8468';

export function getVulcanBaseUrl(): string {
  try { return localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY) as string) : DEFAULT_ENDPOINT; }
  catch { return DEFAULT_ENDPOINT; }
}

export function getVulcanWsBaseUrl(): string {
  const url = new URL(getVulcanBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}
