// The words for the moments before any page can be shown: the app is misconfigured, or its
// labels file cannot be read. As with the other views, the components only lay these out.

/** Shown instead of the app when its configuration is wrong. `problem` is the configuration's own sentence, or null when the settings could not be read at all. */
export function startProblem(problem: string | null): { title: string; line: string; note: string } {
  return {
    title: "Boomerang cannot start",
    line: `This copy of the app is set up wrongly: ${problem ?? "its settings could not be read"}.`,
    note: "Nothing was read and nothing was sent. The contract itself is unaffected and can be read from any block explorer.",
  };
}

/** The name the wallet chooser gives the stand-in wallet on a developer's local chain. */
export const DEV_WALLET_NAME = "Local test wallet";
