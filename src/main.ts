import { Notice, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS, parseFolders } from "./settings";
import { AtlasHit, SmartBridge } from "./bridge";
import { AtlasView, VIEW_ATLAS } from "./views/atlas-view";
import { ExplorerModal } from "./modals/explorer-modal";

export default class SmartAtlasPlugin extends Plugin {
  settings: AtlasSettings = DEFAULT_SETTINGS;
  bridge!: SmartBridge;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.bridge = new SmartBridge(this.app, () => ({
      maxNodes: this.settings.maxNodes,
      excluded: parseFolders(this.settings.excludeFolders),
      minScore: this.settings.minScore
    }));

    this.registerView(VIEW_ATLAS, (leaf: WorkspaceLeaf) => new AtlasView(leaf, this));

    this.addRibbonIcon("compass", "Smart Atlas: abrir mapa semántico", () => void this.activateView());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("sa-status-bar");
    this.statusEl.addEventListener("click", () => this.openExplorer());

    this.addCommand({ id: "open-atlas", name: "Abrir mapa semántico", callback: () => void this.activateView() });
    this.addCommand({ id: "open-explorer", name: "Explorador semántico", callback: () => this.openExplorer("query") });
    this.addCommand({ id: "open-connections", name: "Conexiones de la nota actual", callback: () => this.openExplorer("current") });
    this.addCommand({
      id: "insert-moc",
      name: "Insertar MOC de conexiones en el cursor",
      editorCallback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const hits = await this.bridge.connections(file, this.settings.resultLimit);
        if (!hits.length) { new Notice("Smart Atlas no encontró conexiones para esta nota"); return; }
        this.insertAtCursor(this.renderMoc(hits));
        new Notice(`${hits.length} conexiones insertadas`);
      }
    });
    this.addCommand({ id: "reindex", name: "Reindexar la bóveda", callback: () => void this.reindex() });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Smart Atlas: ver conexiones")
            .setIcon("telescope")
            .onClick(async () => {
              await this.app.workspace.openLinkText(file.path, "", false);
              this.openExplorer("current");
            })
        );
      })
    );

    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshViews(false)));
    this.registerEvent(this.app.vault.on("modify", () => this.bridge.invalidate()));

    this.addSettingTab(new AtlasSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.paintStatus();
      if (this.settings.openOnStart) void this.activateView();
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_ATLAS);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private paintStatus(): void {
    if (!this.statusEl) return;
    const engine = this.bridge.detect();
    this.statusEl.empty();
    const icon = this.statusEl.createSpan();
    setIcon(icon, engine === "smart-connections" ? "zap" : "cpu");
    this.statusEl.createSpan({ text: engine === "smart-connections" ? "Smart Atlas · SC" : "Smart Atlas · local" });
    this.statusEl.setAttr("aria-label", "Abrir el explorador semántico");
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_ATLAS);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_ATLAS, active: true });
    await workspace.revealLeaf(leaf);
  }

  openExplorer(mode: "query" | "current" = "query"): void {
    new ExplorerModal(this.app, this, mode).open();
  }

  refreshViews(recompute = true): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_ATLAS)) {
      const view = leaf.view;
      if (view instanceof AtlasView) {
        if (recompute) void view.refresh();
        else view.paintHighlight();
      }
    }
  }

  async reindex(): Promise<void> {
    await this.bridge.build(true);
    this.paintStatus();
    this.refreshViews();
    new Notice(`Smart Atlas reindexó ${this.bridge.sourceCount} notas`);
  }

  insertAtCursor(text: string): boolean {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return false;
    editor.replaceSelection(text);
    return true;
  }

  renderMoc(hits: AtlasHit[]): string {
    const lines = hits.map((h) => `- [[${h.title}]] — \`${h.score.toFixed(3)}\``);
    return `\n## ${this.settings.mocHeading}\n\n${lines.join("\n")}\n`;
  }
}
