import { expect, test } from "bun:test";
import { Glob } from "bun";

// From SDK 54 the bare "expo-file-system" functions throw when called, which a
// typecheck does not see. Anything that reads a file goes through "/legacy".
test("no source imports the bare expo-file-system entry point", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("{app,src}/**/*.{ts,tsx}").scan({ cwd: `${import.meta.dir}/..` })) {
    const text = await Bun.file(`${import.meta.dir}/../${f}`).text();
    if (/from\s+["']expo-file-system["']/.test(text)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
