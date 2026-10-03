import type { DocAsset } from './scope-doc.js'
export function parseMediaFence(source: string, assets?: Record<string, DocAsset>, assetBase?: string, type?: DocAsset['type']): {
  values: Record<string, string>; src: string; height: number; allow: string; sandbox: string;
  mediaUrl(value: string | undefined, type: DocAsset['type']): string;
}
