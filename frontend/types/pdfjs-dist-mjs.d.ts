/** Worker entry used to populate `globalThis.pdfjsWorker` so pdf.js skips `import(workerSrc)` on Node. */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

/** Dynamic import target used in Node OCR path (see next.config serverComponentsExternalPackages). */
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src?: unknown): {
    promise: Promise<{
      numPages: number;
      getPage: (i: number) => Promise<{
        getViewport: (opts: { scale: number }) => { width: number; height: number };
        render: (opts: {
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
        cleanup: () => Promise<void>;
      }>;
      destroy: () => Promise<void>;
    }>;
  };
}
