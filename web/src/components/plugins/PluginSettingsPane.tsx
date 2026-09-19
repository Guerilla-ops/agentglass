import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Field } from "../../lib/pluginTypes.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { Spinner } from "../Spinner.tsx";
import { FieldRow } from "./PluginTree.tsx";

/**
 * A plugin's settings page, drawn from the fields its manifest declared.
 *
 * Every field saves on its own when it is committed — a toggle when flipped,
 * a text box when it loses focus — like every other page in Settings, where
 * there is no Save button to forget. What is stored is typed by the manifest
 * on the server, so the plugin reads a list where it declared a list whatever
 * was typed here. The plugin hears each save as a `settings` event.
 */
export function PluginSettingsPane({ name, open }: { name: string; open: boolean }) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (keepValues: boolean) => {
    try {
      const r = await api.pluginSettings(name);
      if (!r.ok) { setError(r.error ?? "no such plugin"); setFields([]); return; }
      setFields(r.fields);
      if (!keepValues) setValues(r.values);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  useEffect(() => { if (open) void load(false); }, [open, load]);
  // The plugin can publish the choices for a select once it has looked
  // around (which agents are installed, say); pick those up without losing
  // what is being typed.
  useEffect(() => subscribePluginFrame((f) => { if (f.kind === "panels") void load(true); }), [load]);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const commit = async (key: string, v: unknown) => {
    const r = await api.pluginSettingsSave(name, { [key]: v });
    if (!r.ok) { setError(r.error ?? "not saved"); return; }
    if (r.values) setValues(r.values);
    setError(null);
    setSaved(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1600);
  };

  if (fields === null) return <div className="px-4 py-6"><Spinner label="Loading settings…" /></div>;

  return (
    <div className="flex flex-col gap-4 px-1 pb-6">
      {error && (
        <div className="text-[11.5px] rounded-md px-3 py-2" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 8%, transparent)" }}>{error}</div>
      )}
      <div className="rounded-lg flex flex-col" style={{ background: "var(--surface-card)", border: "1px solid var(--surface-line)" }}>
        {fields.map((f, i) => (
          <div key={f.key} className="px-4 py-3.5 flex flex-col gap-1" style={{ borderTop: i ? "1px solid var(--surface-line)" : undefined }}>
            <FieldRow field={f} value={values[f.key]}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              onCommit={(v) => { void commit(f.key, v); }} />
            <div className="h-3 text-[10.5px]" style={{ color: "var(--success)" }} aria-live="polite">{saved === f.key ? "Saved" : ""}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] m-0 px-1" style={{ color: "var(--text3)" }}>
        These are {name}'s own settings, declared in its manifest and kept by this app. The plugin reads them over its
        own token and hears every change.
      </p>
    </div>
  );
}
