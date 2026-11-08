// Tiny path router. Routes are exact matches; anything else renders "/".
// shortcut: hand-rolled on purpose, a router dep is heavier than this file.
export type Route = "/" | "/hello" | "/judge";

function current(): Route {
  if (typeof window === "undefined") return "/";
  if (window.location.pathname === "/hello") return "/hello";
  if (window.location.pathname === "/judge") return "/judge";
  return "/";
}

export const route = $state<{ path: Route }>({ path: current() });

export function navigate(to: Route) {
  history.pushState(null, "", to);
  route.path = current();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => (route.path = current()));
}
