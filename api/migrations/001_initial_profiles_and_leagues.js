export const up = (pgm) => {
  pgm.createTable("player_profiles", {
    user_id: {
      type: "text",
      primaryKey: true,
      references: '"user"',
      onDelete: "CASCADE"
    },
    display_name: { type: "varchar(80)", notNull: true },
    profile_image_url: { type: "text" },
    location: { type: "varchar(120)" },
    biography: { type: "varchar(500)" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("player_profiles", "player_profiles_display_name_nonempty", {
    check: "length(trim(display_name)) > 0"
  });

  pgm.createTable("leagues", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(120)", notNull: true },
    slug: { type: "varchar(140)", notNull: true, unique: true },
    description: { type: "varchar(1000)" },
    location: { type: "varchar(160)" },
    status: { type: "varchar(16)", notNull: true, default: "draft" },
    created_by: {
      type: "text",
      notNull: true,
      references: '"user"',
      onDelete: "RESTRICT"
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("leagues", "leagues_name_nonempty", {
    check: "length(trim(name)) > 0"
  });
  pgm.addConstraint("leagues", "leagues_slug_format", {
    check: "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"
  });
  pgm.addConstraint("leagues", "leagues_status_allowed", {
    check: "status IN ('draft', 'open', 'active', 'archived')"
  });
  pgm.createIndex("leagues", "created_by");
  pgm.createIndex("leagues", "status");

  pgm.createTable("league_memberships", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    league_id: {
      type: "uuid",
      notNull: true,
      references: '"leagues"',
      onDelete: "CASCADE"
    },
    user_id: {
      type: "text",
      notNull: true,
      references: '"user"',
      onDelete: "CASCADE"
    },
    role: { type: "varchar(20)", notNull: true, default: "member" },
    status: { type: "varchar(16)", notNull: true, default: "pending" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("league_memberships", "league_memberships_league_user_unique", {
    unique: ["league_id", "user_id"]
  });
  pgm.addConstraint("league_memberships", "league_memberships_role_allowed", {
    check: "role IN ('owner', 'administrator', 'member')"
  });
  pgm.addConstraint("league_memberships", "league_memberships_status_allowed", {
    check: "status IN ('pending', 'active', 'suspended', 'left')"
  });
  pgm.createIndex("league_memberships", "user_id");
  pgm.createIndex("league_memberships", ["league_id", "status"]);
  pgm.createIndex("league_memberships", "league_id", {
    unique: true,
    where: "role = 'owner'",
    name: "league_memberships_single_owner"
  });

  pgm.sql(`
    CREATE FUNCTION assign_new_league_owner() RETURNS trigger AS $$
    BEGIN
      INSERT INTO league_memberships (league_id, user_id, role, status)
      VALUES (NEW.id, NEW.created_by, 'owner', 'active');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER leagues_assign_owner_after_insert
    AFTER INSERT ON leagues
    FOR EACH ROW EXECUTE FUNCTION assign_new_league_owner();
  `);
};

export const down = (pgm) => {
  pgm.sql("DROP TRIGGER leagues_assign_owner_after_insert ON leagues; DROP FUNCTION assign_new_league_owner();");
  pgm.dropTable("league_memberships");
  pgm.dropTable("leagues");
  pgm.dropTable("player_profiles");
};
