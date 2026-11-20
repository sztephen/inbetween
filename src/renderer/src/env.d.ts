import type { InbetweenApi } from '../../shared/api'
declare global {
  interface Window {
    inbetween: InbetweenApi & { onToast(fn: (t: { message: string; kind: string }) => void): () => void; ready(): void }
  }
}
export {}
