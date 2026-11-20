// Links out to the block explorer. The explorer's address comes from the app's own configuration;
// what is appended to it is only ever a well-formed address or transaction hash, so nothing read
// from the chain, the keeper or a label can steer a link somewhere else.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** The explorer's page for an address or a transaction; null when there is no explorer or the value is not one. */
export function explorerLink(explorer: string | null, kind: "address" | "tx", value: string | null | undefined): string | null {
  if (explorer === null || typeof value !== "string") return null;
  if (!(kind === "address" ? ADDRESS : HASH).test(value)) return null;
  let base: URL;
  try {
    base = new URL(explorer);
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/${kind}/${value}`;
}
