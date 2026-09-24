import { onColor } from "@kobecuppens/livechat-core";
import { useWorkspaceConfig } from "@kobecuppens/livechat-react/hooks";
import { createContext, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

export interface Theme {
  primary: string;
  onPrimary: string;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  danger: string;
  success: string;
}

export interface ThemeOverrides extends Partial<Theme> {
  scheme?: "light" | "dark";
}

export const ThemeOverridesContext = createContext<ThemeOverrides>({});


export function useTheme(): Theme {
  const overrides = useContext(ThemeOverridesContext);
  const system = useColorScheme();
  const config = useWorkspaceConfig();
  const dark = (overrides.scheme ?? system) === "dark";
  const primary = overrides.primary ?? config?.branding.primaryColor ?? "#4F46E5";
  return useMemo(
    () => ({
      primary,
      onPrimary: onColor(primary),
      ...(dark
        ? { bg: "#15171c", surface: "#1e2128", surface2: "#272b33", border: "#2e323b", text: "#f3f4f6", muted: "#9ca3af" }
        : { bg: "#ffffff", surface: "#f6f7f9", surface2: "#eceef2", border: "#e3e5ea", text: "#111827", muted: "#6b7280" }),
      danger: "#dc2626",
      success: "#16a34a",
      ...overrides,
    }),
    [primary, dark, overrides],
  );
}
