/**
 * Idempotent schema bootstrap. Mirrors src/db/schema.ts so a brand new Render
 * Postgres instance works on first boot without running drizzle-kit by hand.
 */
const STATEMENTS = [
  `create table if not exists rooms (
     id serial primary key,
     code varchar(12) not null unique,
     name varchar(80) not null,
     topic varchar(200),
     created_by varchar(32),
     max_members integer not null default 50,
     is_locked boolean not null default false,
     created_at timestamptz not null default now(),
     last_activity_at timestamptz not null default now()
   )`,
  `create index if not exists rooms_last_activity_idx on rooms (last_activity_at)`,
  `create table if not exists messages (
     id serial primary key,
     room_code varchar(12) not null references rooms(code) on delete cascade,
     username varchar(32) not null,
     body text not null,
     kind varchar(16) not null default 'chat',
     created_at timestamptz not null default now()
   )`,
  `create index if not exists messages_room_id_idx on messages (room_code, id)`,
  `create table if not exists room_members (
     id serial primary key,
     room_code varchar(12) not null references rooms(code) on delete cascade,
     username_key varchar(32) not null,
     username varchar(32) not null,
     session_id varchar(40) not null,
     transport varchar(8) not null default 'ws',
     joined_at timestamptz not null default now(),
     last_seen_at timestamptz not null default now()
   )`,
  `create unique index if not exists room_members_room_username_idx on room_members (room_code, username_key)`,
  `create index if not exists room_members_last_seen_idx on room_members (last_seen_at)`,
];

export async function ensureSchema(pool, log = console.log) {
  for (const statement of STATEMENTS) {
    await pool.query(statement);
  }
  log("[db] schema ready");
}
