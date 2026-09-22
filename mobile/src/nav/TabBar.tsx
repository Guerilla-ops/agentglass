/*
 * The bar: four destinations, the terminal first.
 *
 * Written by hand rather than configured, because the stock bar pads each item
 * and centres a label under an icon, and this one draws the active destination
 * as a filled indicator behind its icon — the Material 3 shape, and the one
 * Android people already read as "you are here". Everything else is the stock
 * bar's behaviour reproduced deliberately: the tabPress event a listener can
 * prevent, the labels left free to scale, the bottom inset paid once.
 *
 * ── it was retired, and why it came back ─────────────────────────────────
 * For a while there was no bar: the Inbox was where the app arrived and every
 * other screen was a place it sent you, with a way back in each header. That
 * made every move between two destinations two moves, through a screen nobody
 * came for. The four are peers, and a bar is 64 points plus the gesture inset
 * well spent on peers — and handed back while typing, below.
 *
 * ── the keyboard ─────────────────────────────────────────────────────────
 * The bar is a flex sibling of the scene, so a window that resizes carries it
 * up to sit mid-screen over the list (API 34, photographed) and a window that
 * does not leaves it buried under the keys (API 36, photographed). React
 * Navigation's own answer, `tabBarHideOnKeyboard`, is read inside ITS bar and
 * this app draws its own, so the option is a no-op here and the rule has to be
 * in this file. While a keyboard is up the bar is not drawn at all.
 *
 * ── the two numbers, and the two it does not carry ────────────────────────
 * Terminal counts the gates held on you and PRs counts the reviews requested
 * of you. Both are lists the store already holds for every screen, so the
 * numbers cost nothing to keep current and cannot go stale on one screen while
 * another is right.
 *
 * Issues and cards carry none. Each would be another request on a component
 * that is mounted on every screen, and a number built from what happens to be
 * loaded would UNDERCOUNT silently, by exactly the rows it could not see — and
 * the one thing a badge cannot afford is to be a number nobody believes.
 */
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";
import { useAgentglass } from "../state/host-context.tsx";
import { useKeyboardShown } from "../state/use-keyboard.ts";
import { useTracksWork } from "../state/use-tracks-work.ts";
import { C, RADIUS, SPACE, T, ink, tint } from "../theme.ts";
import { BAR, taskDestinations, type TabRoute } from "./bar.ts";
import { rememberTab } from "./last.ts";
import { IssuesIcon, PrsIcon, TasksIcon, TerminalIcon, type IconProps } from "./icons.tsx";

/** Only the four the bar draws — the compiler is what keeps this in step with
 *  BAR, so a destination added there without a mark does not build. */
const ICON: Record<"terminal" | "prs" | "issues" | "tasks", (p: IconProps) => React.ReactNode> = {
  terminal: TerminalIcon,
  prs: PrsIcon,
  issues: IssuesIcon,
  tasks: TasksIcon,
};

/** The bar's own height above the gesture inset: a 32-point indicator, its
 *  label, and the breathing room Material gives both. */
export const BAR_HEIGHT = 64;

export function TabBar({ state, navigation }: BottomTabBarProps): React.ReactNode {
  const insets = useSafeAreaInsets();
  const typing = useKeyboardShown();
  const { host, fleet } = useAgentglass();
  const offered = taskDestinations(BAR, useTracksWork(host));
  const here = state.routes[state.index]?.name as TabRoute | undefined;

  useEffect(() => {
    if (here && BAR.some((d) => d.route === here)) rememberTab(here);
  }, [here]);

  if (typing) return null;

  const counts: Partial<Record<TabRoute, number>> = {
    terminal: fleet.gates.length,
    prs: new Set(
      fleet.prs
        .filter((r) => r.scope === "review" && r.pr.author !== fleet.me)
        .map((r) => `${r.repo}#${r.pr.number}`),
    ).size,
  };

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        backgroundColor: C.bg2,
        borderTopWidth: 1,
        borderTopColor: C.border,
        paddingBottom: insets.bottom,
      }}
    >
      {offered.map((dest) => {
        const route = state.routes.find((r) => r.name === dest.route);
        if (!route) return null;
        const on = here === dest.route;
        const Icon = ICON[dest.route as keyof typeof ICON];
        const n = counts[dest.route] ?? 0;
        const onPress = (): void => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!on && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable
            key={dest.route}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={n > 0 ? `${dest.label}, ${n} waiting on you` : dest.label}
            onPress={onPress}
            style={({ pressed }) => ({
              flex: 1, height: BAR_HEIGHT, alignItems: "center", justifyContent: "center", gap: SPACE.xs,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <View style={{
              width: 56, height: 32, borderRadius: RADIUS.lg, alignItems: "center", justifyContent: "center",
              backgroundColor: on ? tint(C.primary, 0.22) : "transparent",
            }}>
              {Icon ? <Icon color={on ? C.text : C.text3} size={22} /> : null}
              {n > 0 ? (
                <View style={{
                  position: "absolute", top: 0, left: 32, minWidth: 16, height: 16, borderRadius: 8,
                  paddingHorizontal: 4, alignItems: "center", justifyContent: "center",
                  backgroundColor: dest.route === "terminal" ? C.warning : C.primary,
                }}>
                  <Text style={{
                    color: ink(dest.route === "terminal" ? C.warning : C.primary),
                    fontSize: T.eyebrow, fontWeight: "700", lineHeight: 14,
                  }}>{n > 99 ? "99+" : n}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{
              color: on ? C.text : C.text3, fontSize: T.small, lineHeight: 16,
              fontWeight: on ? "600" : "500",
            }}>{dest.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
