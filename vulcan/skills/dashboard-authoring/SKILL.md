---
name: dashboard-authoring
description: Guidance for building Vulcan dashboards. Read this when building anything non-trivial — especially a dashboard that talks to a service running in the chat's workspace container, needs live data, or where getting the JS architecture wrong would mean rebuilding rather than tweaking.
---

# Dashboard Authoring

Dashboards are persistent HTML/CSS/JS panels that live in the workspace sidebar. They're built with `dashboard_create`, refined with `dashboard_update`, and handed to the user with `open_dashboard`. Build it right, then open it — the user sees a finished thing, not a work in progress.

## Workspace services

Chat containers share the Vulcan host's network, so a service started in the workspace uses the same ports as the host and other chats. Bind to `127.0.0.1` unless the user specifically needs the service exposed directly on the network:

```bash
python3 -m http.server 8600 --bind 127.0.0.1
```

Vulcan injects `window.vulcan` before dashboard JavaScript runs. Use its HTTP and WebSocket helpers to reach the service:

```js
const response = await window.vulcan.fetch(8600, '/api/data');
const data = await response.json();

const socket = window.vulcan.websocket(8600, '/events');
```

These helpers route through the connected Vulcan server to host loopback, so they work unchanged for local and remote clients. Never hardcode browser `localhost`: for a remote client, that resolves to the user's device rather than the Vulcan host.

For an API that requires a URL instead of a fetch or socket, use:

```js
window.vulcan.serviceUrl(8600, '/bundle.js')
window.vulcan.serviceWsUrl(8600, '/events')
```

`proxyUrl` and `proxyWsUrl` remain compatible aliases; `window.vulcan.chatId` identifies the current chat. Choose an unused host port and only connect to services intended for the dashboard. Shared host networking does not isolate ports between chats.

## Dashboard anatomy

Three fields: `html`, `css`, `js`. Keep JS self-contained — no ES module imports, no bundlers. CDN scripts via `<script src>` in the HTML are fine.

```js
dashboard_create({
  name: "my-dashboard",
  html: `<div id="output">Loading...</div><button id="refresh">Refresh</button>`,
  css: `body { background: #18181b; color: #e4e4e7; font-family: sans-serif; padding: 8px; }`,
  js: `
    async function refresh() {
      const res = await window.vulcan.fetch(8000, '/status');
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      const data = await res.json();
      document.getElementById('output').textContent = JSON.stringify(data, null, 2);
    }
    document.getElementById('refresh').addEventListener('click', () => refresh().catch(showError));
    function showError(error) {
      document.getElementById('output').textContent = String(error?.message ?? error);
    }
    refresh().catch(showError);
  `
})
```

## Design principles

**Dark theme.** Vulcan's UI is dark. Base background `#18181b`, text `#e4e4e7`. Accents in slate, blue, or coral tones.

**Show loading states.** If the dashboard fetches on load, show a loading indicator immediately. Don't leave it blank while waiting.

**Handle errors.** Wrap network calls in try/catch and show an error state — don't fail silently.

**Live data over placeholders.** If the dashboard can show real values from a workspace service, connect through `window.vulcan.fetch` or `window.vulcan.websocket` rather than hardcoding fake values.

**Buttons do real things.** A Refresh button should actually refetch data. Controls should call the service they represent rather than being decorative.

## Updating a dashboard

Use `dashboard_update` to replace one part per call without rebuilding. Read with `dashboard_inspect` first if you're not sure what's currently there. The dashboard reloads in the sidebar automatically after an update.
