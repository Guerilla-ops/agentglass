/*
 * The checkout, browsed and read.
 *
 * ── why it exists ────────────────────────────────────────────────────────
 * Everything this app could show you about a repository arrived through a
 * question somebody else had asked first: a pull request's diff, a commit's
 * subject, the files git happens to think are dirty. None of those answer "let
 * me look at that file", which is what somebody standing up actually wants
 * when a check has gone red and the log names a path.
 *
 * ── both calls are reads ─────────────────────────────────────────────────
 * `/files/tree` lists a directory and `/files/read` returns one file's text,
 * and both are GETs — so this whole screen works under a `read` grant, which
 * is the right shape for it. Looking at a file changes nothing, and the phone
 * most likely to be doing it is the one paired to look.
 *
 * ── one screen, two states ───────────────────────────────────────────────
 * A listing and a file, not two routes. The back gesture out of a file should
 * land on the directory it came from and nothing else, and a pushed route per
 * folder would build a stack somebody has to unwind a level at a time. The
 * crumbs at the top are the way up, and they are the same control in both states.
 *
 * ── what it will not do ──────────────────────────────────────────────────
 * Edit. A file is read here and changed where agents change files, which is
 * the pane behind the star — the same division the rest of this app follows,
 * and the reason it is a `read` screen at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ask } from "../src/lib/api.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { ChevronIcon, ReposIcon } from "../src/nav/icons.tsx";
import { Glyph } from "../src/nav/glyphs.tsx";
import { Card, Label, Note, TAP, groupEdge } from "../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

/** One row of `/files/tree`. Declared here rather than in shared/ — it is this
 *  route's reply and nothing else reads it. */
interface Entry { name: string; rel: string; dir: boolean }

/** How much of a file to draw.
 *
 *  A minified bundle is one line of four hundred kilobytes, and a phone asked
 *  to lay that out stops answering. The cap is on CHARACTERS rather than lines
 *  for that reason: a line count would let exactly that file through. */
const CAP = 60_000;

export default function FilesScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { root } = useLocalSearchParams<{ root: string }>();

  /** Where in the tree. "" is the top of the checkout. */
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  /** The file being read, and its text. Held together so a slow read cannot
   *  land under a file somebody has already moved on from. */
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host || !root || open) return;
    let gone = false;
    setEntries(null);
    void (async () => {
      const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
      const answer = await ask<{ ok: boolean; entries?: Entry[]; error?: string }>(
        host, `/files/tree?${query}`,
      );
      if (gone) return;
      if (!answer.ok) { setError(answer.error); return; }
      if (!answer.value.ok) { setError(answer.value.error || "That folder could not be read."); return; }
      setError(null);
      setEntries(answer.value.entries ?? []);
    })();
    return () => { gone = true; };
  }, [host, root, rel, open]);

  const read = useCallback(async (entry: Entry): Promise<void> => {
    if (!host || !root) return;
    setOpen(entry.rel);
    setText(null);
    setError(null);
    const query = `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(entry.rel)}`;
    const answer = await ask<{ ok: boolean; text?: string; error?: string }>(
      host, `/files/read?${query}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok) { setError(answer.value.error || "That file could not be read."); return; }
    setText(answer.value.text ?? "");
  }, [host, root]);

  /** Folders first, then files, each alphabetical — the order every file
   *  browser has used since there were folders, and the one that makes a
   *  directory of two hundred scannable. */
  const sorted = useMemo(() => [...(entries ?? [])].sort((a, b) => (
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  )), [entries]);

  const shown = text === null ? "" : text.length > CAP ? text.slice(0, CAP) : text;

  /* The crumbs: the checkout, then each folder down to where you are, each
     one a way straight back to it. A single "up" control made the way from a
     file four folders deep back to the top four taps; and it named where you
     were only as a path cut at the head. */
  const leaf = (root ?? "").split("/").filter(Boolean).pop() ?? "checkout";
  const parts = (open ?? rel).split("/").filter(Boolean);
  const goTo = useCallback((depth: number): void => {
    setOpen(null); setText(null); setError(null);
    setRel(parts.slice(0, depth).join("/"));
  }, [parts]);

  const copyPath = useCallback((): void => {
    if (!open) return;
    void Clipboard.setStringAsync(open);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [open]);

  // A file's final newline ends its last line; it does not start another.
  const lines = useMemo(() => (shown ? shown.replace(/\n$/, "").split("\n") : []), [shown]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View>
              <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "600", fontFamily: open ? MONO : undefined }}>
                {open ? parts[parts.length - 1] : "Files"}
              </Text>
              <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text3, fontSize: T.small }}>
                {open ? [leaf, ...parts.slice(0, -1)].join("/") : leaf}
              </Text>
            </View>
          ),
          headerRight: open ? () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy the path"
              onPress={copyPath}
              style={({ pressed }) => ({
                width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              <Glyph name="copy" color={C.text2} size={20} />
            </Pressable>
          ) : undefined,
        }}
      />

      {/* Drawn over a file too, with the file as the last crumb: the folder it
          is in is one tap away, which is where the back from a file should
          land and nowhere else. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: C.border }}
        contentContainerStyle={{ paddingHorizontal: SPACE.lg, alignItems: "center", gap: 4, minHeight: 48 }}
      >
        {[leaf, ...parts].map((name, i, all) => {
          const last = i === all.length - 1;
          return (
            <View key={`${i}:${name}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {i ? <ChevronIcon color={C.text3} size={14} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={last ? `${name}, here` : `Go to ${name}`}
                disabled={last}
                onPress={() => goTo(i)}
                hitSlop={{ top: 8, bottom: 8 }}
                style={{ paddingVertical: SPACE.md, paddingHorizontal: 2 }}
              >
                <Text style={{
                  color: last ? C.text : C.primary, fontSize: 13, fontFamily: MONO, fontWeight: last ? "600" : "500",
                }}>{name}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {error ? (
        <View style={{ padding: SPACE.lg }}>
          <Card><Label text="Cannot read it" /><Note tone="bad">{error}</Note></Card>
        </View>
      ) : null}

      {open ? (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
          {text === null && !error ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : null}
          {text !== null ? (
            <>
              {text.length > CAP ? (
                <Note>
                  Showing the first {Math.round(CAP / 1000)}k characters of {Math.round(text.length / 1000)}k.
                </Note>
              ) : null}
              {/* Its own horizontal scroller: a line of code is as long as it
                  is, and wrapping one at 393 points makes it unreadable in a
                  different way. The page never scrolls sideways; this does. */}
              <View style={{
                flexDirection: "row", backgroundColor: C.bg2, borderRadius: RADIUS.lg,
                borderWidth: 1, borderColor: C.border, marginTop: SPACE.sm, paddingVertical: SPACE.md,
              }}>
                {/* The numbers, as one column beside the text rather than a row
                    per line: a file is up to sixty thousand characters, and a
                    view per line of that is a phone that stops answering. */}
                <Text style={{
                  color: C.text3, fontSize: 11.5, fontFamily: MONO, lineHeight: 20, textAlign: "right",
                  paddingLeft: SPACE.sm, paddingRight: SPACE.md,
                }}>{lines.map((_, i) => i + 1).join("\n")}</Text>
                {/* Its own horizontal scroller: a line of code is as long as it
                    is, and wrapping one at 393 points makes it unreadable in a
                    different way. The page never scrolls sideways; this does. */}
                <ScrollView horizontal contentContainerStyle={{ paddingRight: SPACE.md }}>
                  <Text selectable style={{
                    color: C.text2, fontSize: 11.5, fontFamily: MONO, lineHeight: 20,
                  }}>{shown || "(empty)"}</Text>
                </ScrollView>
              </View>
              <Text style={{ color: C.text3, fontSize: T.small, paddingTop: SPACE.md, paddingHorizontal: SPACE.xs }}>
                {text.length < 1024 ? `${text.length} B` : `${(text.length / 1024).toFixed(1)} KB`} · read only
              </Text>
            </>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xl }}>
          {entries === null && !error ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : null}
          {entries && !entries.length ? <Card><Note>This folder is empty.</Note></Card> : null}
          {sorted.map((entry, i) => (
            <Pressable
              key={entry.rel}
              accessibilityRole="button"
              onPress={() => { if (entry.dir) setRel(entry.rel); else void read(entry); }}
              style={({ pressed }) => [
                groupEdge(i === 0, i === sorted.length - 1),
                {
                  flexDirection: "row", alignItems: "center", gap: 14,
                  paddingHorizontal: SPACE.lg, minHeight: 48,
                  backgroundColor: pressed ? C.bg3 : C.bg2,
                },
              ]}
            >
              {/* A folder reads as a folder before the name is read — drawn, for
                  the reason the whole of src/nav/icons.tsx exists. */}
              {entry.dir
                ? <ReposIcon color={C.primary} size={20} />
                : <Glyph name="file" color={C.text3} size={20} />}
              <Text
                numberOfLines={1}
                style={{
                  color: C.text, fontSize: 14, fontFamily: MONO, flex: 1,
                  fontWeight: entry.dir ? "500" : "400",
                }}
              >{entry.name}</Text>
              {entry.dir ? <ChevronIcon color={C.text3} size={18} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
