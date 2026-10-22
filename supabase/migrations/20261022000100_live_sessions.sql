-- Séance de TP en direct : le prof lance une séance depuis un TP, les étudiants la rejoignent par un lien et leur
-- progression (objectifs atteints) remonte en direct dans un tableau. Seule la progression est envoyée, jamais le schéma.
-- Même modèle de sécurité que les examens : tables fermées au public (RLS sans politique, aucun droit), accès par
-- fonctions ; le prof se reconnaît à un jeton (empreinte SHA-256 en base) ou à son compte.

create table public.live_sessions (
  id          text primary key,
  title       text not null check (char_length(title) <= 200),
  template    jsonb not null check (pg_column_size(template) < 2000000),
  owner       uuid references auth.users (id) on delete set null,
  edit_hash   text not null,
  closed      boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours'
);

create table public.live_participants (
  id          bigint generated always as identity primary key,
  session_id  text not null references public.live_sessions (id) on delete cascade,
  client_id   text not null,
  student     text not null check (char_length(student) <= 80),
  progress    jsonb not null default '[]'::jsonb check (pg_column_size(progress) < 20000),
  score       int not null default 0,
  total       int not null default 0,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (session_id, client_id)
);

alter table public.live_sessions enable row level security;
alter table public.live_participants enable row level security;
revoke all on public.live_sessions, public.live_participants from anon, authenticated;

create or replace function netcanvas_private.can_admin_live(p_id text, p_token text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (select 1 from public.live_sessions s where s.id = p_id
    and (s.edit_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') or (s.owner is not null and s.owner = auth.uid())));
$$;

-- Prof : crée la séance (le sujet est celui du TP ouvert, figé). Les séances expirées (24 h) sont purgées au passage.
create or replace function public.create_live(p_title text, p_template jsonb)
returns table (live_id text, admin_token text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  new_id text; token text; b bytea;
begin
  if p_template is null or p_template->>'format' is distinct from 'netcanvas'
     or jsonb_typeof(p_template->'exercise') is distinct from 'object'
     or jsonb_typeof(p_template->'exercise'->'objectives') is distinct from 'array' then
    raise exception 'il faut un schéma avec un TP (objectifs)';
  end if;
  if pg_column_size(p_template) >= 2000000 then raise exception 'schéma trop volumineux (2 Mo maximum)'; end if;
  delete from public.live_sessions s where s.expires_at < now();
  loop
    b := extensions.gen_random_bytes(10);
    new_id := '';
    for i in 0..9 loop new_id := new_id || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1); end loop;
    exit when not exists (select 1 from public.live_sessions s where s.id = new_id)
      and not exists (select 1 from public.exams e where e.id = new_id)
      and not exists (select 1 from public.diagrams d where d.id = new_id);
  end loop;
  token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  insert into public.live_sessions (id, title, template, owner, edit_hash)
  values (new_id, left(coalesce(nullif(trim(p_title), ''), 'Séance de TP'), 200), p_template, auth.uid(),
          encode(extensions.digest(token, 'sha256'), 'hex'));
  return query select new_id, token;
end;
$function$;

-- Étudiant : lit le sujet de la séance
create or replace function public.get_live(p_id text)
returns table (title text, template jsonb, closed boolean)
language sql
stable
security definer
set search_path to ''
as $$
  select s.title, s.template, s.closed from public.live_sessions s where s.id = p_id and s.expires_at > now();
$$;

-- Étudiant : rejoint la séance (reprend sa place s'il recharge la page : même poste = même ligne)
create or replace function public.join_live(p_id text, p_client text, p_student text)
returns timestamptz
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.live_sessions s where s.id = p_id and s.expires_at > now()) then raise exception 'séance introuvable ou terminée'; end if;
  if length(coalesce(trim(p_student), '')) < 2 then raise exception 'indique ton nom'; end if;
  if length(coalesce(p_client, '')) < 16 then raise exception 'poste non identifié'; end if;
  if (select count(*) from public.live_participants p where p.session_id = p_id) >= 300
     and not exists (select 1 from public.live_participants p where p.session_id = p_id and p.client_id = p_client) then
    raise exception 'séance complète (300 étudiants)';
  end if;
  insert into public.live_participants (session_id, client_id, student)
  select p_id, p_client, left(trim(p_student), 80)
   where not exists (select 1 from public.live_sessions s where s.id = p_id and s.closed)
  on conflict (session_id, client_id) do update set student = excluded.student, updated_at = now();
  if not exists (select 1 from public.live_participants p where p.session_id = p_id and p.client_id = p_client) then
    raise exception 'séance close';
  end if;
  return now();
end;
$function$;

-- Étudiant : envoie sa progression ([{ text, ok, weight }, …]) ; ignorée si la séance est close
create or replace function public.report_live(p_id text, p_client text, p_progress jsonb, p_score int, p_total int)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if jsonb_typeof(p_progress) is distinct from 'array' then raise exception 'progression invalide'; end if;
  if pg_column_size(p_progress) >= 20000 then raise exception 'progression trop volumineuse'; end if;
  update public.live_participants p
     set progress = p_progress, score = greatest(coalesce(p_score, 0), 0), total = greatest(coalesce(p_total, 0), 0), updated_at = now()
   where p.session_id = p_id and p.client_id = p_client
     and exists (select 1 from public.live_sessions s where s.id = p_id and not s.closed and s.expires_at > now());
end;
$function$;

-- Prof : état de la séance (infos + une ligne par étudiant)
create or replace function public.live_state(p_id text, p_token text)
returns table (title text, closed boolean, expires_at timestamptz, server_now timestamptz,
               student text, progress jsonb, score int, total int, joined_at timestamptz, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not netcanvas_private.can_admin_live(p_id, p_token) then raise exception 'lien de suivi invalide'; end if;
  return query
    select s.title, s.closed, s.expires_at, now(), p.student, p.progress, p.score, p.total, p.joined_at, p.updated_at
      from public.live_sessions s left join public.live_participants p on p.session_id = s.id
     where s.id = p_id order by p.student;
end;
$function$;

create or replace function public.set_live_closed(p_id text, p_token text, p_closed boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not netcanvas_private.can_admin_live(p_id, p_token) then raise exception 'lien de suivi invalide'; end if;
  update public.live_sessions s set closed = coalesce(p_closed, true) where s.id = p_id;
end;
$function$;

create or replace function public.delete_live(p_id text, p_token text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not netcanvas_private.can_admin_live(p_id, p_token) then raise exception 'lien de suivi invalide'; end if;
  delete from public.live_sessions s where s.id = p_id;
end;
$function$;

revoke all on function public.create_live(text, jsonb), public.get_live(text), public.join_live(text, text, text),
  public.report_live(text, text, jsonb, int, int), public.live_state(text, text), public.set_live_closed(text, text, boolean),
  public.delete_live(text, text), netcanvas_private.can_admin_live(text, text) from public;
grant execute on function public.create_live(text, jsonb), public.get_live(text), public.join_live(text, text, text),
  public.report_live(text, text, jsonb, int, int), public.live_state(text, text), public.set_live_closed(text, text, boolean),
  public.delete_live(text, text) to anon, authenticated;
