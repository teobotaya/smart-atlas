import { App, TFile } from "obsidian";
import { cosine, unit } from "./math";

export interface AtlasHit { path: string; title: string; score: number; excerpt?: string; }
export interface AtlasPoint { path: string; title: string; vec: Float32Array; }

export type EngineId = "smart-connections" | "local";

export interface BridgeOptions {
  maxNodes: number;
  excluded: string[];
  minScore: number;
}

const STOP = new Set(
  ("de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual sea poco ella estar haber estas estaba estamos algunas algo nosotros " +
    "the of and to in a is it that for on with as was be by this are from or an at not have has had but they their which you we can will all")
    .split(" ")
);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 2 && t.length < 24 && !STOP.has(t) && !/^\d+$/.test(t));

/**
 * Single entry point to the semantic layer.
 * Prefers the Smart Connections environment; falls back to an in-memory TF-IDF index
 * so every feature still works on a vault without embeddings.
 */
export class SmartBridge {
  engine: EngineId = "local";
  indexedAt = 0;
  private index = new Map<string, Float32Array>();
  private titles = new Map<string, string>();
  private terms = new Map<string, string[]>();
  private building: Promise<void> | null = null;

  constructor(private app: App, private opts: () => BridgeOptions) {}

  private env(): any {
    const anyApp = this.app as any;
    const plugin = anyApp.plugins?.plugins?.["smart-connections"];
    const env = plugin?.env ?? plugin?.smart_env ?? (window as any).smart_env;
    return env?.smart_sources ? env : null;
  }

  detect(): EngineId {
    this.engine = this.env() ? "smart-connections" : "local";
    return this.engine;
  }

  get sourceCount(): number {
    const env = this.env();
    if (env) return Object.keys(env.smart_sources?.items ?? {}).length;
    return this.index.size;
  }

  private excluded(path: string): boolean {
    return this.opts().excluded.some((p) => p && path.startsWith(p));
  }

  private files(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => !this.excluded(f.path));
  }

  private static normalize(raw: any): AtlasHit | null {
    const item = raw?.item ?? raw;
    const path: string | undefined = item?.path ?? item?.key ?? item?.data?.path;
    if (!path) return null;
    const score = raw?.score ?? raw?.sim ?? item?.score ?? 0;
    return { path, title: path.split("/").pop()!.replace(/\.md$/, ""), score: Number(score) || 0 };
  }

  /** Semantic search for free-form text. */
  async lookup(query: string, limit: number): Promise<AtlasHit[]> {
    if (!query.trim()) return [];
    const env = this.env();
    if (env) {
      try {
        const raw = await env.smart_sources.lookup({ hypotheticals: [query], filter: { limit } });
        const hits = (Array.isArray(raw) ? raw : Object.values(raw ?? {}))
          .map((r: any) => SmartBridge.normalize(r))
          .filter((h): h is AtlasHit => !!h && !this.excluded(h.path));
        if (hits.length) return hits.slice(0, limit);
      } catch (e) {
        console.error("[smart-atlas] Smart Connections lookup failed, using local index", e);
      }
    }
    await this.build();
    const q = this.embedQuery(query);
    return this.rank(q, limit, null);
  }

  /** Notes semantically closest to a given file. */
  async connections(file: TFile, limit: number): Promise<AtlasHit[]> {
    const env = this.env();
    if (env) {
      try {
        const source = env.smart_sources.get?.(file.path) ?? env.smart_sources.items?.[file.path];
        const raw = await source?.find_connections?.({ filter: { limit } });
        const hits = (Array.isArray(raw) ? raw : Object.values(raw ?? {}))
          .map((r: any) => SmartBridge.normalize(r))
          .filter((h): h is AtlasHit => !!h && h.path !== file.path && !this.excluded(h.path));
        if (hits.length) return hits.slice(0, limit);
      } catch (e) {
        console.error("[smart-atlas] Smart Connections connections failed, using local index", e);
      }
    }
    await this.build();
    const v = this.index.get(file.path);
    if (!v) return [];
    return this.rank(v, limit, file.path);
  }

  /** Embedding cloud used by the map view. */
  async points(): Promise<AtlasPoint[]> {
    const { maxNodes } = this.opts();
    const env = this.env();
    if (env) {
      const items: any[] = Object.values(env.smart_sources.items ?? {});
      const pts = items
        .map((it) => {
          const path: string = it?.path ?? it?.key ?? "";
          const vec: number[] | undefined = it?.vec ?? it?.data?.embeddings?.[it?.embed_model_key]?.vec;
          if (!path || !vec?.length || this.excluded(path)) return null;
          return { path, title: path.split("/").pop()!.replace(/\.md$/, ""), vec: unit(vec) };
        })
        .filter((p): p is AtlasPoint => !!p);
      if (pts.length > 1) return pts.slice(0, maxNodes);
    }
    await this.build();
    return [...this.index.entries()]
      .slice(0, maxNodes)
      .map(([path, vec]) => ({ path, title: this.titles.get(path) ?? path, vec }));
  }

  /** Most frequent terms of a note, used to label clusters. */
  labelFor(paths: string[]): string {
    const freq = new Map<string, number>();
    for (const p of paths) {
      const source = this.terms.get(p) ?? tokenize(this.titles.get(p) ?? p.replace(/[/_.-]/g, " "));
      for (const t of source.slice(0, 40)) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
    return top.length ? top.join(" · ") : "sin etiqueta";
  }

  private rank(query: Float32Array, limit: number, exclude: string | null): AtlasHit[] {
    const { minScore } = this.opts();
    const out: AtlasHit[] = [];
    for (const [path, vec] of this.index) {
      if (path === exclude) continue;
      const score = cosine(query, vec);
      if (score < minScore) continue;
      out.push({ path, title: this.titles.get(path) ?? path, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private embedQuery(query: string): Float32Array {
    const v = new Float32Array(this.vocab.length);
    for (const t of tokenize(query)) {
      const i = this.vocabIndex.get(t);
      if (i !== undefined) v[i] += this.idf[i];
    }
    return unit(v);
  }

  private vocab: string[] = [];
  private vocabIndex = new Map<string, number>();
  private idf: Float32Array = new Float32Array();

  invalidate(): void {
    this.index.clear();
    this.building = null;
    this.indexedAt = 0;
  }

  /** Builds the local TF-IDF index (idempotent, deduplicated across callers). */
  async build(force = false): Promise<void> {
    if (force) this.invalidate();
    if (this.index.size && !force) return;
    if (this.building) return this.building;
    this.building = (async () => {
      const files = this.files();
      const docs: { path: string; counts: Map<string, number> }[] = [];
      const df = new Map<string, number>();
      for (const file of files) {
        const text = await this.app.vault.cachedRead(file);
        const tokens = tokenize(`${file.basename} ${file.basename} ${text}`);
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
        for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
        docs.push({ path: file.path, counts });
        this.titles.set(file.path, file.basename);
        this.terms.set(
          file.path,
          [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
        );
      }
      const n = docs.length || 1;
      this.vocab = [...df.entries()]
        .filter(([, c]) => c >= Math.min(2, n) && c <= n * 0.8)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4096)
        .map(([t]) => t);
      this.vocabIndex = new Map(this.vocab.map((t, i) => [t, i]));
      this.idf = new Float32Array(this.vocab.length);
      this.vocab.forEach((t, i) => (this.idf[i] = Math.log(1 + n / (df.get(t) ?? 1))));
      this.index.clear();
      for (const doc of docs) {
        const v = new Float32Array(this.vocab.length);
        for (const [t, c] of doc.counts) {
          const i = this.vocabIndex.get(t);
          if (i !== undefined) v[i] = (1 + Math.log(c)) * this.idf[i];
        }
        this.index.set(doc.path, unit(v));
      }
      this.indexedAt = Date.now();
      this.building = null;
    })();
    return this.building;
  }
}
