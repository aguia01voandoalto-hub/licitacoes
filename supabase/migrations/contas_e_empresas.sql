-- Contas e empresas do Time de Licitações.
-- Mexe só no esquema "licitacoes"; não toca nas tabelas do app do inspirar.

-- Quem pode usar o produto (lista de acesso, separada do app da comunidade).
create table if not exists licitacoes.acesso (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);
comment on table licitacoes.acesso is 'Usuários liberados para o Time de Licitações. Quem não está aqui não grava nada, mesmo logado.';
alter table licitacoes.acesso enable row level security;
drop policy if exists "ver o proprio acesso" on licitacoes.acesso;
create policy "ver o proprio acesso" on licitacoes.acesso for select to authenticated using (user_id = (select auth.uid()));
grant select on licitacoes.acesso to authenticated;
grant all on licitacoes.acesso to service_role;

-- Confere o acesso (security definer, para as políticas não dependerem da leitura da tabela).
create or replace function licitacoes.tem_acesso() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from licitacoes.acesso a where a.user_id = (select auth.uid()));
$$;
revoke all on function licitacoes.tem_acesso() from public, anon;
grant execute on function licitacoes.tem_acesso() to authenticated;

-- Empresas de cada usuário: dados cadastrais, decisões e observações, e o resultado da última busca.
create table if not exists licitacoes.empresas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dados jsonb not null default '{}'::jsonb,
  estado jsonb not null default '{}'::jsonb,
  busca jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table licitacoes.empresas is 'Empresas cadastradas por cada usuário (privadas por usuário via RLS).';
create index if not exists empresas_user_idx on licitacoes.empresas(user_id);
alter table licitacoes.empresas enable row level security;
drop policy if exists "empresas do proprio usuario" on licitacoes.empresas;
create policy "empresas do proprio usuario" on licitacoes.empresas for all to authenticated
  using (user_id = (select auth.uid()) and licitacoes.tem_acesso())
  with check (user_id = (select auth.uid()) and licitacoes.tem_acesso());
grant select, insert, update, delete on licitacoes.empresas to authenticated;
grant all on licitacoes.empresas to service_role;

create or replace function licitacoes.marcar_atualizado() returns trigger language plpgsql set search_path = '' as $$
begin new.atualizado_em = now(); return new; end $$;
drop trigger if exists empresas_atualizado on licitacoes.empresas;
create trigger empresas_atualizado before update on licitacoes.empresas for each row execute function licitacoes.marcar_atualizado();

-- Libera o dono do projeto.
insert into licitacoes.acesso (user_id) select id from auth.users where lower(email) = 'eromachado@gmail.com' on conflict do nothing;

-- Para liberar outra pessoa (depois de criar a conta dela em Authentication > Users):
--   insert into licitacoes.acesso (user_id) select id from auth.users where lower(email) = 'email@da.pessoa';
