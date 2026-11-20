// Start-up: read the configuration (a bad value stops here, on a plain screen that names it),
// fetch this site's labels file, and hand both to the app.
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./app/App.tsx";
import { configFrom, ConfigError, type Config } from "./app/config.ts";
import { readLabels, type Label } from "./data/labels.ts";
// The faces, self-hosted (OFL-1.1): Fraunces for headings and the cheque's hand (all its axes,
// upright and italic), Geist for sentences and figures, Geist Mono for addresses.
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/fraunces/full-italic.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
// One world, in this order: what every page shares, then each surface's own sheet.
import "./styles/world.css";
import "./styles/scene.css";
import "./styles/cheque.css";
import "./styles/landing.css";
import "./styles/app.css";
import "./styles/lookup.css";
import "./styles/backers.css";
import "./styles/checks.css";
import { DEV_WALLET_NAME, startProblem } from "./views/start.ts";
import { devWallet, devWalletFrom } from "./wallet/devWallet.ts";
import type { FoundWallet } from "./wallet/injected.ts";

// One root per page. The dev server re-runs this file when it changes, so the root is kept on the element.
const host = document.getElementById("root") as HTMLElement & { boomerangRoot?: Root };
const root = (host.boomerangRoot ??= createRoot(host));

function Stopped({ problem }: { problem: string | null }) {
  const page = startProblem(problem);
  return (
    <main className="stopped">
      <h1>{page.title}</h1>
      <p>{page.line}</p>
      <p className="quiet">{page.note}</p>
    </main>
  );
}

// The labels are this site's words for its campaigns. A labels file that is missing or unreadable
// means campaigns are shown by number, never that the app stops.
async function labelsFile(): Promise<Label[]> {
  try {
    const res = await fetch("./labels.json", { cache: "no-store", credentials: "omit" });
    return res.status === 200 ? readLabels(await res.json()) : [];
  } catch {
    return [];
  }
}

async function start(): Promise<void> {
  let config: Config;
  let extra: FoundWallet | null = null;
  try {
    config = configFrom(import.meta.env);
    const address = devWalletFrom(import.meta.env, config);
    if (address !== null) extra = devWallet({ name: DEV_WALLET_NAME, address, chainId: config.chain.id, rpcUrl: config.chain.rpcUrl, fetch: (url, init) => fetch(url, init) });
  } catch (e) {
    root.render(<Stopped problem={e instanceof ConfigError ? e.message : null} />);
    return;
  }
  const labels = await labelsFile();
  root.render(
    <StrictMode>
      <App config={config} labels={labels} extraWallet={extra} />
    </StrictMode>,
  );
}

void start();
