import { useMessenger, useTranslate } from "@kobecuppens/livechat-react/hooks";
import type { ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1]![0] : "")).toUpperCase() || "?";
}

export function Avatar({ name, url, size = 32, brand }: { name: string | null | undefined; url?: string | null; size?: number; brand?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: brand ? theme.primary : theme.surface2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} />
      ) : (
        <Text style={{ color: brand ? theme.onPrimary : theme.text, fontWeight: "600", fontSize: size * 0.4 }}>{initials(name)}</Text>
      )}
    </View>
  );
}

/** Minimal icon glyphs so the SDK has no icon-font dependency. */
export function Glyph({ name, color, size = 20 }: { name: "back" | "close" | "chevron" | "send" | "attach" | "search"; color: string; size?: number }) {
  const map = { back: "‹", close: "✕", chevron: "›", send: "➤", attach: "📎", search: "⌕" };
  return <Text style={{ color, fontSize: name === "back" || name === "chevron" ? size * 1.5 : size, lineHeight: size * 1.4, includeFontPadding: false }}>{map[name]}</Text>;
}

export function IconButton({ onPress, label, children, disabled }: { onPress: () => void; label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} hitSlop={8} style={({ pressed }) => [styles.iconBtn, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      {children}
    </Pressable>
  );
}

export function Header({ title, subtitle, avatar, onClose }: { title: string; subtitle?: string; avatar?: ReactNode; onClose?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  const messenger = useMessenger();
  return (
    <View style={[styles.header, { borderBottomColor: theme.border, backgroundColor: theme.bg }]}>
      {messenger.canGoBack && (
        <IconButton onPress={messenger.back} label={t("common.back")}>
          <Glyph name="back" color={theme.text} />
        </IconButton>
      )}
      {avatar}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: theme.text, fontSize: 16, fontWeight: "600" }} accessibilityRole="header">
          {title}
        </Text>
        {!!subtitle && (
          <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>
            {subtitle}
          </Text>
        )}
      </View>
      {onClose && (
        <IconButton onPress={onClose} label={t("common.close")}>
          <Glyph name="close" color={theme.muted} size={18} />
        </IconButton>
      )}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return <View style={[styles.card, { backgroundColor: theme.bg, borderColor: theme.border }, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: string }) {
  const theme = useTheme();
  return <Text style={{ color: theme.muted, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>{children}</Text>;
}

export function Row({ title, subtitle, onPress, left, right, first }: { title: string; subtitle?: string | null; onPress: () => void; left?: ReactNode; right?: ReactNode; first?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, { borderTopColor: theme.border, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: pressed ? theme.surface : "transparent" }]}
    >
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.text, fontSize: 15, fontWeight: "500" }} numberOfLines={2}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }} numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {right ?? <Glyph name="chevron" color={theme.muted} size={16} />}
    </Pressable>
  );
}

export function Loading() {
  const theme = useTheme();
  const t = useTranslate();
  return (
    // `accessible` makes this one focusable element so screen readers announce it.
    <View style={{ padding: 32 }} accessible accessibilityRole="progressbar" accessibilityLabel={t("common.loading")}>
      <ActivityIndicator color={theme.primary} />
    </View>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const theme = useTheme();
  const t = useTranslate();
  return (
    <View style={{ padding: 32, alignItems: "center" }} accessibilityRole="alert">
      <Text style={{ color: theme.muted }}>{t("common.error")}</Text>
      {onRetry && (
        <Pressable onPress={onRetry} accessibilityRole="button" style={{ marginTop: 8 }}>
          <Text style={{ color: theme.primary, fontWeight: "600" }}>{t("common.retry")}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function PrimaryButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({ backgroundColor: theme.primary, paddingVertical: 11, paddingHorizontal: 18, borderRadius: 12, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, alignItems: "center" })}
    >
      <Text style={{ color: theme.onPrimary, fontWeight: "600", fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
});
