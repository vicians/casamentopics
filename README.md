# Samuel & Gabriela — álbum colaborativo

Site estático em HTML, CSS e JavaScript para os convidados enviarem fotografias durante o casamento. As imagens são otimizadas no navegador, enviadas ao Supabase Storage e aparecem automaticamente na galeria compartilhada.

## Configuração do Supabase

1. No painel do projeto Supabase, abra o **SQL Editor**.
2. Execute todo o conteúdo de [`supabase-setup.sql`](./supabase-setup.sql).

O script cria automaticamente o bucket público `casamento-fotos`, define o limite de `30 MB`, aceita os formatos de imagem usados pelo site e configura as políticas de acesso. Ele pode ser executado novamente sem duplicar o bucket ou as políticas.

As políticas permitem somente:

- visualizar/listar as fotos da pasta `uploads`;
- adicionar novas fotos nessa pasta.

Não há permissão pública para excluir, alterar ou sobrescrever fotografias.

## Teste local

Sirva esta pasta com um servidor HTTP simples. Por exemplo:

```powershell
python -m http.server 4173
```

Depois abra `http://localhost:4173`.

## Deploy

Publique `index.html`, `style.css`, `script.js` e a pasta `assets` no serviço de hospedagem de sua preferência.

O endereço e a chave `anon` do Supabase ficam no frontend por definição. A proteção dos arquivos é feita pelas políticas de acesso configuradas no Storage.
