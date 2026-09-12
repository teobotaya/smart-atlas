import { ItemView, WorkspaceLeaf, setIcon, debounce } from "obsidian";
import type SmartAtlasPlugin from "../main";
import { AtlasPoint } from "../bridge";
import { cosine, fitToBox, kmeans, pca2, randomProject, relax } from "../math";
import { PALETTES } from "../settings";

export const VIEW_ATLAS = "smart-atlas-map";

const NS = "http://www.w3.org/2000/svg";

function sv<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

interface Edge { a: number; b: number; w: number; }

export class AtlasView extends ItemView {
  private points: AtlasPoint[] = [];
  private xy: [number, number][] = [];
  private cluster: number[] = [];
  private edges: Edge[] = [];
  private degree: number[] = [];

  private svg!: SVGSVGElement;
  private root!: SVGGElement;
  private edgeLayer!: SVGGElement;
  private nodeLayer!: SVGGElement;
  private legendEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private tooltip!: HTMLElement;
  private canvas!: HTMLElement;

  private nodeEls: SVGGElement[] = [];
  private adjacency: number[][] = [];
  private view = { x: 0, y: 0, k: 1 };
  private query = "";
  private busy = false;
  private floor = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: SmartAtlasPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_ATLAS; }
  getDisplayText(): string { return "Smart Atlas"; }
  getIcon(): string { return "compass"; }

  async onOpen(): Promise<void> {
    this.build();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private build(): void {
    const host = this.contentEl;
    host.empty();
    host.addClass("sa-view");

    const bar = host.createDiv({ cls: "sa-toolbar" });
    const search = bar.createEl("input", { cls: "sa-toolbar__search", attr: { type: "text", placeholder: "Filtrar notas…" } });
    search.addEventListener(
      "input",
      debounce(() => { this.query = search.value.toLowerCase().trim(); this.paintHighlight(); }, 120, true)
    );

    const mkBtn = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl("button", { cls: "sa-toolbar__btn", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    mkBtn("refresh-cw", "Recalcular", () => this.refresh(true));
    mkBtn("maximize", "Ajustar a la vista", () => { this.view = { x: 0, y: 0, k: 1 }; this.applyTransform(); });
    mkBtn("search", "Explorador semántico", () => this.plugin.openExplorer());

    this.canvas = host.createDiv({ cls: "sa-canvas" });
    this.svg = sv(this.canvas, "svg", { class: "sa-svg", width: "100%", height: "100%" });
    const defs = sv(this.svg, "defs");
    const glow = sv(defs, "filter", { id: "sa-glow", x: "-60%", y: "-60%", width: "220%", height: "220%" });
    sv(glow, "feGaussianBlur", { stdDeviation: "4", result: "b" });
    const merge = sv(glow, "feMerge");
    sv(merge, "feMergeNode", { in: "b" });
    sv(merge, "feMergeNode", { in: "SourceGraphic" });

    this.root = sv(this.svg, "g", { class: "sa-root" });
    this.edgeLayer = sv(this.root, "g", { class: "sa-edges" });
    this.nodeLayer = sv(this.root, "g", { class: "sa-nodes" });

    this.tooltip = this.canvas.createDiv({ cls: "sa-tooltip" });
    this.legendEl = host.createDiv({ cls: "sa-legend" });
    this.statsEl = host.createDiv({ cls: "sa-stats" });

    this.svg.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(6, Math.max(0.25, this.view.k * factor));
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      this.view.x = mx - ((mx - this.view.x) * next) / this.view.k;
      this.view.y = my - ((my - this.view.y) * next) / this.view.k;
      this.view.k = next;
      this.applyTransform();
    });

    let dragging = false, lastX = 0, lastY = 0;
    this.svg.addEventListener("pointerdown", (e: PointerEvent) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      this.svg.addClass("is-dragging");
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) return;
      this.view.x += e.clientX - lastX;
      this.view.y += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.applyTransform();
    });
    const stop = (e: PointerEvent) => {
      dragging = false;
      this.svg.removeClass("is-dragging");
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    };
    this.svg.addEventListener("pointerup", stop);
    this.svg.addEventListener("pointercancel", stop);
    this.registerDomEvent(window, "resize", debounce(() => this.layout(), 250, true));
  }

  private applyTransform(): void {
    this.root.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  private size(): { w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    return { w: Math.max(320, r.width), h: Math.max(280, r.height) };
  }

  async refresh(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statsEl.setText("Calculando el atlas…");
    try {
      if (force) await this.plugin.bridge.build(true);
      this.points = await this.plugin.bridge.points();
      if (this.points.length < 2) {
        this.empty();
        return;
      }
      const projected = randomProject(this.points.map((p) => p.vec), 64);
      this.cluster = kmeans(projected, this.plugin.settings.clusters);
      this.computeEdges(projected);
      this.xy = pca2(projected);
      this.layout();
    } finally {
      this.busy = false;
    }
  }

  private empty(): void {
    this.edgeLayer.empty();
    this.nodeLayer.empty();
    this.legendEl.empty();
    this.statsEl.empty();
    const box = this.legendEl.createDiv({ cls: "sa-empty" });
    box.createDiv({ cls: "sa-empty__title", text: "Sin datos suficientes" });
    box.createDiv({
      cls: "sa-empty__desc",
      text: "Hacen falta al menos dos notas indexadas. Reindexá desde los ajustes o activá Smart Connections."
    });
  }

  /**
   * Top-k neighbours per node above a similarity floor. The floor auto-relaxes when the
   * resulting graph is too sparse, so TF-IDF and embedding scales both produce a readable map.
   */
  private computeEdges(vectors: Float32Array[]): void {
    const { neighbors } = this.plugin.settings;
    const n = vectors.length;
    let floor = this.plugin.settings.linkThreshold;
    for (let attempt = 0; attempt < 4; attempt++) {
      const seen = new Set<string>();
      this.edges = [];
      this.degree = new Array(n).fill(0);
      this.adjacency = Array.from({ length: n }, () => [] as number[]);
      for (let i = 0; i < n; i++) {
        const scored: { j: number; w: number }[] = [];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const w = cosine(vectors[i], vectors[j]);
          if (w >= floor) scored.push({ j, w });
        }
        scored.sort((a, b) => b.w - a.w);
        for (const { j, w } of scored.slice(0, neighbors)) {
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          this.edges.push({ a: i, b: j, w });
          this.degree[i]++; this.degree[j]++;
          this.adjacency[i].push(j); this.adjacency[j].push(i);
        }
      }
      this.floor = floor;
      if (this.edges.length >= n * 0.6 || floor <= 0.08) return;
      floor *= 0.6;
    }
  }

  private layout(): void {
    if (this.points.length < 2) return;
    const { w, h } = this.size();
    const spread = relax(this.xy.map(([x, y]) => [x * 1000, y * 1000] as [number, number]), 70, 30);
    const placed = fitToBox(spread, w, h, 56);
    this.draw(placed);
  }

  private colors(): readonly string[] { return PALETTES[this.plugin.settings.palette]; }

  private draw(pos: [number, number][]): void {
    const { showLabels, animate } = this.plugin.settings;
    const palette = this.colors();
    this.edgeLayer.empty();
    this.nodeLayer.empty();
    this.nodeEls = [];

    for (const e of this.edges) {
      sv(this.edgeLayer, "line", {
        x1: pos[e.a][0], y1: pos[e.a][1], x2: pos[e.b][0], y2: pos[e.b][1],
        class: "sa-edge", "stroke-width": (0.6 + e.w * 1.8).toFixed(2), "data-a": e.a, "data-b": e.b
      });
    }

    const maxDeg = Math.max(1, ...this.degree);
    this.points.forEach((p, i) => {
      const [x, y] = pos[i];
      const g = sv(this.nodeLayer, "g", {
        class: "sa-node",
        transform: animate ? `translate(${pos[i][0]},${pos[i][1]}) scale(0.001)` : `translate(${x},${y})`,
        "data-index": i
      });
      const r = 4 + (this.degree[i] / maxDeg) * 7;
      sv(g, "circle", { r: r + 6, class: "sa-node__halo", fill: palette[this.cluster[i] % palette.length] });
      sv(g, "circle", { r, class: "sa-node__dot", fill: palette[this.cluster[i] % palette.length] });
      if (showLabels) {
        const t = sv(g, "text", { class: "sa-node__label", x: r + 6, y: 4 });
        t.textContent = p.title.length > 28 ? `${p.title.slice(0, 27)}…` : p.title;
      }
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.app.workspace.openLinkText(p.path, "", (ev as MouseEvent).metaKey || (ev as MouseEvent).ctrlKey);
      });
      g.addEventListener("pointerenter", () => this.focusNode(i, p.title, p.path));
      g.addEventListener("pointerleave", () => this.blurNode());
      this.nodeEls.push(g);
      if (animate) {
        window.setTimeout(() => g.setAttribute("transform", `translate(${x},${y})`), 10 + i * 4);
      }
    });

    this.renderLegend();
    this.statsEl.empty();
    const engine = this.plugin.bridge.engine === "smart-connections" ? "Smart Connections" : "índice local";
    this.statsEl.createSpan({ text: `${this.points.length} notas · ${this.edges.length} conexiones · umbral ${this.floor.toFixed(2)} · ${engine}` });
    this.paintHighlight();
  }

  private renderLegend(): void {
    this.legendEl.empty();
    const groups = new Map<number, string[]>();
    this.cluster.forEach((c, i) => {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(this.points[i].path);
    });
    const palette = this.colors();
    [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([c, paths]) => {
        const chip = this.legendEl.createDiv({ cls: "sa-chip" });
        chip.createSpan({ cls: "sa-chip__dot" }).style.background = palette[c % palette.length];
        chip.createSpan({ cls: "sa-chip__label", text: this.plugin.bridge.labelFor(paths) });
        chip.createSpan({ cls: "sa-chip__count", text: String(paths.length) });
        chip.addEventListener("click", () => {
          this.query = this.query === `#${c}` ? "" : `#${c}`;
          this.paintHighlight();
        });
      });
  }

  private focusNode(index: number, title: string, path: string): void {
    const near = new Set(this.adjacency[index]);
    this.nodeEls.forEach((el, i) => el.toggleClass("is-dim", i !== index && !near.has(i)));
    this.edgeLayer.querySelectorAll("line").forEach((line) => {
      const a = Number(line.getAttribute("data-a")), b = Number(line.getAttribute("data-b"));
      line.classList.toggle("is-active", a === index || b === index);
    });
    this.tooltip.empty();
    this.tooltip.createDiv({ cls: "sa-tooltip__title", text: title });
    this.tooltip.createDiv({ cls: "sa-tooltip__path", text: path });
    this.tooltip.createDiv({ cls: "sa-tooltip__meta", text: `${this.adjacency[index].length} conexiones directas` });
    this.tooltip.addClass("is-visible");
  }

  private blurNode(): void {
    this.nodeEls.forEach((el) => el.removeClass("is-dim"));
    this.edgeLayer.querySelectorAll("line").forEach((l) => l.classList.remove("is-active"));
    this.tooltip.removeClass("is-visible");
    this.paintHighlight();
  }

  /** Applies the toolbar filter and marks the active file. */
  paintHighlight(): void {
    const active = this.app.workspace.getActiveFile()?.path;
    const byCluster = this.query.startsWith("#") ? Number(this.query.slice(1)) : null;
    this.nodeEls.forEach((el, i) => {
      const p = this.points[i];
      const matches =
        !this.query ||
        (byCluster !== null ? this.cluster[i] === byCluster : p.title.toLowerCase().includes(this.query) || p.path.toLowerCase().includes(this.query));
      el.toggleClass("is-muted", !matches);
      el.toggleClass("is-active", p.path === active);
    });
  }
}
