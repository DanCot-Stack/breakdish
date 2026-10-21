import test from "node:test";
import assert from "node:assert/strict";
import { createMatchStore } from "./match-store.js";

test("foreign-key failures log only SQLSTATE and a sanitized constraint name", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));

  const rawError = Object.assign(
    new Error("private SQL, username, and submitted identifiers must not be logged"),
    {
      code: "23503",
      constraint: "matches_created_by_fkey",
      detail: "private account identifier",
      table: "matches"
    }
  );
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN" || sql.startsWith("SELECT set_config")) return { rows: [] };
      if (sql.includes("FROM platform_roles")) return { rows: [{ role: "super_admin" }] };
      if (sql.includes("INSERT INTO matches")) throw rawError;
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error("Unexpected test query.");
    },
    release() { this.released = true; }
  };
  const store = createMatchStore({ async connect() { return client; } });

  await assert.rejects(
    store.createMatch("synthetic-super-admin-id", {
      type: "practice",
      raceTo: 1,
      participants: [
        { userId: "synthetic-player-a", side: 1 },
        { userId: "synthetic-player-b", side: 2 }
      ],
      frames: [{ type: "singles" }]
    }, {
      testOnly: true,
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174099"
    }),
    (error) => error.status === 404 && error.message === "A referenced player, team, season or match could not be found."
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "BREAK DISH match foreign-key failure");
  assert.deepEqual(logs[0][1], { sqlstate: "23503", constraint: "matches_created_by_fkey" });
  const serializedLog = JSON.stringify(logs);
  assert.doesNotMatch(serializedLog, /private|synthetic|SELECT|INSERT|username/i);
  assert.ok(queries.includes("ROLLBACK"), "A failed creation rolls back its transaction.");
  assert.equal(client.released, true);
});

test("foreign-key diagnostic omits malformed constraint text", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const client = {
    async query(sql) {
      if (sql === "BEGIN" || sql.startsWith("SELECT set_config")) return { rows: [] };
      if (sql.includes("FROM platform_roles")) return { rows: [{ role: "super_admin" }] };
      if (sql.includes("INSERT INTO matches")) {
        throw Object.assign(new Error("private provider detail"), {
          code: "23503", constraint: "bad name; private detail"
        });
      }
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error("Unexpected test query.");
    },
    release() {}
  };
  const store = createMatchStore({ async connect() { return client; } });

  await assert.rejects(store.createMatch("synthetic-actor", {
    type: "practice",
    raceTo: 1,
    participants: [
      { userId: "synthetic-player-a", side: 1 },
      { userId: "synthetic-player-b", side: 2 }
    ],
    frames: [{ type: "singles" }]
  }, {
    testOnly: true,
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174099"
  }));

  assert.deepEqual(logs[0][1], { sqlstate: "23503", constraint: null });
  assert.doesNotMatch(JSON.stringify(logs), /private|synthetic|bad name/i);
});

test("non-foreign-key database errors are not written to the diagnostic log", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const client = {
    async query(sql) {
      if (sql === "BEGIN" || sql.startsWith("SELECT set_config")) return { rows: [] };
      if (sql.includes("FROM platform_roles")) return { rows: [{ role: "super_admin" }] };
      if (sql.includes("INSERT INTO matches")) {
        throw Object.assign(new Error("sensitive duplicate detail"), {
          code: "23505", constraint: "private_unique_constraint"
        });
      }
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error("Unexpected test query.");
    },
    release() {}
  };
  const store = createMatchStore({ async connect() { return client; } });

  await assert.rejects(store.createMatch("synthetic-actor", {
    type: "practice",
    raceTo: 1,
    participants: [
      { userId: "synthetic-player-a", side: 1 },
      { userId: "synthetic-player-b", side: 2 }
    ],
    frames: [{ type: "singles" }]
  }, {
    testOnly: true,
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174099"
  }), (error) => error.status === 409);

  assert.deepEqual(logs, []);
});
