import { parseMarkdown, type Block, type Inline } from "@kobecuppens/livechat-core";
import { useMemo, type ReactNode } from "react";
import { Image, Linking, Text, View, type TextStyle } from "react-native";
import { useTheme, type Theme } from "./theme";

function inline(nodes: Inline[], theme: Theme, color: string, key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return (
          <Text key={k} style={{ fontWeight: "700" }}>
            {inline(n.children, theme, color, k)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} style={{ fontStyle: "italic" }}>
            {inline(n.children, theme, color, k)}
          </Text>
        );
      case "code":
        return (
          <Text key={k} style={{ fontFamily: "Menlo", backgroundColor: theme.surface2, fontSize: 13 }}>
            {n.text}
          </Text>
        );
      case "break":
        return "\n";
      case "link":
        return (
          <Text key={k} accessibilityRole="link" style={{ color: color === theme.text ? theme.primary : color, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(n.href)}>
            {inline(n.children, theme, color, k)}
          </Text>
        );
      case "image":
        // Images can't nest in Text; block rendering lifts them out (see below).
        return null;
    }
  });
}

function images(nodes: Inline[]): { src: string; alt: string }[] {
  return nodes.flatMap((n) => (n.type === "image" ? [n] : "children" in n ? images(n.children) : []));
}

function block(b: Block, i: number, theme: Theme, color: string, base: TextStyle): ReactNode {
  const text = (nodes: Inline[], style?: TextStyle) => (
    <View key={i} style={{ marginBottom: 10 }}>
      <Text style={[base, style]}>{inline(nodes, theme, color)}</Text>
      {images(nodes).map((img) => (
        <Image key={img.src} source={{ uri: img.src }} accessibilityLabel={img.alt} style={{ width: "100%", height: 200, marginTop: 8, borderRadius: 10 }} resizeMode="contain" />
      ))}
    </View>
  );
  switch (b.type) {
    case "heading":
      return text(b.children, { fontSize: [22, 19, 17, 15][b.level - 1], fontWeight: "700", marginTop: 6 });
    case "paragraph":
      return text(b.children);
    case "list":
      return (
        <View key={i} style={{ marginBottom: 10 }}>
          {b.items.map((item, j) => (
            <View key={j} style={{ flexDirection: "row", marginBottom: 4 }}>
              <Text style={[base, { width: 22 }]}>{b.ordered ? `${j + 1}.` : "•"}</Text>
              <Text style={[base, { flex: 1 }]}>{inline(item, theme, color)}</Text>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: theme.border, paddingLeft: 10, marginBottom: 10 }}>
          {b.children.map((c, j) => block(c, j, theme, theme.muted, { ...base, color: theme.muted }))}
        </View>
      );
    case "codeblock":
      return (
        <View key={i} style={{ backgroundColor: theme.surface2, padding: 10, borderRadius: 8, marginBottom: 10 }}>
          <Text style={{ fontFamily: "Menlo", fontSize: 13, color }}>{b.text}</Text>
        </View>
      );
    case "rule":
      return <View key={i} style={{ height: 1, backgroundColor: theme.border, marginVertical: 12 }} />;
  }
}

/** Renders markdown via the safe AST (no HTML, no WebView). */
/** Images are off unless `images` is set (help articles): in chat they'd act as tracking pixels. */
export function Markdown({ source, color, fontSize = 15, images = false }: { source: string; color?: string; fontSize?: number; images?: boolean }) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(source, { images }), [source, images]);
  const c = color ?? theme.text;
  const base: TextStyle = { color: c, fontSize, lineHeight: fontSize * 1.45 };
  const out = blocks.map((b, i) => block(b, i, theme, c, base));
  return <View style={{ marginBottom: -10 }}>{out}</View>;
}
