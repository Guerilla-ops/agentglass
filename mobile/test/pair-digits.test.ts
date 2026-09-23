/*
 * Six boxes, one field.
 *
 * The digits are drawn as six boxes over a single real input, so a paste of
 * all six lands at once and the auto-submit on the sixth digit has one value to
 * watch. Six inputs would each need their own focus hand-off, and the paste
 * would land in the first box only.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/pair.tsx", import.meta.url)).text();

describe("the six digits", () => {
  test("are one input, digits only, six long, with the number pad", () => {
    const at = src.indexOf('accessibilityLabel="The six digits"');
    expect(at).toBeGreaterThan(-1);
    const input = src.slice(src.lastIndexOf("<TextInput", at), src.indexOf("/>", at));
    expect(input).toContain("ref={digits}");
    expect(input).toContain('keyboardType="number-pad"');
    expect(input).toContain("maxLength={6}");
    expect(input).toContain('text.replace(/\\D/g, "").slice(0, 6)');
  });

  test("and the boxes are drawn from that one value", () => {
    expect(src).toContain("Array.from({ length: 6 }");
    expect(src).toContain("{code[i] ?? \"\"}");
  });
});
