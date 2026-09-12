import { App, Modal, Notice, TFile, debounce, setIcon } from "obsidian";
import type SmartAtlasPlugin from "../main";
import { AtlasHit } from "../bridge";

type Mode = "query" | "current";

export class ExplorerModal extends Modal {
  private mode: Mode;
  private query = "";
  private hits: AtlasHit[] = [];
  private cursor = 0;
  private listEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private metaEl!: HTMLElement;
  private previewEl!: HTMLElement;

  constructor(app: App, private plugin: SmartAtlasPlugin, mode: Mode = "query") {
    super(app);
    this.mode = mode;
  }

  onOpen(): void {
    this.modalEl.addClass("sa-modal");
    const { contentEl } = this;
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "sa-modal__head" });
    const title = head.createDiv({ cls: "sa-modal__title" });
    setIcon(title.createSpan({ cls: "sa-modal__icon" }), "telescope");
    title.createSpan({ text: "Explorador semántico" });
    const engine = head.createDiv({ cls: "sa-modal__engine" });
    engine.setText(this.plugin.bridge.engine === "smart-connections" ? "Smart Connections" : "índice local");

    const tabs = contentEl.createDiv({ cls: "sa-tabs" });
    const tab = (id: Mode, label: string) => {
      const el = tabs.createDiv({ cls: "sa-tabs__tab", text: label });
      el.toggleClass("is-active", this.mode === id);
      el.addEventListener("click", () => {
        this.mode = id;
        tabs.findAll(".sa-tabs__tab").forEach((t) => t.removeClass("is-active"));
        el.addClass("is-active");
        this.inputEl.toggleClass("is-hidden", id === "current");
        void this.run();
      });
      return el;
    };
    tab("query", "Consulta libre");
    tab("current", "Nota actual");

    this.inputEl = contentEl.createEl("input", {
      cls: "sa-modal__input",
      attr: { type: "text", placeholder: "¿Qué estás buscando? Describilo en una frase…" }
    });
    this.inputEl.toggleClass("is-hidden", this.mode === "current");
    const debounced = debounce(() => void this.run(), 220, true);
    this.inputEl.addEventListener("input", () => { this.query = this.inputEl.value; debounced(); });
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));

    const body = contentEl.createDiv({ cls: "sa-modal__body" });
    this.listEl = body.createDiv({ cls: "sa-results" });
    this.previewEl = body.createDiv({ cls: "sa-preview" });

    this.metaEl = contentEl.createDiv({ cls: "sa-modal__meta" });
    const foot = contentEl.createDiv({ cls: "sa-modal__foot" });
    [
      ["↑↓", "navegar"],
      ["↵", "abrir"],
      ["⇧↵", "abrir al costado"],
      ["⌘↵", "insertar enlace"]
    ].forEach(([k, v]) => {
      const chip = foot.createDiv({ cls: "sa-key" });
      chip.createSpan({ cls: "sa-key__k", text: k });
      chip.createSpan({ cls: "sa-key__v", text: v });
    });

    contentEl.createDiv({ cls: "sa-modal__actions" }, (el) => {
      const moc = el.createEl("button", { cls: "mod-cta", text: "Insertar MOC de resultados" });
      moc.addEventListener("click", () => void this.insertMoc());
    });

    window.setTimeout(() => this.inputEl.focus(), 20);
    void this.run();
  }

  onClose(): void { this.contentEl.empty(); }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const hit = this.hits[this.cursor];
      if (!hit) return;
      if (e.metaKey || e.ctrlKey) void this.insertLink(hit);
      else this.openHit(hit, e.shiftKey);
    }
  }

  private move(delta: number): void {
    if (!this.hits.length) return;
    this.cursor = (this.cursor + delta + this.hits.length) % this.hits.length;
    this.renderResults();
    void this.renderPreview();
  }

  private async run(): Promise<void> {
    const limit = this.plugin.settings.resultLimit;
    this.metaEl.setText("Buscando…");
    if (this.mode === "current") {
      const file = this.app.workspace.getActiveFile();
      this.hits = file ? await this.plugin.bridge.connections(file, limit) : [];
      this.metaEl.setText(file ? `Conexiones de “${file.basename}”` : "No hay ninguna nota abierta.");
    } else {
      this.hits = await this.plugin.bridge.lookup(this.query, limit);
      this.metaEl.setText(this.query ? `${this.hits.length} resultados` : "Escribí una consulta para empezar.");
    }
    this.cursor = 0;
    this.renderResults();
    await this.renderPreview();
  }

  private renderResults(): void {
    this.listEl.empty();
    if (!this.hits.length) {
      this.listEl.createDiv({ cls: "sa-results__empty", text: "Sin coincidencias." });
      return;
    }
    this.hits.forEach((hit, i) => {
      const row = this.listEl.createDiv({ cls: "sa-result" });
      row.toggleClass("is-selected", i === this.cursor);
      const main = row.createDiv({ cls: "sa-result__main" });
      main.createDiv({ cls: "sa-result__title", text: hit.title });
      main.createDiv({ cls: "sa-result__path", text: hit.path });
      const score = row.createDiv({ cls: "sa-result__score" });
      score.createDiv({ cls: "sa-result__bar" }).style.width = `${Math.round(Math.max(0, Math.min(1, hit.score)) * 100)}%`;
      score.createSpan({ cls: "sa-result__value", text: hit.score.toFixed(3) });
      row.addEventListener("click", () => { this.cursor = i; this.renderResults(); void this.renderPreview(); });
      row.addEventListener("dblclick", () => this.openHit(hit, false));
    });
  }

  private async renderPreview(): Promise<void> {
    this.previewEl.empty();
    const hit = this.hits[this.cursor];
    if (!hit) return;
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (!(file instanceof TFile)) return;
    const text = await this.app.vault.cachedRead(file);
    const clean = text.replace(/^---[\s\S]*?---\n/, "").trim().slice(0, 900);
    this.previewEl.createDiv({ cls: "sa-preview__title", text: hit.title });
    this.previewEl.createEl("pre", { cls: "sa-preview__body", text: clean || "(nota vacía)" });
    const actions = this.previewEl.createDiv({ cls: "sa-preview__actions" });
    const openBtn = actions.createEl("button", { text: "Abrir" });
    openBtn.addEventListener("click", () => this.openHit(hit, false));
    const linkBtn = actions.createEl("button", { text: "Insertar enlace" });
    linkBtn.addEventListener("click", () => void this.insertLink(hit));
  }

  private openHit(hit: AtlasHit, split: boolean): void {
    this.close();
    void this.app.workspace.openLinkText(hit.path, "", split);
  }

  private async insertLink(hit: AtlasHit): Promise<void> {
    const ok = this.plugin.insertAtCursor(`[[${hit.title}]]`);
    new Notice(ok ? `Enlace a “${hit.title}” insertado` : "Abrí una nota en modo edición para insertar el enlace");
    if (ok) this.close();
  }

  private async insertMoc(): Promise<void> {
    if (!this.hits.length) { new Notice("No hay resultados para volcar"); return; }
    const body = this.plugin.renderMoc(this.hits);
    const ok = this.plugin.insertAtCursor(body);
    new Notice(ok ? "MOC insertado" : "Abrí una nota en modo edición para insertar el MOC");
    if (ok) this.close();
  }
}
