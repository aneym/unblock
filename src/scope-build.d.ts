export interface BuildPiece { id: string; label: string; deps: string[]; p50_min: number; p90_min: number; runs_on: string; scenario: boolean }
export interface BuildActual { p50_min?: number; p90_min?: number; actual_min?: number }
export interface BuildPlan {
  columns: BuildPiece[][]; critical: string[]; over: Record<string, number>; actuals: Record<string, number>
  total: { p50_min: number; p90_min: number; actual_min: number | undefined; known: number; count: number }
}
export function parseBuild(source: string): { pieces: BuildPiece[]; errors: string[] }
export function actualsByPiece(rows: unknown): Record<string, BuildActual>
export function planBuild(pieces: BuildPiece[], actuals?: Record<string, BuildActual>): BuildPlan
export function buildFences(markdown: string): string[]
export function buildDocError(sections: unknown): string
export function formatMinutes(value: number): string
export function formatRange(low: number, high: number): string
