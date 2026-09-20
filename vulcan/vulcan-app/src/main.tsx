import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import { installConnectionLifecycle } from "./app/services/connectionLifecycle.ts";
import { installModelVisionCatalogRefresh } from "./app/services/modelVision.ts";
import "./styles/index.css";

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Vulcan renderer crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      const stack = this.state.error.stack || this.state.error.message || String(this.state.error);
      return (
        <div style={{ minHeight: '100vh', background: '#1f1f1f', color: '#ddd', padding: 24, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          <h1 style={{ margin: '0 0 12px', fontFamily: 'system-ui, sans-serif', fontSize: 18 }}>Vulcan renderer error</h1>
          <p style={{ color: '#aaa', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>The renderer hit an uncaught UI error instead of falling through to a blank grey screen.</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: '#181818', border: '1px solid #3a3a3a', borderRadius: 8, padding: 12, fontSize: 11 }}>{stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

installConnectionLifecycle();
installModelVisionCatalogRefresh();

createRoot(document.getElementById("root")!).render(
  <RendererErrorBoundary>
    <App />
  </RendererErrorBoundary>,
);
