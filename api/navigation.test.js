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
  const [script, matchScript, liveScript, livePage, myLeagues, admin, createLeague] = await Promise.all([
    readFile(join(projectRoot, "script.js"), "utf8"),
    readFile(join(projectRoot, "match.js"), "utf8"),
    readFile(join(projectRoot, "live-matches.js"), "utf8"),
    readFile(join(projectRoot, "live-matches.html"), "utf8"),
    readFile(join(projectRoot, "my-leagues.html"), "utf8"),
    readFile(join(projectRoot, "admin.html"), "utf8"),
    readFile(join(projectRoot, "create-league.html"), "utf8")
  ]);
  assert.match(script, /apiRequest\("\/api\/me\/managed-leagues"\)/);
  assert.match(script, /apiRequest\("\/api\/me\/leagues"\)/);
  assert.match(script, /adminLink\.hidden = !adminAvailable/);
  assert.match(script, /mobileAccountSection\.hidden = !signedIn/);
  assert.match(script, /aria-expanded/);
  assert.match(script, /event\.key === "Escape"/);
  assert.doesNotMatch(script, /data-nav-logout|nav-logout/);
  assert.match(script, /create-league\.html\?manage=/);
  assert.match(matchScript, /search\.get\("leagueId"\)/);
  assert.match(matchScript, /filters\.set\("leagueId", filterLeagueId\)/);
  assert.match(matchScript, /const endpoint = query \? `\/api\/matches\?\$\{query\}` : "\/api\/matches"/);
  assert.match(matchScript, /previousMatches = search\.get\("status"\) === "completed"/);
  assert.match(matchScript, /filters\.set\("status", "completed"\)/);
  assert.match(matchScript, /match\.completedAt \|\| match\.scheduledAt/);
  assert.match(matchScript, /previousMatches \? "View Match" : "Open scoreboard"/);
  assert.match(matchScript, /const isFinal = match\.status === "completed"/);
  assert.match(matchScript, /if \(!signedIn && !isFinal\)/);
  assert.match(matchScript, /\/api\/matches\/\$\{encodeURIComponent\(matchId\)\}/);
  assert.match(matchScript, /match\.startedAt/);
  assert.match(matchScript, /showModal\(\)/);
  assert.match(matchScript, /setInterval\(refreshCurrentMatch, 4000\)/);
  assert.match(liveScript, /api\.request\("\/api\/matches\/live", \{ cache: "no-store" \}\)/);
  assert.match(liveScript, /setInterval\(refresh, 4000\)/);
  assert.match(liveScript, /match\.homeTeam \|\| match\.homeSideName/);
  assert.match(liveScript, /match\.currentFrame/);
  assert.match(livePage, /data-live-matches-page/);
  assert.match(livePage, /Live Matches/);
  assert.match(createLeague, /id="league-management"/);
  assert.match(myLeagues, /data-my-leagues-page/);
  assert.match(admin, /data-admin-page/);
});

test("all site headers use the required navigation groups without Contact Us or Log out", async () => {
  const pages = (await readdir(projectRoot)).filter((name) => name.endsWith(".html"));
  for (const name of pages) {
    const html = await readFile(join(projectRoot, name), "utf8");
    const nav = html.match(/<nav id="primary-nav"[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, `${name} must have the shared main navigation.`);
    assert.doesNotMatch(nav, /Contact Us|Log out|Log In|Sign Up/i, `${name} must not put contact or auth actions in the global navigation.`);
    assert.match(nav, /href="admin\.html" data-nav-admin hidden/, `${name} keeps Admin hidden until a managed-league role is confirmed.`);
    assert.match(nav, /<details class="nav-dropdown" data-nav-dropdown>[\s\S]*?href="my-leagues\.html"[\s\S]*?href="create-league\.html"[\s\S]*?href="join-league\.html"[\s\S]*?href="index\.html#tables"/);
    const matchDropdown = nav.match(/<details class="nav-dropdown" data-nav-dropdown><summary aria-expanded="false">Match Centre[\s\S]*?<div class="nav-dropdown-menu">([\s\S]*?)<\/div><\/details>/)?.[1];
    assert.ok(matchDropdown, `${name} keeps Match Centre as the dropdown heading.`);
    assert.deepEqual([...matchDropdown.matchAll(/<a href="([^"]+)"/g)].map((link) => link[1]), [
      "live-matches.html",
      "match.html?status=completed"
    ], `${name} lists Live Matches before Previous Matches.`);
    assert.match(matchDropdown, /data-nav-previous-matches/);
    assert.match(nav, /data-nav-mobile-account/);
  }
});
