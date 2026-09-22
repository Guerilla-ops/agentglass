/*
 * The destination the app was last on, so it opens there again.
 *
 * Somebody who spends the day in pull requests should not be walked through
 * the terminal on every launch, and somebody who lives in the terminal should
 * not be walked through anything. One value, written when the bar changes
 * destination and read once when the app opens.
 *
 * The keystore is required lazily and by a literal name for the reason written
 * in theme.ts: Metro resolves `require` at build time by reading the string,
 * and `bun test` has no keystore, where the `null` is what lets this load.
 */
interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

function keystore(): KeystoreModule | null {
  try {
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null;
  }
}

const KEY = "agentglass.lastTab";

export async function readLastTab(): Promise<string | null> {
  try {
    return (await keystore()?.getItemAsync(KEY)) ?? null;
  } catch {
    return null; // unreadable is "never chosen", which opens the terminal
  }
}

let written: string | null = null;

export function rememberTab(route: string): void {
  if (route === written) return;
  written = route;
  void keystore()?.setItemAsync(KEY, route).catch(() => {
    // Not remembered: the next launch opens the terminal, which is the default
    // anyway. Nothing on a phone can act on a keystore that will not write.
  });
}
