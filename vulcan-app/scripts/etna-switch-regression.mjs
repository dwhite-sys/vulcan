import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/app/components/SettingsDialog.tsx', import.meta.url), 'utf8');

const required = [
  "className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${",
  "server.enabled ? 'bg-coral-500' : 'bg-ash-700'",
  "absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform",
  "server.enabled ? 'translate-x-5' : 'translate-x-0'",
  'aria-pressed={server.enabled}',
  'onClick={() => void toggleEtnaServerEnabled(server)}',
];

for (const needle of required) {
  if (!source.includes(needle)) {
    throw new Error(`Etna Settings switch regression: missing ${needle}`);
  }
}

const forbidden = ["w-9 shrink-0", "translate-x-[18px]", "translate-x-0.5"];
for (const needle of forbidden) {
  if (source.includes(needle)) {
    throw new Error(`Etna Settings switch regression: stale bespoke geometry remains: ${needle}`);
  }
}

console.log('Etna Settings switch regression passed.');
