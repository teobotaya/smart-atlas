# Smart Atlas

Capa de exploración visual para bóvedas de Obsidian: convierte los embeddings de
[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) en un **mapa
semántico navegable**, un **explorador de búsqueda** y **clústeres temáticos** calculados en el cliente.

<p>
  <img alt="Obsidian" src="https://img.shields.io/badge/Obsidian-1.5%2B-7C3AED?style=flat-square&logo=obsidian&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="esbuild" src="https://img.shields.io/badge/esbuild-bundler-FFCF00?style=flat-square&logo=esbuild&logoColor=black">
  <img alt="Sin dependencias" src="https://img.shields.io/badge/runtime-0%20dependencias-4fb477?style=flat-square">
  <img alt="Licencia MIT" src="https://img.shields.io/badge/Licencia-MIT-green?style=flat-square">
</p>

---

## Qué resuelve

Smart Connections responde *"¿qué se parece a esto?"* una nota por vez. Lo que no muestra es la
**forma del conocimiento**: qué temas existen, cuáles están aislados y dónde el grafo de enlaces
manuales miente respecto de lo que las notas realmente dicen.

Smart Atlas toma esos mismos embeddings y los vuelve espacio: proyecta la bóveda entera a dos
dimensiones, la agrupa por temas y deja explorar el resultado sin salir de Obsidian.

## Arquitectura

```
                        ┌──────────────────────────────┐
  Smart Connections ───▶│  SmartBridge                 │──▶ lookup(query)
  (embeddings)          │  detección · normalización   │──▶ connections(file)
                        │  degradación a TF-IDF local  │──▶ points()  ← nube vectorial
                        └───────────────┬──────────────┘
                                        │ Float32Array[]
                        ┌───────────────▼──────────────┐
                        │  Núcleo numérico (math.ts)   │
                        │  JL random projection → 64d  │
                        │  PCA (power iteration + defl)│
                        │  k-means++ (cosine)          │
                        │  relajación de solapamientos │
                        └───────────────┬──────────────┘
                    ┌───────────────────┴───────────────────┐
            ┌───────▼────────┐                     ┌────────▼────────┐
            │  AtlasView     │                     │  ExplorerModal  │
            │  SVG · zoom    │                     │  búsqueda · MOC │
            │  pan · hover   │                     │  atajos · vista │
            └────────────────┘                     └─────────────────┘
```

**Decisión de diseño central:** el bridge nunca asume que Smart Connections esté instalado.
Detecta el entorno (`plugins["smart-connections"].env` → `smart_env` global), normaliza las tres
formas de respuesta que devuelven sus distintas versiones, y si algo falla degrada a un índice
TF-IDF construido en memoria sobre `cachedRead`. El plugin nunca queda inutilizable.

**Segunda decisión:** las operaciones O(n²) no corren sobre los vectores originales. Una proyección
Johnson–Lindenstrauss lleva 384 o 4096 dimensiones a 64 antes de agrupar y buscar vecinos: 180 notas
se procesan en ~60 ms en lugar de varios segundos, conservando las distancias coseno.

## Funciones

| Superficie | Qué hace |
|---|---|
| **Vista Atlas** (panel lateral) | Mapa SVG con zoom, paneo, halo por grado, aristas por umbral de similitud, resaltado de vecinos al pasar el cursor y filtro por texto o clúster |
| **Explorador** (modal) | Búsqueda semántica libre o conexiones de la nota actual, con barra de puntuación, vista previa y navegación por teclado |
| **Leyenda de clústeres** | k-means sobre los embeddings; cada grupo se etiqueta con sus términos más frecuentes y filtra el mapa al hacer clic |
| **Ribbon + barra de estado** | Acceso directo al mapa y al explorador; la barra indica qué motor está activo |
| **Ajustes** | Motor, carpetas excluidas, umbrales, nodos, clústeres, vecinos, paleta, etiquetas y animación |
| **Menú contextual** | "Ver conexiones" sobre cualquier nota del explorador de archivos |
| **Comando MOC** | Inserta en el cursor un mapa de contenido con las notas semánticamente cercanas y su puntuación |

### Atajos del explorador

| Tecla | Acción |
|---|---|
| `↑` `↓` | Navegar resultados |
| `↵` | Abrir la nota |
| `⇧↵` | Abrir en panel nuevo |
| `⌘↵` / `Ctrl↵` | Insertar `[[enlace]]` en el cursor |

## Instalación

### Manual

```bash
git clone https://github.com/teobotaya/smart-atlas.git
cd smart-atlas
npm install
npm run build
```

Copiar `main.js`, `manifest.json` y `styles.css` a
`<bóveda>/.obsidian/plugins/smart-atlas/` y activar el plugin en *Ajustes → Complementos de la comunidad*.

### Desarrollo

```bash
npm run dev        # esbuild en modo watch
npm run typecheck  # tsc --noEmit
```

## Estructura

```
smart-atlas
├── manifest.json
├── styles.css
├── esbuild.config.mjs
└── src
    ├── main.ts                    # ciclo de vida, comandos, ribbon, barra de estado
    ├── bridge.ts                  # Smart Connections + índice TF-IDF de respaldo
    ├── math.ts                    # JL projection · PCA · k-means++ · relajación
    ├── settings.ts                # modelo de ajustes y pestaña de configuración
    ├── views/atlas-view.ts        # ItemView: mapa SVG interactivo
    └── modals/explorer-modal.ts   # Modal: búsqueda semántica y MOC
```

Sin dependencias en tiempo de ejecución: el álgebra lineal, el clustering y el renderizado SVG
están escritos a mano para mantener el bundle por debajo de 30 kB.

## Compatibilidad

- Obsidian 1.5 o superior, escritorio y móvil (`isDesktopOnly: false`).
- Smart Connections opcional. Sin él, el plugin usa su propio índice léxico.

## Autor

**Teo Matías Botaya** — [github.com/teobotaya](https://github.com/teobotaya) · teobotaya@gmail.com

## Licencia

MIT — ver [LICENSE](LICENSE).
