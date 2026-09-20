import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Maximize2, RotateCcw, AlertTriangle } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { readFileBase64 } from '../services/vulcan';

interface ImageViewerProps {
  chatId: string;
  path: string;
}

interface ImageDimensions {
  width: number;
  height: number;
}

export function ImageViewer({ chatId, path }: ImageViewerProps) {
  const filename = path.split('/').pop() ?? path;
  const [dataUrl, setDataUrl] = useState<string>('');
  const [mimeType, setMimeType] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDataUrl('');
    setDimensions(null);

    void readFileBase64(chatId, path)
      .then(({ base64, mimeType: nextMimeType }) => {
        if (cancelled) return;
        setMimeType(nextMimeType);
        setDataUrl(`data:${nextMimeType};base64,${base64}`);
      })
      .catch((reason) => {
        if (cancelled) return;
        console.error('[ImageViewer] Load failed:', reason);
        setError(reason instanceof Error ? reason.message : 'Unable to load image');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [chatId, path]);

  const meta = useMemo(() => {
    const parts: string[] = [];
    if (mimeType) parts.push(mimeType.replace(/^image\//, '').replace('SVG+XML', 'SVG').toUpperCase());
    if (dimensions) parts.push(`${dimensions.width} × ${dimensions.height}`);
    return parts.join(' · ');
  }, [dimensions, mimeType]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-ash-950 text-xs text-ash-500">
        Loading image…
      </div>
    );
  }

  if (error || !dataUrl) {
    return (
      <div className="h-full flex items-center justify-center bg-ash-950 p-6">
        <div className="max-w-sm rounded-lg border border-ash-800 bg-ash-900 px-4 py-3 text-xs text-ash-400">
          <div className="flex items-center gap-2 text-ash-200 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-coral-400" />
            Unable to preview image
          </div>
          <div className="font-mono text-ash-500 truncate">{filename}</div>
          {error && <div className="mt-2 text-ash-600">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <TransformWrapper
      initialScale={1}
      minScale={0.1}
      maxScale={8}
      centerOnInit
      limitToBounds={false}
      onTransformed={(_ref, state) => setScale(state.scale)}
    >
      {({ zoomIn, zoomOut, resetTransform, centerView }) => (
        <div className="h-full min-h-0 flex flex-col bg-ash-950" data-vulcan-image-viewer={path}>
          <div className="h-9 flex-shrink-0 border-b border-ash-800 bg-ash-900 px-3 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-baseline gap-2">
              {meta && <span className="text-[10px] font-mono text-ash-500 whitespace-nowrap">{meta}</span>}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0 text-ash-400">
              <button
                type="button"
                onClick={() => zoomOut(0.2)}
                className="w-7 h-7 grid place-items-center rounded-md hover:bg-ash-800 hover:text-ash-200 transition-colors"
                title="Zoom out"
                aria-label="Zoom out"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => resetTransform(180)}
                className="h-7 min-w-[52px] px-2 rounded-md font-mono text-[10px] hover:bg-ash-800 hover:text-ash-200 transition-colors"
                title="Reset zoom"
                aria-label="Reset zoom"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                onClick={() => zoomIn(0.2)}
                className="w-7 h-7 grid place-items-center rounded-md hover:bg-ash-800 hover:text-ash-200 transition-colors"
                title="Zoom in"
                aria-label="Zoom in"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <div className="w-px h-4 bg-ash-800 mx-1" />
              <button
                type="button"
                onClick={() => centerView(1, 180)}
                className="w-7 h-7 grid place-items-center rounded-md hover:bg-ash-800 hover:text-ash-200 transition-colors"
                title="Fit and center"
                aria-label="Fit and center"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => resetTransform(180)}
                className="w-7 h-7 grid place-items-center rounded-md hover:bg-ash-800 hover:text-ash-200 transition-colors"
                title="Reset view"
                aria-label="Reset view"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div
            className="relative flex-1 min-h-0 overflow-hidden bg-ash-950"
            style={{
              backgroundImage:
                'linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.025) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.025) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.025) 75%)',
              backgroundSize: '18px 18px',
              backgroundPosition: '0 0, 0 9px, 9px -9px, -9px 0px',
            }}
          >
            <TransformComponent
              wrapperStyle={{ width: '100%', height: '100%' }}
              contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <img
                src={dataUrl}
                alt={filename}
                draggable={false}
                onLoad={(event) => {
                  setDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
                className="block max-w-full max-h-full object-contain select-none shadow-[0_10px_36px_rgba(0,0,0,0.28)]"
              />
            </TransformComponent>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none rounded-full border border-ash-800 bg-ash-900/85 px-2.5 py-1 text-[9px] text-ash-600 backdrop-blur-sm">
              Scroll to zoom · drag to pan
            </div>
          </div>
        </div>
      )}
    </TransformWrapper>
  );
}
