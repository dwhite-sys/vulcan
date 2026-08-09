---
name: dashboard-authoring
description: Guidance for building Vulcan dashboards. Read this when building anything non-trivial — especially a dashboard that talks to a service running in the chat's workspace container, needs live data, or where getting the JS architecture wrong would mean rebuilding rather than tweaking.
---

# Dashboard Authoring

Dashboards are persistent HTML/CSS/JS panels that live in the workspace sidebar. They're built with `dashboard_create`, refined with `dashboard_update`, and handed to the user with `open_dashboard`. Build it right, then open it — the user sees a finished thing, not a work in progress.

## Container access

Dashboard JavaScript can reach HTTP and WebSocket services running inside the **same chat's workspace container** through Vulcan's existing container proxy. Vulcan injects a very small `window.vulcan` helper before dashboard JS runs:

```js
window.vulcan.chatId
window.vulcan.container
window.vulcan.proxyUrl(port, path)
window.vulcan.proxyWsUrl(port, path)
```

For HTTP:

```js
const res = await fetch(window.vulcan.proxyUrl(8000, '/api/data'));
const data = await res.json();
```

For WebSockets:

```js
const ws = new WebSocket(window.vulcan.proxyWsUrl(8000, '/ws'));
```

The proxy routes only to services running in this chat's Docker container. A dashboard does **not** get a general bridge into the Vulcan host, Etna, the workspace filesystem, other chats, or the global container.

If a dashboard needs live information, prefer starting a small HTTP/WebSocket service in the workspace container and have the dashboard talk to that service through the proxy. This keeps the dashboard boundary simple and explicit.

## Dashboard anatomy

Three fields: `html`, `css`, `js`. Keep JS self-contained — no ES module imports, no bundlers. CDN scripts via `<script src>` in the HTML are fine.

```js
dashboard_create({
  name: "my-dashboard",
  html: `<div id="output">Loading...</div><button id="refresh">Refresh</button>`,
  css: `body { background: #18181b; color: #e4e4e7; font-family: sans-serif; padding: 8px; }`,
  js: `
    async function refresh() {
      const res = await fetch(window.vulcan.proxyUrl(8000, '/status'));
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

**Live data over placeholders.** If the dashboard can show real values from a service in the workspace container, use the container proxy rather than hardcoding fake values.

**Buttons do real things.** A Refresh button should actually refetch data. Controls should call the service they represent rather than being decorative.

## Updating a dashboard

Use `dashboard_update` to replace one or more parts without rebuilding. Read with `dashboard_inspect` first if you're not sure what's currently there. The dashboard reloads in the sidebar automatically after an update.
