/**
 * Text color for a hex background: whichever of white or near-black has the higher WCAG
 * contrast ratio (a fixed luminance threshold put white on mid-tone brands like #10B981).
 */
export function onColor(hex: string): string {
  const full = /^#[0-9a-f]{3}$/i.test(hex) ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const n = parseInt(full.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const DARK_TEXT_LUMINANCE = 0.0137; // #111827
  const contrastWhite = 1.05 / (luminance + 0.05);
  const contrastDark = (luminance + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  return contrastDark >= contrastWhite ? "#111827" : "#ffffff";
}
