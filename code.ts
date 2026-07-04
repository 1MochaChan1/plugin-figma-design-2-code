// Show the plugin UI
figma.showUI(__html__, { width: 360, height: 400 });

// Listen for messages from the UI
figma.ui.onmessage = async (msg: { type: string; clientRepoPath?: string }) => {
  if (msg.type === "generate") {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "Please select a frame or component first.",
      });
      return;
    }

    const root = selection[0];
    if (
      root.type !== "FRAME" &&
      root.type !== "COMPONENT" &&
      root.type !== "INSTANCE" &&
      root.type !== "GROUP"
    ) {
      figma.ui.postMessage({
        type: "error",
        message:
          "Please select a Frame, Component, Instance, or Group to generate code from.",
      });
      return;
    }

    figma.ui.postMessage({ type: "status", message: "Extracting design data..." });

    // Extract pen blueprint synchronously (no async Figma API in extractor)
    // We need to use eval-like pattern since we can't import in Figma sandbox
    const blueprint = extractPenBlueprint([root]);

    if (!blueprint) {
      figma.ui.postMessage({
        type: "error",
        message: "Failed to extract design data from selection.",
      });
      return;
    }

    figma.ui.postMessage({ type: "status", message: "Capturing screenshot..." });

    // Export screenshot at 2x
    const screenshotBytes = await root.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 },
    });

    const screenshotBase64 = figma.base64Encode(screenshotBytes);

    figma.ui.postMessage({
      type: "compile",
      penBlueprint: JSON.stringify(blueprint),
      screenshotBase64,
      clientRepoPath: msg.clientRepoPath,
    });
  }
};

// --- Pen Extractor (inline, Figma sandbox compatible) ---

interface PenBlueprint {
  type: "document";
  name: string;
  children: PenNode[];
  metadata?: {
    canvasWidth?: number;
    canvasHeight?: number;
  };
}

type PenNode =
  | PenFrame
  | PenText
  | PenRectangle
  | PenEllipse
  | PenImage
  | PenGroup;

interface BaseNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  visible?: boolean;
}

interface PenFrame extends BaseNode {
  type: "frame";
  layout?: Layout;
  fills?: Fill[];
  strokes?: Stroke[];
  effects?: Effect[];
  cornerRadius?: number | CornerRadius;
  clipContent?: boolean;
  children: PenNode[];
}

interface PenText extends BaseNode {
  type: "text";
  characters: string;
  style: TextStyle;
}

interface PenRectangle extends BaseNode {
  type: "rectangle";
  fills?: Fill[];
  strokes?: Stroke[];
  effects?: Effect[];
  cornerRadius?: number | CornerRadius;
}

interface PenEllipse extends BaseNode {
  type: "ellipse";
  fills?: Fill[];
  strokes?: Stroke[];
  effects?: Effect[];
}

interface PenImage extends BaseNode {
  type: "image";
  imageUrl?: string;
  fills?: Fill[];
  cornerRadius?: number | CornerRadius;
}

interface PenGroup extends BaseNode {
  type: "group";
  effects?: Effect[];
  children: PenNode[];
}

interface Layout {
  mode: "none" | "horizontal" | "vertical";
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  mainAxisAlign?: "start" | "center" | "end" | "space_between";
  crossAxisAlign?: "start" | "center" | "end" | "stretch";
  wrap?: boolean;
}

interface Fill {
  type: "solid" | "gradient" | "image";
  color?: RGBA;
  opacity?: number;
  gradientStops?: { position: number; color: RGBA }[];
  imageUrl?: string;
}

interface Stroke {
  color: RGBA;
  weight: number;
  align?: "center" | "inside" | "outside";
  dashPattern?: number[];
}

interface Effect {
  type: "drop_shadow" | "inner_shadow" | "layer_blur" | "background_blur";
  offset?: { x: number; y: number };
  radius: number;
  color?: RGBA;
  spread?: number;
  visible?: boolean;
}

interface CornerRadius {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  fills?: Fill[];
  textDecoration?: "none" | "underline" | "strikethrough";
}

function rgbaToObject(color: RGB, opacity?: number): RGBA {
  return {
    r: Math.round(color.r * 1000) / 1000,
    g: Math.round(color.g * 1000) / 1000,
    b: Math.round(color.b * 1000) / 1000,
    a: opacity !== undefined ? Math.round(opacity * 1000) / 1000 : 1,
  };
}

function extractFills(node: GeometryMixin & MinimalFillsMixin): Fill[] {
  if (typeof node.fills === "symbol") return [];

  const fills: Fill[] = [];
  const rawFills = node.fills as readonly Paint[];

  for (const paint of rawFills) {
    if (!paint.visible) continue;

    if (paint.type === "SOLID") {
      fills.push({
        type: "solid",
        color: rgbaToObject(paint.color, paint.opacity),
        opacity: paint.opacity,
      });
    } else if (
      paint.type === "GRADIENT_LINEAR" ||
      paint.type === "GRADIENT_RADIAL"
    ) {
      fills.push({
        type: "gradient",
        gradientStops: paint.gradientStops.map((stop) => ({
          position: Math.round(stop.position * 1000) / 1000,
          color: rgbaToObject(stop.color),
        })),
        opacity: paint.opacity,
      });
    } else if (paint.type === "IMAGE") {
      fills.push({
        type: "image",
        opacity: paint.opacity,
      });
    }
  }

  return fills;
}

function extractStrokes(
  node: GeometryMixin & MinimalStrokesMixin
): Stroke[] {
  const strokes: Stroke[] = [];

  try {
    if (typeof node.strokes === "symbol") return [];

    const rawStrokes = node.strokes as readonly Paint[];
    const weight = node.strokeWeight as number;

    let align: "center" | "inside" | "outside" = "center";
    if ("strokeAlign" in node) {
      const sa = (node as any).strokeAlign;
      if (sa === "INSIDE") align = "inside";
      else if (sa === "OUTSIDE") align = "outside";
    }

    const dashPattern =
      "dashPattern" in node
        ? ((node as any).dashPattern as number[] | undefined)
        : undefined;

    for (const paint of rawStrokes) {
      if (!paint.visible || paint.type !== "SOLID") continue;
      strokes.push({
        color: rgbaToObject(paint.color, paint.opacity),
        weight,
        align,
        dashPattern,
      });
    }
  } catch {
    // node may not have strokes
  }

  return strokes;
}

function extractEffects(node: BlendMixin): Effect[] {
  const effects: Effect[] = [];

  try {
    if (typeof node.effects === "symbol") return [];

    const rawEffects = node.effects as readonly any[];

    for (const effect of rawEffects) {
      if (!effect.visible) continue;

      const base: any = {
        type: effect.type,
        radius: effect.radius || 0,
        visible: effect.visible,
      };

      if (
        effect.type === "DROP_SHADOW" ||
        effect.type === "INNER_SHADOW"
      ) {
        base.offset = {
          x: effect.offset?.x || 0,
          y: effect.offset?.y || 0,
        };
        base.color = rgbaToObject(
          effect.color || { r: 0, g: 0, b: 0 },
          effect.color?.a
        );
        base.spread = effect.spread || 0;
      }

      const mappedType =
        effect.type === "DROP_SHADOW"
          ? "drop_shadow"
          : effect.type === "INNER_SHADOW"
          ? "inner_shadow"
          : effect.type === "LAYER_BLUR"
          ? "layer_blur"
          : "background_blur";

      effects.push({ ...base, type: mappedType } as Effect);
    }
  } catch {
    // node may not have effects
  }

  return effects;
}

function extractCornerRadius(
  node: CornerMixin
): number | CornerRadius | undefined {
  try {
    if (
      node.cornerRadius !== undefined &&
      node.cornerRadius !== figma.mixed
    ) {
      return node.cornerRadius;
    }
    if (node.cornerRadius === figma.mixed) {
      const n = node as any;
      return {
        tl: n.topLeftRadius || 0,
        tr: n.topRightRadius || 0,
        br: n.bottomRightRadius || 0,
        bl: n.bottomLeftRadius || 0,
      };
    }
  } catch {
    // node may not have corner radius
  }
  return undefined;
}

function extractLayout(
  node: FrameNode | ComponentNode
): Layout | undefined {
  try {
    if (node.layoutMode === "NONE") return undefined;

    return {
      mode:
        node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical",
      gap: node.itemSpacing || 0,
      padding: {
        top: node.paddingTop || 0,
        right: node.paddingRight || 0,
        bottom: node.paddingBottom || 0,
        left: node.paddingLeft || 0,
      },
      mainAxisAlign:
        node.primaryAxisAlignItems === "MIN"
          ? "start"
          : node.primaryAxisAlignItems === "CENTER"
          ? "center"
          : node.primaryAxisAlignItems === "MAX"
          ? "end"
          : "space_between",
      crossAxisAlign:
        node.counterAxisAlignItems === "MIN"
          ? "start"
          : node.counterAxisAlignItems === "CENTER"
          ? "center"
          : node.counterAxisAlignItems === "MAX"
          ? "end"
          : "stretch",
      wrap: node.layoutWrap === "WRAP",
    };
  } catch {
    return undefined;
  }
}

function extractTextStyle(node: TextNode): TextStyle {
  return {
    fontFamily:
      typeof node.fontName === "object" && "family" in node.fontName
        ? (node.fontName as any).family
        : "Inter",
    fontSize: node.fontSize as number,
    fontWeight:
      typeof node.fontName === "object" && "style" in node.fontName
        ? (node.fontName as any).style === "Bold"
          ? 700
          : (node.fontName as any).style === "SemiBold"
          ? 600
          : (node.fontName as any).style === "Medium"
          ? 500
          : 400
        : 400,
    lineHeight:
      node.lineHeight !== figma.mixed &&
      typeof node.lineHeight === "object"
        ? (node.lineHeight as any).value
        : undefined,
    letterSpacing:
      node.letterSpacing !== figma.mixed &&
      typeof node.letterSpacing === "object"
        ? (node.letterSpacing as any).value
        : undefined,
    textAlign:
      node.textAlignHorizontal === "CENTER"
        ? "center"
        : node.textAlignHorizontal === "RIGHT"
        ? "right"
        : node.textAlignHorizontal === "JUSTIFIED"
        ? "justify"
        : "left",
    fills: extractFills(node as any),
    textDecoration:
      node.textDecoration === "UNDERLINE"
        ? "underline"
        : node.textDecoration === "STRIKETHROUGH"
        ? "strikethrough"
        : "none",
  };
}

function extractNode(node: SceneNode): PenNode | null {
  if (!node.visible && node.type !== "FRAME") return null;

  const base: BaseNode = {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    opacity: "opacity" in node ? (node as any).opacity : 1,
    visible: node.visible,
  };

  switch (node.type) {
    case "FRAME":
    case "COMPONENT":
    case "INSTANCE": {
      const frame = node as FrameNode | ComponentNode;
      const children: PenNode[] = [];
      if ("children" in frame) {
        for (const child of frame.children) {
          const extracted = extractNode(child);
          if (extracted) children.push(extracted);
        }
      }
      return {
        ...base,
        type: "frame",
        layout: extractLayout(frame),
        fills: extractFills(frame),
        strokes: extractStrokes(frame),
        effects: extractEffects(frame),
        cornerRadius: extractCornerRadius(frame),
        clipContent: frame.clipsContent,
        children,
      };
    }

    case "TEXT": {
      const text = node as TextNode;
      return {
        ...base,
        type: "text",
        characters: text.characters,
        style: extractTextStyle(text),
      };
    }

    case "RECTANGLE": {
      const rect = node as RectangleNode;
      return {
        ...base,
        type: "rectangle",
        fills: extractFills(rect),
        strokes: extractStrokes(rect),
        effects: extractEffects(rect),
        cornerRadius: extractCornerRadius(rect),
      };
    }

    case "ELLIPSE": {
      const ellipse = node as EllipseNode;
      return {
        ...base,
        type: "ellipse",
        fills: extractFills(ellipse),
        strokes: extractStrokes(ellipse),
        effects: extractEffects(ellipse),
      };
    }

    case "GROUP": {
      const group = node as GroupNode;
      const children: PenNode[] = [];
      for (const child of group.children) {
        const extracted = extractNode(child);
        if (extracted) children.push(extracted);
      }
      return {
        ...base,
        type: "group",
        effects: extractEffects(group),
        children,
      };
    }

    default:
      return null;
  }
}

function extractPenBlueprint(
  selection: readonly SceneNode[]
): PenBlueprint | null {
  if (selection.length === 0) return null;

  const root = selection[0];
  const rootNode = extractNode(root);
  if (!rootNode) return null;

  return {
    type: "document",
    name: root.name,
    children: [rootNode],
    metadata: {
      canvasWidth: Math.abs(root.width),
      canvasHeight: Math.abs(root.height),
    },
  };
}
