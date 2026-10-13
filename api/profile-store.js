function mapProfile(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    location: row.location,
    biography: row.biography,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createProfileStore(database) {
  return {
    async getOrCreate(userId, accountName) {
      await database.query(
        `INSERT INTO player_profiles (user_id, display_name)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, accountName]
      );
      const result = await database.query(
        `SELECT user_id, display_name, location, biography, created_at, updated_at
         FROM player_profiles WHERE user_id = $1`,
        [userId]
      );
      return mapProfile(result.rows[0]);
    },

    async update(userId, profile) {
      const result = await database.query(
        `INSERT INTO player_profiles (user_id, display_name, location, biography)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           location = EXCLUDED.location,
           biography = EXCLUDED.biography,
           updated_at = now()
         RETURNING user_id, display_name, location, biography, created_at, updated_at`,
        [userId, profile.displayName, profile.location, profile.biography]
      );
      return mapProfile(result.rows[0]);
    }
  };
}
