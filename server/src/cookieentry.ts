/**
 * `agentglass-server cookies …` and `agentglass-server plugin-bridge …`,
 * both handled before anything else loads.
 *
 * The packaged app ships one executable — the compiled sidecar — so a
 * one-shot subcommand has to be reachable through it. Neither can be a
 * branch further down index.ts: ESM evaluates every import first, and
 * index.ts's imports open the application database and start timers on the
 * way past. So this module is index.ts's FIRST import, and each subcommand
 * exits the process before any of that runs.
 *
 * `plugin-bridge` is what a `network: "agentglass"` box's entrypoint is
 * wrapped in (see the network comment on `sandboxArgv` in
 * plugin-sandbox.ts): the same executable, re-invoked with this one extra
 * argument, so the box needs no second binary mounted into it.
 *
 * Nothing happens here for a normal boot.
 */
if (process.argv[2] === "cookies") {
  const { runCookieReader } = await import("./cookieread.ts");
  process.exit(await runCookieReader(process.argv.slice(3)));
}
if (process.argv[2] === "plugin-bridge") {
  const { runPluginBridge } = await import("./plugin-bridge.ts");
  process.exit(await runPluginBridge(process.argv.slice(3)));
}

export {};
