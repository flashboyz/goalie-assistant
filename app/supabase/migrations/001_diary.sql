begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  created_at timestamptz not null default now()
);

create table public.diary_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  opponent text not null default '' check (char_length(opponent) <= 200),
  no_stats boolean not null default true,
  mood smallint not null default 0 check (mood between 0 and 5),
  good text not null default '' check (char_length(good) <= 10000),
  improve text not null default '' check (char_length(improve) <= 10000),
  legacy_note text not null default '' check (char_length(legacy_note) <= 10000),
  shots integer not null default 0 check (shots >= 0),
  goals integer not null default 0 check (goals >= 0 and goals <= shots),
  shots_after integer not null default 0 check (shots_after >= 0 and shots_after <= shots),
  goals_after integer not null default 0 check (goals_after >= 0 and goals_after <= goals and goals_after <= shots_after),
  created_at timestamptz not null default now(),
  constraint valid_before_stats check (goals - goals_after <= shots - shots_after),
  constraint no_stats_zero check (not no_stats or (shots = 0 and goals = 0 and shots_after = 0 and goals_after = 0)),
  constraint nonempty_entry check (not no_stats or mood > 0 or good <> '' or improve <> '' or legacy_note <> '')
);
create index diary_owner_date on public.diary_entries(user_id, entry_date desc, id);

alter table public.profiles enable row level security;
alter table public.diary_entries enable row level security;
revoke all on public.profiles, public.diary_entries from anon, authenticated;
grant select, insert, update, delete on public.profiles, public.diary_entries to authenticated;

create policy own_profile on public.profiles for all to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy own_diary on public.diary_entries for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
