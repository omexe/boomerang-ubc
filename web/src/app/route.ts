// Where the visitor is, kept in the address bar's hash so the app can be served as plain files
// from any host with no rewrite rules: #/ , #/campaign/3 , #/campaign/3/pledge , #/mine ,
// #/mine/0x… (another account's money) , #/proof
import type { Address } from "../../../packages/kit/src/index.ts";

export type Route =
  | { page: "home" }
  | { page: "campaign"; id: bigint }
  | { page: "pledge"; id: bigint }
  | { page: "mine"; who?: Address }
  | { page: "proof" }
  | { page: "lost"; hash: string };

const ID = /^[1-9][0-9]{0,17}$/; // a campaign id: a whole number from 1, small enough to be an id
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The route a hash names. Anything not understood is "lost", with what was asked for. */
export function routeOf(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (path === "") return { page: "home" };
  const parts = path.split("/");
  if (parts.length === 1 && parts[0] === "mine") return { page: "mine" };
  if (parts.length === 2 && parts[0] === "mine" && ADDRESS.test(parts[1])) return { page: "mine", who: parts[1] as Address };
  if (parts.length === 1 && parts[0] === "proof") return { page: "proof" };
  if (parts[0] === "campaign" && parts.length >= 2 && ID.test(parts[1])) {
    const id = BigInt(parts[1]);
    if (parts.length === 2) return { page: "campaign", id };
    if (parts.length === 3 && parts[2] === "pledge") return { page: "pledge", id };
  }
  return { page: "lost", hash };
}

/** The hash that names a route; `routeOf(hrefFor(r))` is `r` again. */
export function hrefFor(route: Route): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "campaign":
      return `#/campaign/${route.id}`;
    case "pledge":
      return `#/campaign/${route.id}/pledge`;
    case "mine":
      return route.who ? `#/mine/${route.who}` : "#/mine";
    case "proof":
      return "#/proof";
    case "lost":
      return route.hash;
  }
}
