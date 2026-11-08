// Shape of the frontend. Edit this file — or ask the model to — to reshape the UI.
// Examples the model can do in one edit here:
// - "single column chat"  -> layout: "single"
// - "chat + inspector"     -> layout: "focus"
// - "hide traffic"         -> showTraffic: false
// - "hide run figures"     -> showStats: false
// Panels are one component tag each in App.svelte; to move a panel,
// move its tag. Each panel owns its wrapper (<aside>/ <main>/ <footer>),
// so the grid follows the tags.

export type LayoutMode = "triple" | "focus" | "single";

export interface Shape {
  layout: LayoutMode;
  showStats: boolean;
  showTraffic: boolean;
}

export const shape: Shape = {
  layout: "triple",
  showStats: true,
  showTraffic: true,
};
