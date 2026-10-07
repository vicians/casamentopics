-- Execute este arquivo completo no SQL Editor do projeto Supabase.
-- Ele cria (ou atualiza) o bucket público e configura as políticas do álbum.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'casamento-fotos',
  'casamento-fotos',
  true,
  31457280,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif'
  ]::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Convidados podem listar fotos do casamento'
  ) then
    execute $policy$
      create policy "Convidados podem listar fotos do casamento"
      on storage.objects
      for select
      to anon, authenticated
      using (
        bucket_id = 'casamento-fotos'
        and (storage.foldername(name))[1] = 'uploads'
      )
    $policy$;
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Convidados podem enviar fotos do casamento'
  ) then
    execute $policy$
      create policy "Convidados podem enviar fotos do casamento"
      on storage.objects
      for insert
      to anon, authenticated
      with check (
        bucket_id = 'casamento-fotos'
        and (storage.foldername(name))[1] = 'uploads'
      )
    $policy$;
  end if;
end
$$;
