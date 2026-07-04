figma.showUI(__html__, { width: 360, height: 500 });

figma.ui.onmessage = async function (msg) {
  if (msg.type === "generate") {
    var includeScreenshot = msg.includeScreenshot !== false; // default to true
    var framework = msg.framework || "auto";
    console.log("[D2C] Generate triggered. Repo path:", msg.clientRepoPath, "| Include screenshot:", includeScreenshot, "| Framework:", framework);

    var selection = figma.currentPage.selection;
    console.log("[D2C] Selection count:", selection.length);

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "Please select a frame or component first.",
      });
      return;
    }

    var root = selection[0];
    console.log("[D2C] Root node type:", root.type, "| Name:", root.name, "| Size:", root.width, "x", root.height);

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
    console.log("[D2C] Extracting penBlueprint...");

    var blueprint = extractPenBlueprint(selection);

    if (!blueprint) {
      figma.ui.postMessage({
        type: "error",
        message: "Failed to extract design data from selection.",
      });
      return;
    }

    var blueprintStr = JSON.stringify(blueprint);
    console.log("[D2C] Blueprint extracted. Size:", blueprintStr.length, "chars");
    console.log("[D2C] Blueprint preview:", blueprintStr.substring(0, 200));

    var screenshotBase64 = null;

    if (includeScreenshot) {
      figma.ui.postMessage({ type: "status", message: "Capturing screenshot..." });
      console.log("[D2C] Exporting screenshot at 2x...");

      var screenshotBytes = await root.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 2 },
      });

      screenshotBase64 = figma.base64Encode(screenshotBytes);
      console.log("[D2C] Screenshot captured. Size:", screenshotBase64.length, "chars");
    } else {
      console.log("[D2C] Screenshot skipped per user setting.");
    }

    console.log("[D2C] Sending to bridge server...");
    figma.ui.postMessage({
      type: "compile",
      penBlueprint: blueprintStr,
      screenshotBase64: screenshotBase64,
      clientRepoPath: msg.clientRepoPath,
      framework: framework,
    });
  }
};

// --- Pen Extractor (plain JS) ---

function rgbaToObject(color, opacity) {
  return {
    r: Math.round(color.r * 1000) / 1000,
    g: Math.round(color.g * 1000) / 1000,
    b: Math.round(color.b * 1000) / 1000,
    a: opacity !== undefined ? Math.round(opacity * 1000) / 1000 : 1,
  };
}

function extractFills(node) {
  if (typeof node.fills === "symbol") return [];

  var fills = [];
  var rawFills = node.fills;

  for (var i = 0; i < rawFills.length; i++) {
    var paint = rawFills[i];
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
      var stops = [];
      for (var s = 0; s < paint.gradientStops.length; s++) {
        var stop = paint.gradientStops[s];
        stops.push({
          position: Math.round(stop.position * 1000) / 1000,
          color: rgbaToObject(stop.color),
        });
      }
      fills.push({
        type: "gradient",
        gradientStops: stops,
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

function extractStrokes(node) {
  var strokes = [];

  try {
    if (typeof node.strokes === "symbol") return [];

    var rawStrokes = node.strokes;
    var weight = node.strokeWeight;

    var align = "center";
    if (node.strokeAlign) {
      if (node.strokeAlign === "INSIDE") align = "inside";
      else if (node.strokeAlign === "OUTSIDE") align = "outside";
    }

    var dashPattern = node.dashPattern || undefined;

    for (var i = 0; i < rawStrokes.length; i++) {
      var paint = rawStrokes[i];
      if (!paint.visible || paint.type !== "SOLID") continue;
      strokes.push({
        color: rgbaToObject(paint.color, paint.opacity),
        weight: weight,
        align: align,
        dashPattern: dashPattern,
      });
    }
  } catch (e) {
    // node may not have strokes
  }

  return strokes;
}

function extractEffects(node) {
  var effects = [];

  try {
    if (typeof node.effects === "symbol") return [];

    var rawEffects = node.effects;

    for (var i = 0; i < rawEffects.length; i++) {
      var effect = rawEffects[i];
      if (!effect.visible) continue;

      var base = {
        type: null,
        radius: effect.radius || 0,
        visible: effect.visible,
      };

      if (
        effect.type === "DROP_SHADOW" ||
        effect.type === "INNER_SHADOW"
      ) {
        base.offset = {
          x: (effect.offset && effect.offset.x) || 0,
          y: (effect.offset && effect.offset.y) || 0,
        };
        base.color = rgbaToObject(
          effect.color || { r: 0, g: 0, b: 0 },
          effect.color ? effect.color.a : undefined
        );
        base.spread = effect.spread || 0;
      }

      if (effect.type === "DROP_SHADOW") {
        base.type = "drop_shadow";
      } else if (effect.type === "INNER_SHADOW") {
        base.type = "inner_shadow";
      } else if (effect.type === "LAYER_BLUR") {
        base.type = "layer_blur";
      } else {
        base.type = "background_blur";
      }

      effects.push(base);
    }
  } catch (e) {
    // node may not have effects
  }

  return effects;
}

function extractCornerRadius(node) {
  try {
    if (
      node.cornerRadius !== undefined &&
      node.cornerRadius !== figma.mixed
    ) {
      return node.cornerRadius;
    }
    if (node.cornerRadius === figma.mixed) {
      return {
        tl: node.topLeftRadius || 0,
        tr: node.topRightRadius || 0,
        br: node.bottomRightRadius || 0,
        bl: node.bottomLeftRadius || 0,
      };
    }
  } catch (e) {
    // node may not have corner radius
  }
  return undefined;
}

function extractLayout(node) {
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
  } catch (e) {
    return undefined;
  }
}

function extractTextStyle(node) {
  var fontFamily = "Inter";
  if (node.fontName && typeof node.fontName === "object" && node.fontName.family) {
    fontFamily = node.fontName.family;
  }

  var fontWeight = 400;
  if (node.fontName && typeof node.fontName === "object" && node.fontName.style) {
    var style = node.fontName.style;
    if (style === "Bold") fontWeight = 700;
    else if (style === "SemiBold") fontWeight = 600;
    else if (style === "Medium") fontWeight = 500;
  }

  var lineHeight = undefined;
  if (node.lineHeight !== figma.mixed && typeof node.lineHeight === "object") {
    lineHeight = node.lineHeight.value;
  }

  var letterSpacing = undefined;
  if (node.letterSpacing !== figma.mixed && typeof node.letterSpacing === "object") {
    letterSpacing = node.letterSpacing.value;
  }

  var textAlign = "left";
  if (node.textAlignHorizontal === "CENTER") textAlign = "center";
  else if (node.textAlignHorizontal === "RIGHT") textAlign = "right";
  else if (node.textAlignHorizontal === "JUSTIFIED") textAlign = "justify";

  var textDecoration = "none";
  if (node.textDecoration === "UNDERLINE") textDecoration = "underline";
  else if (node.textDecoration === "STRIKETHROUGH") textDecoration = "strikethrough";

  return {
    fontFamily: fontFamily,
    fontSize: node.fontSize,
    fontWeight: fontWeight,
    lineHeight: lineHeight,
    letterSpacing: letterSpacing,
    textAlign: textAlign,
    fills: extractFills(node),
    textDecoration: textDecoration,
  };
}

function extractNode(node) {
  if (!node.visible && node.type !== "FRAME") return null;

  var base = {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    opacity: node.opacity !== undefined ? node.opacity : 1,
    visible: node.visible,
  };

  switch (node.type) {
    case "FRAME":
    case "COMPONENT":
    case "INSTANCE": {
      var children = [];
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          var extracted = extractNode(node.children[i]);
          if (extracted) children.push(extracted);
        }
      }
      return Object.assign(base, {
        type: "frame",
        layout: extractLayout(node),
        fills: extractFills(node),
        strokes: extractStrokes(node),
        effects: extractEffects(node),
        cornerRadius: extractCornerRadius(node),
        clipContent: node.clipsContent,
        children: children,
      });
    }

    case "TEXT": {
      return Object.assign(base, {
        type: "text",
        characters: node.characters,
        style: extractTextStyle(node),
      });
    }

    case "RECTANGLE": {
      return Object.assign(base, {
        type: "rectangle",
        fills: extractFills(node),
        strokes: extractStrokes(node),
        effects: extractEffects(node),
        cornerRadius: extractCornerRadius(node),
      });
    }

    case "ELLIPSE": {
      return Object.assign(base, {
        type: "ellipse",
        fills: extractFills(node),
        strokes: extractStrokes(node),
        effects: extractEffects(node),
      });
    }

    case "GROUP": {
      var children = [];
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          var extracted = extractNode(node.children[i]);
          if (extracted) children.push(extracted);
        }
      }
      return Object.assign(base, {
        type: "group",
        effects: extractEffects(node),
        children: children,
      });
    }

    default:
      return null;
  }
}

function extractPenBlueprint(selection) {
  if (selection.length === 0) return null;

  var root = selection[0];
  var rootNode = extractNode(root);
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
