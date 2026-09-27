/*
 * `expo-camera`'s plugin config used to pass `recordAudioAndroid: false`,
 * which strips RECORD_AUDIO from the built manifest — a permission the
 * camera plugin does not otherwise ask for, so nothing else in this file
 * grants it, and the mic can never be granted no matter what the person taps.
 */
import { describe, expect, it } from "bun:test";

const app = JSON.parse(await Bun.file(new URL("../app.json", import.meta.url)).text());

describe("app.json", () => {
  it("does not block RECORD_AUDIO through the camera plugin", () => {
    const camera = app.expo.plugins.find(
      (p: unknown) => Array.isArray(p) && p[0] === "expo-camera",
    );
    expect(camera).toBeDefined();
    expect(camera[1]?.recordAudioAndroid).not.toBe(false);
  });

  it("declares the microphone permission on Android", () => {
    expect(app.expo.android.permissions).toContain("android.permission.RECORD_AUDIO");
  });
});
