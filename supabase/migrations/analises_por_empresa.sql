-- Análises e documentos passam a pertencer a cada empresa (nada compartilhado entre empresas ou contas).
alter table licitacoes.analises add column if not exists empresa_id uuid;
alter table licitacoes.documentos add column if not exists empresa_id uuid;
update licitacoes.analises set empresa_id='024caef2-dc0d-4b57-9bbb-861d1bdd95ec' where empresa_id is null;   -- as 3 análises existentes eram da FAGE TECH
update licitacoes.documentos set empresa_id='024caef2-dc0d-4b57-9bbb-861d1bdd95ec' where empresa_id is null;
alter table licitacoes.analises alter column empresa_id set not null;
alter table licitacoes.documentos alter column empresa_id set not null;
alter table licitacoes.analises add constraint analises_empresa_fkey foreign key (empresa_id) references licitacoes.empresas(id) on delete cascade;
alter table licitacoes.documentos add constraint documentos_empresa_fkey foreign key (empresa_id) references licitacoes.empresas(id) on delete cascade;
alter table licitacoes.analises drop constraint analises_pkey;
alter table licitacoes.analises add primary key (empresa_id, id);
alter table licitacoes.documentos drop constraint documentos_pkey;
alter table licitacoes.documentos add primary key (empresa_id, id);
drop policy "leitura publica" on licitacoes.analises;
drop policy "leitura publica" on licitacoes.documentos;
create policy "analises da propria empresa" on licitacoes.analises for select to authenticated using (exists (select 1 from licitacoes.empresas e where e.id = empresa_id and e.user_id = (select auth.uid())));
create policy "documentos da propria empresa" on licitacoes.documentos for select to authenticated using (exists (select 1 from licitacoes.empresas e where e.id = empresa_id and e.user_id = (select auth.uid())));
create index if not exists analises_empresa_idx on licitacoes.analises (empresa_id);
