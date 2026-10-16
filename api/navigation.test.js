import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const attribute = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("all local HTML links and anchor targets resolve", async () => {
  const pages = (await readdir(projectRoot)).filter((name) => name.endsWith(".html"));
  const contents = new Map(await Promise.all(pages.map(async (name) => [name, await readFile(join(projectRoot, name), "utf8")])));
  const broken = [];

  for (const [source, html] of contents) {
    for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|tel:|javascript:|data:|\/\/)/i.test(href)) continue;
      const [pathAndQuery, fragment] = href.split("#", 2);
      const localPath = pathAndQuery.split("?", 1)[0];
      const target = localPath ? localPath.split(/[\\/]/).at(-1) : source;
      const targetHtml = contents.get(target);
      try {
        await access(join(projectRoot, localPath || source));
      } catch {
        broken.push(`${source}: missing ${target}`);
        continue;
      }
      if (fragment && targetHtml && !new RegExp(`\\bid=["']${attribute(decodeURIComponent(fragment))}["']`).test(targetHtml)) {
        broken.push(`${source}: missing ${target}#${fragment}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});

test("signed-in navigation, filtered Match Centre and league management shortcuts use their routes", async () => {
  const [script, matchScript, myLeagues, admin, createLeague] = await Promise.all([
    readFile(join(projectRoot, "script.js"), "utf8"),
    readFile(join(projectRoot, "match.js"), "utf8"),
    readFile(join(projectRoot, "my-leagues.html"), "utf8"),
    readFile(join(projectRoot, "admin.html"), "utf8"),
    readFile(join(projectRoot, "create-league.html"), "utf8")
  ]);
  assert.match(script, /apiRequest\("\/api\/me\/managed-leagues"\)/);
  assert.match(script, /apiRequest\("\/api\/me\/leagues"\)/);
  assert.match(script, /placeSessionNavLinks\(navigation, adminAvailable\)/);
  assert.match(script, /create-league\.html\?manage=/);
  assert.match(matchScript, /search\.get\("leagueId"\)/);
  assert.match(matchScript, /\/api\/matches\?leagueId=/);
  assert.match(createLeague, /id="league-management"/);
  assert.match(myLeagues, /data-my-leagues-page/);
  assert.match(admin, /data-admin-page/);
});
