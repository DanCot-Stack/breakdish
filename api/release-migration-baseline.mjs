export const MIGRATION_012 = "012_test_only_practice_matches";
export const MIGRATION_013 = "013_race_to_match_formats";

export const APPLICATION_MIGRATIONS_001_012 = Object.freeze([
  "001_initial_profiles_and_leagues",
  "002_league_membership_workflow",
  "003_seasons_divisions_teams",
  "004_auditable_team_signings",
  "005_protect_registration_history",
  "006_require_official_start_for_signings",
  "007_match_categories_and_practice_stats",
  "008_doubles_league_match_sides",
  "009_fixture_round_numbers",
  "010_platform_roles",
  "011_backup_super_admin",
  MIGRATION_012
]);

export const APPLICATION_MIGRATIONS_001_013 = Object.freeze([
  ...APPLICATION_MIGRATIONS_001_012,
  MIGRATION_013
]);

export function compareApplicationMigrationHistory(actualNames, expectedNames) {
  const expectedSet = new Set(expectedNames);
  const actualSet = new Set(actualNames);
  return {
    migrationHistoryMatches: actualNames.length === expectedNames.length &&
      expectedNames.every((name, index) => actualNames[index] === name),
    missingMigrations: expectedNames.filter((name) => !actualSet.has(name)),
    unexpectedMigrations: actualNames.filter((name) => !expectedSet.has(name)),
    migration012Applied: actualSet.has(MIGRATION_012),
    migration013Applied: actualSet.has(MIGRATION_013)
  };
}
