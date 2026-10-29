# Worker — API do álbum (Cloudflare R2 + D1)

Backend serverless do álbum. Grava fotos no **R2** e metadados/reações no **D1**.

## Passo a passo

1. Instale a CLI e faça login:
   ```powershell
   npm install -g wrangler
   wrangler login
   ```

2. Instale as dependências deste worker:
   ```powershell
   npm install
   ```

3. Crie o banco D1:
   ```powershell
   wrangler d1 create casamento
   ```
   Copie o `database_id` retornado e cole em `wrangler.toml` (substituindo `COLE_O_ID_AQUI`).

4. Aplique o schema:
   ```powershell
   npm run db:apply
   ```

5. Publique:
   ```powershell
   npm run deploy
   ```
   O Wrangler mostra a URL, algo como:
   `https://casamento-api.SEU_SUBDOMINIO.workers.dev`

6. No `../script.js`, coloque essa URL em `API_BASE` e o endereço `r2.dev` do bucket em `CDN_BASE`.

## Teste rápido

```powershell
curl.exe "https://casamento-api.SEU_SUBDOMINIO.workers.dev/api/photos"
```
Deve responder `{"photos":[]}`.
