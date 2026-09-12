import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type SmartAtlasPlugin from "./main";

export interface AtlasSettings {
  maxNodes: number;
  clusters: number;
  neighbors: number;
  linkThreshold: number;
  minScore: number;
  resultLimit: number;
  showLabels: boolean;
  animate: boolean;
  palette: keyof typeof PALETTES;
  excludeFolders: string;
  openOnStart: boolean;
  mocHeading: string;
}

export const PALETTES = {
  aurora: ["#6c8cff", "#41d6c3", "#f2a65a", "#e45c8c", "#9b7bff", "#4fb477", "#e8c547", "#5ac8fa"],
  ember: ["#ff7a59", "#ffb347", "#ef476f", "#c86bfa", "#ffd166", "#f78c6b", "#e76f51", "#f4a261"],
  slate: ["#7f9cf5", "#90a4ae", "#a3b18a", "#c9ada7", "#8d99ae", "#b5838d", "#6d8891", "#9a8c98"]
} as const;

export const DEFAULT_SETTINGS: AtlasSettings = {
  maxNodes: 300,
  clusters: 6,
  neighbors: 3,
  linkThreshold: 0.32,
  minScore: 0.05,
  resultLimit: 20,
  showLabels: true,
  animate: true,
  palette: "aurora",
  excludeFolders: "",
  openOnStart: false,
  mocHeading: "Conexiones semánticas"
};

export const parseFolders = (raw: string): string[] =>
  raw.split(/[,\n]/).map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

export class AtlasSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SmartAtlasPlugin) {
    super(app, plugin);
  }

  private status(parent: HTMLElement): void {
    const engine = this.plugin.bridge.detect();
    const card = parent.createDiv({ cls: `sa-status sa-status--${engine}` });
    const icon = card.createDiv({ cls: "sa-status__icon" });
    setIcon(icon, engine === "smart-connections" ? "zap" : "cpu");
    const body = card.createDiv({ cls: "sa-status__body" });
    body.createDiv({
      cls: "sa-status__title",
      text: engine === "smart-connections" ? "Smart Connections detectado" : "Índice local TF-IDF"
    });
    body.createDiv({
      cls: "sa-status__desc",
      text:
        engine === "smart-connections"
          ? `Usando embeddings de Smart Connections · ${this.plugin.bridge.sourceCount} fuentes indexadas.`
          : "Smart Connections no está activo. Smart Atlas funciona con un índice léxico local; instalá Smart Connections para usar embeddings reales."
    });
    new Setting(card)
      .addButton((b) =>
        b
          .setButtonText("Reindexar")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Indexando…");
            await this.plugin.reindex();
            this.display();
          })
      );
  }

  private number(
    parent: HTMLElement,
    name: string,
    desc: string,
    key: "maxNodes" | "clusters" | "neighbors" | "resultLimit",
    min: number,
    max: number,
    step = 1
  ): void {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addSlider((s) =>
        s
          .setLimits(min, max, step)
          .setValue(this.plugin.settings[key])
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings[key] = v;
            await this.plugin.saveSettings();
          })
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sa-settings");

    const hero = containerEl.createDiv({ cls: "sa-hero" });
    hero.createDiv({ cls: "sa-hero__title", text: "Smart Atlas" });
    hero.createDiv({
      cls: "sa-hero__desc",
      text: "Mapa semántico, explorador y clustering sobre el ecosistema de Smart Connections."
    });

    this.status(containerEl);

    new Setting(containerEl).setName("Motor semántico").setHeading();

    new Setting(containerEl)
      .setName("Carpetas excluidas")
      .setDesc("Una por línea o separadas por coma. Se excluyen del índice, del mapa y de los resultados.")
      .addTextArea((t) =>
        t
          .setPlaceholder("40_Archivo\n99_Meta/Plantillas")
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (v) => {
            this.plugin.settings.excludeFolders = v;
            await this.plugin.saveSettings();
            this.plugin.bridge.invalidate();
          })
      );

    new Setting(containerEl)
      .setName("Puntuación mínima")
      .setDesc("Similitud por debajo de la cual un resultado se descarta.")
      .addSlider((s) =>
        s
          .setLimits(0, 0.8, 0.01)
          .setValue(this.plugin.settings.minScore)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.minScore = v;
            await this.plugin.saveSettings();
          })
      );

    this.number(containerEl, "Resultados por consulta", "Máximo de notas devueltas por el explorador.", "resultLimit", 5, 60);

    new Setting(containerEl).setName("Mapa").setHeading();

    this.number(containerEl, "Nodos máximos", "Límite de notas dibujadas en el atlas.", "maxNodes", 40, 1200, 20);
    this.number(containerEl, "Clústeres", "Grupos temáticos calculados con k-means sobre los embeddings.", "clusters", 2, 12);
    this.number(containerEl, "Vecinos por nodo", "Aristas trazadas desde cada nota hacia sus vecinos más cercanos.", "neighbors", 1, 8);

    new Setting(containerEl)
      .setName("Umbral de arista")
      .setDesc("Similitud mínima para dibujar una conexión. Si el mapa queda demasiado disperso, Smart Atlas relaja el umbral automáticamente.")
      .addSlider((s) =>
        s
          .setLimits(0.05, 0.95, 0.01)
          .setValue(this.plugin.settings.linkThreshold)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.linkThreshold = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl).setName("Apariencia").setHeading();

    new Setting(containerEl)
      .setName("Paleta")
      .setDesc("Color de los clústeres del mapa.")
      .addDropdown((d) => {
        Object.keys(PALETTES).forEach((k) => d.addOption(k, k));
        d.setValue(this.plugin.settings.palette).onChange(async (v) => {
          this.plugin.settings.palette = v as keyof typeof PALETTES;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("Mostrar etiquetas")
      .setDesc("Dibuja el título de cada nota junto al nodo.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showLabels).onChange(async (v) => {
          this.plugin.settings.showLabels = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("Animar entrada")
      .setDesc("Transición de los nodos al recalcular el mapa.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.animate).onChange(async (v) => {
          this.plugin.settings.animate = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Comportamiento").setHeading();

    new Setting(containerEl)
      .setName("Abrir el atlas al iniciar")
      .setDesc("Despliega el mapa en el panel derecho al cargar la bóveda.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openOnStart).onChange(async (v) => {
          this.plugin.settings.openOnStart = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Encabezado del MOC")
      .setDesc("Título de la sección que inserta el comando de mapa de contenido.")
      .addText((t) =>
        t.setValue(this.plugin.settings.mocHeading).onChange(async (v) => {
          this.plugin.settings.mocHeading = v || DEFAULT_SETTINGS.mocHeading;
          await this.plugin.saveSettings();
        })
      );

    const footer = containerEl.createDiv({ cls: "sa-footer" });
    footer.createSpan({ text: "Smart Atlas · " });
    footer.createEl("a", { text: "github.com/teobotaya", href: "https://github.com/teobotaya" });
  }
}
