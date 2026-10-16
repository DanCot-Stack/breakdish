import test from "node:test";
import assert from "node:assert/strict";
import { createLeagueStore } from "./league-store.js";

test("My Leagues query separates active membership from recorded player participation", async () => {
  let statement = "";
  let values;
  const store = createLeagueStore({
    async query(sql, params) {
      statement = sql;
      values = params;
      return { rows: [{
        id: "league-1", name: "Local League", viewer_role: "administrator", viewer_status: "active",
        viewer_is_player: true, current_season_name: "Autumn", current_season_status: "active"
      }] };
    }
  });

  const [league] = await store.listMine("signed-in-user");
  assert.deepEqual(values, ["signed-in-user"]);
  assert.match(statement, /m\.status = 'active'/);
  assert.match(statement, /m\.role = 'member' OR/);
  assert.match(statement, /team_registrations/);
  assert.match(statement, /competition_entry_participants/);
  assert.match(statement, /match_participants/);
  assert.equal(league.viewerMembership.role, "administrator");
  assert.equal(league.viewerIsPlayer, true);
  assert.deepEqual(league.currentSeason, { name: "Autumn", status: "active" });
});

test("Admin league query includes only the signed-in user's active owner or administrator roles", async () => {
  let statement = "";
  let values;
  const store = createLeagueStore({
    async query(sql, params) {
      statement = sql;
      values = params;
      return { rows: [
        { id: "owned", name: "Owned League", viewer_role: "owner", viewer_status: "active" },
        { id: "managed", name: "Managed League", viewer_role: "administrator", viewer_status: "active" }
      ] };
    }
  });

  const leagues = await store.listManaged("signed-in-user");
  assert.deepEqual(values, ["signed-in-user"]);
  assert.match(statement, /m\.user_id = \$1/);
  assert.match(statement, /m\.status = 'active'/);
  assert.match(statement, /m\.role IN \('owner', 'administrator'\)/);
  assert.deepEqual(leagues.map((league) => league.viewerMembership.role), ["owner", "administrator"]);
});
