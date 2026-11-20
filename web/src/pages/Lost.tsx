import { lostPage } from "../views/campaign.ts";
import { WORDS } from "../views/shell.ts";

export function Lost({ hash }: { hash: string }) {
  const page = lostPage(hash);
  return (
    <section className="lost">
      <h1>{page.title}</h1>
      {page.line ? <p>{page.line}</p> : null}
      <p>
        <a href={page.homeHref}>{WORDS.campaign.back}</a>
      </p>
    </section>
  );
}
