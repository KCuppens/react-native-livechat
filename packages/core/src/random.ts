/**
 * 128-bit random id. The anonymous device id is effectively a credential (it binds an
 * anonymous contact), so it must come from a CSPRNG. On React Native, install
 * `react-native-get-random-values` (or use Expo, which provides it).
 */
export function secureRandomId(bytes = 16): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error(
      "[livechat] crypto.getRandomValues is not available. On React Native, import 'react-native-get-random-values' before the SDK.",
    );
  }
  return [...c.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
