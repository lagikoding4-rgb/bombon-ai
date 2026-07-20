create table if not exists bombon_memory (
  id bigint generated always as identity primary key,
  note text not null,
  created_at timestamptz not null default now()
);

alter table bombon_memory enable row level security;
-- Sengaja TIDAK dikasih policy publik apapun.
-- Cuma bisa diakses lewat service role key (dipakai backend chat.js aja, bukan dari browser).
