// The landing page's one paragraph about how settlement runs. It is true in all three cases: the
// keeper is keeping up with Arc's node, it is behind, or it is down.
import type { Pace } from "../data/pace.ts";

export function settlementLine(pace: Pace): string {
  switch (pace.state) {
    case "prompt":
      return "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement runs on its own: a keeper with no special rights reads Arc's node and makes the calls anyone could make.";
    case "behind":
      return "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement needs no one in particular: anyone can make the calls, from this site or without it. The keeper that usually makes them within seconds is behind the chain right now.";
    case "down":
      return "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement needs no one in particular: anyone can make the calls, from this site or without it. The keeper that usually makes them within seconds is not answering right now.";
  }
}
