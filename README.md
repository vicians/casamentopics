# Samuel & Gabriela — álbum colaborativo

Álbum de casamento onde os convidados enviam fotos pelo celular e elas aparecem
automaticamente na galeria compartilhada.

O site (HTML/CSS/JavaScript estático) fica no **Vercel**. O backend de upload,
armazenamento e reações roda na **Cloudflare** (Worker + R2 + D1).

---

## Arquitetura

```
Convidado (browser)
   │
   ├─ QR code → https://fotos-gabisamuel.vercel.app   (site no Vercel)
   │                 │
   │                 ├─ POST /api/upload     → Worker → R2   (foto/vídeo; miniatura via ?variant=thumb)
   │                 ├─ GET  /api/photos      → Worker → D1   (lista paginada)
   │                 ├─ GET  /api/reactions   → Worker → D1   (lê reações)
   │                 ├─ POST /api/reactions   → Worker → D1   (grava reação)
   │                 └─ <img src="pub-xxxx.r2.dev/...">       (exibe a mídia)
```

| Componente | Serviço | Custo |
|---|---|---|
| Frontend | Vercel (estático) | grátis |
| API | Cloudflare Worker | grátis |
| Armazenamento das fotos | Cloudflare R2 | grátis (egress ilimitado) |
| Metadados + reações | Cloudflare D1 | grátis |

### Por que Cloudflare R2?

O R2 **não cobra egress** (leitura). Isso resolve o principal risco de um álbum
com muitos convidados: a galeria é lida dezenas/centenas de vezes, e na nuvem
tradicional isso gera custo e pode estourar limites. No R2, a leitura é gratuita.

### Otimizações de resiliência

- **Upload em *streaming* pelo Worker** (o arquivo nunca é carregado inteiro na
  memória; o Worker repassa o stream direto ao R2).
- **Redimensionamento no navegador** antes do envio (máx. 2200px, WebP q=0.86),
  o que reduz muito o tamanho dos arquivos.
- **Miniaturas de 600px** geradas no navegador e enviadas junto com a mídia. A
  grade usa a miniatura; o lightbox usa a mídia completa.
- **Vídeos** (MP4/WEBM/MOV) até 80 MB, com pôster extraído do próprio vídeo
  quando o navegador consegue.
- **Fila offline em IndexedDB**: se a aba fechar ou a rede cair, o envio pode ser
  retomado na próxima visita, sem perder a lembrança.
- **Paginação por cursor** (`created_at` + `id`): a galeria carrega 60 por vez e
  nada "some" depois de 1000 fotos.
- **Retry com backoff exponencial** no upload (até 4 tentativas), respeitando o
  `Retry-After` em respostas 429 e sem repetir erros 4xx definitivos.
- **Idempotência por arquivo**: a mesma lembrança reenviada (timeout/retry)
  devolve a já gravada em vez de criar duplicata. Objetos cujo metadado falha
  são removidos do R2 para não ficarem órfãos.
- **Status por lembrança** na seleção (enviando ✓/erro) e retry apenas das que
  falharam, sem reenviar as que já subiram.
- **Paginação + miniatura** também são idempotentes: reenviar a mesma miniatura
  devolve a já existente.
- **Aviso ao fechar a aba** durante um envio, para não perder o upload.
- **Barra de progresso** por arquivo para o convidado saber que está enviando.
- **Refresh da galeria com jitter** (90s + aleatório) para evitar que todos os
  clientes consultem a API no mesmo instante.
- **Falha silenciosa não apaga a galeria** — se uma atualização falhar, a última
  lista boa permanece na tela.

---

## Segurança (somente inserção de mídias)

- O endereço público do R2 (`pub-*.r2.dev`) é **somente leitura** — nunca permite
  escrita nem exclusão.
- **Não existe escrita anônima direta no bucket.** Os uploads passam sempre pelo
  Worker, que valida tipo (`image/*` ou `video/mp4|webm|quicktime`), tamanho
  (30 MB por foto, 80 MB por vídeo, 2 MB por miniatura) e **gera o nome do
  arquivo no servidor** (UUID). Assim é impossível sobrescrever uma mídia
  existente ou escolher caminhos arbitrários: todo upload é sempre um objeto
  **novo**.
- Não há rota para excluir mídias.
- **Rate limit** no endpoint de upload (rate limiter nativo da Cloudflare): 1200
  uploads por 60s por IP. É **aproximado e por IP**, então convidados no mesmo
  Wi-Fi compartilham a cota — o limite é propositalmente generoso para nunca
  bloquear convidados, apenas barrar spam/abuso (retorna HTTP 429 com
  `Retry-After`). Cada lembrança gera 2 requisições (mídia + miniatura).
- **CORS restrito** às origens conhecidas (`ALLOWED_ORIGINS` em
  `worker/src/index.js`). Se o site mudar de domínio, atualize essa lista.
- **Idempotência** usa a tabela `uploads` (criada por `schema.sql`). Ela é
  opcional: se não existir, o upload continua funcionando, apenas sem proteção
  contra duplicatas em retry.

---

## Estrutura do repositório

```
.
├── index.html            # Página do álbum
├── style.css             # Estilos
├── script.js             # Lógica do frontend (chama a API do Worker)
├── assets/               # Imagens fixas do site
├── .github/workflows/    # Uptime check (15 em 15 min)
└── worker/               # Backend Cloudflare (ver worker/README.md)
    ├── wrangler.toml
    ├── package.json
    ├── schema.sql
    └── src/index.js
```

---

## Configuração

### 1. Backend (Cloudflare)

Siga o passo a passo em [`worker/README.md`](./worker/README.md):

```powershell
cd worker
npm install -g wrangler
wrangler login
npm install
wrangler d1 create casamento      # copie o database_id para wrangler.toml
npm run db:apply
npm run deploy
```

Anote a URL gerada, ex. `https://casamento-api.SEU_SUBDOMINIO.workers.dev`.

### 2. Bucket R2 público

No painel Cloudflare → **R2** → bucket `casamento-fotos` → **Settings** →
**Public access** → habilite o **R2.dev subdomain** e anote a URL
`https://pub-xxxx.r2.dev`.

### 3. Frontend

No topo do `script.js`, ajuste as duas URLs:

```js
const API_BASE = "https://casamento-api.SEU_SUBDOMINIO.workers.dev";
const CDN_BASE = "https://pub-xxxx.r2.dev";
```

E, em `worker/src/index.js`, garanta que `ALLOWED_ORIGINS` inclua o endereço do
site publicado no Vercel. Depois rode `npm run deploy` na pasta `worker`.

---

## Teste local

```powershell
python -m http.server 4173
```

Abra `http://localhost:4173`.

> Observação: o Worker libera CORS apenas para os domínios do Vercel e para
> `http://localhost:4173`. Se for testar upload localmente em outra porta,
> inclua a origem em `ALLOWED_ORIGINS` (ou faça o teste pelo site publicado).

---

## Deploy do frontend

Publique `index.html`, `style.css`, `script.js` e a pasta `assets` no Vercel
(ou outro host estático). O endereço **não muda** — os QR codes já impressos
continuam válidos.

---

## Checklist do dia do evento

- [ ] `npm run db:apply` executado (tabelas `photos`, `reactions`, `uploads` e `photo_thumbs`)
- [ ] `ALLOWED_ORIGINS` no Worker inclui o domínio real do site
- [ ] `GET /api/photos` responde `{"photos":[],"total":0,"hasMore":false}`
- [ ] Upload de foto funcionando pelo site publicado
- [ ] Upload de vídeo (MP4) funcionando e reproduzindo no lightbox
- [ ] Miniatura aparecendo na grade (e não a imagem de 2200px)
- [ ] Reenvio da mesma lembrança (retry) **não** cria duplicata
- [ ] Paginação: "Carregar mais lembranças" traz a próxima página
- [ ] Fila offline: fechar a aba no meio do envio e retomar na próxima visita
- [ ] Reações funcionando
- [ ] Teste de volume (50+ fotos)
- [ ] Teste em 4G e Wi-Fi
- [ ] QR codes apontando para o endereço do Vercel
- [ ] Workflow de uptime habilitado no GitHub Actions

---

## Observações

- O endereço `pub-*.r2.dev` é o modo de desenvolvimento do R2 e tem limite de
  requisições. Para uso prolongado ou maior tráfego, conecte um **domínio
  próprio** ao bucket (Custom Domains) e troque apenas o `CDN_BASE`.
- O workflow `.github/workflows/uptime.yml` verifica `/api/photos` a cada
  15 minutos e falha (notificando no GitHub) se a API sair do ar.
- **Vídeos:** o navegador só reproduz formatos que ele suporta. MP4/H.264 é o
  mais universal; MOV (iPhone) pode não tocar no Chrome/Android. O upload é
  aceito, mas vale orientar os convidados a usar MP4 quando possível.
