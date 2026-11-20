// The stylesheets load one after another and share one page, so a class one of them styles bare
// reaches every element of that name. These tests hold the places where that once broke a page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const css = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Every selector of a stylesheet, one per entry, media queries opened up.
function selectors(sheet: string): string[] {
  const out: string[] = [];
  for (const m of sheet.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    for (const s of head.split(",")) out.push(s.trim());
  }
  return out;
}

describe("stylesheets", function () {
  it("styles.figure: My money's four figures are styled under .figures, so the campaign board's own .figure keeps its digits in a row", function () {
    const mine = selectors(css("lookup.css")).filter((s) => /\.figure(?![\w-])/.test(s));
    assert.ok(mine.length > 0, "the look-up page still styles its figures");
    for (const s of mine) assert.match(s, /^\.figures \.figure(?![\w-])/, `"${s}" would reach the campaign board's figure`);
    // And the board says which way its digits run, whatever else is loaded.
    const board = css("app.css").match(/\.campaign \.figure \{[^}]*\}/)?.[0] ?? "";
    assert.match(board, /flex-direction: row;/);
  });
});
