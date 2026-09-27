// A test server's port comes from freePort(), never from a die.
//
// freePort.ts says why: two servers that roll the same number do not fail to
// bind, they answer each other's /health, and the file then drives somebody
// else's process. Nine files had drifted back to `4930 + Math.random() * 30`,
// and it showed as a different agent-cli / usage test red on each full run,
// most often on a machine running several suites at once.
import { expect, test } from "bun:test";
import { Glob } from "bun";

const files = [...new Glob("*.test.ts").scanSync(import.meta.dir)].filter((f) => f !== "no-rolled-ports.test.ts");
const sources = await Promise.all(files.map(async (f) => [f, await Bun.file(`${import.meta.dir}/${f}`).text()] as const));

// A literal port base plus Math.random, on one line: the shape the nine had.
const ROLLED = /\b[1-9]\d{3}\s*\+\s*(?:Math\.floor\()?Math\.random\(\)/;

test("no test file picks its server port with Math.random", () => {
  expect(sources.length, "the glob found the test files").toBeGreaterThan(100);
  const rolled = sources
    .filter(([, text]) => text.split("\n").some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && ROLLED.test(l)))
    .map(([f]) => f);
  expect(rolled).toEqual([]);
});

test("the pattern matches the line it exists to catch", () => {
  expect(ROLLED.test("const port = 4930 + Math.floor(Math.random() * 30);")).toBe(true);
  expect(ROLLED.test("const port = await freePort();")).toBe(false);
});
