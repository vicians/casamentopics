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
   │                 ├─ POST /api/upload     → Worker → R2   (grava a foto)
   │                 ├─ GET  /api/photos      → Worker → D1   (lista metadados)
   │                 ├─ GET  /api/reactions   → Worker → D1   (lê reações)
   │                 ├─ POST /api/reactions   → Worker → D1   (grava reação)
   │                 └─ <img src="pub-xxxx.r2.dev/...">       (exibe a foto)
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

- **Upload direto para o storage** (o Worker só faz proxy em *streaming* — o
  arquivo nunca é carregado inteiro na memória).
- **Redimensionamento no navegador** antes do envio (máx. 2200px, WebP q=0.86),
  o que reduz muito o tamanho dos arquivos.
- **Retry com backoff exponencial** no upload (até 4 tentativas).
- **Barra de progresso** por arquivo para o convidado saber que está enviando.
- **Refresh da galeria com jitter** (45s + aleatório) para evitar que todos os
  clientes consultem a API no mesmo instante.
- **Falha silenciosa não apaga a galeria** — se uma atualização falhar, a última
  lista boa permanece na tela.

---

## Segurança (somente inserção de fotos)

- O endereço público do R2 (`pub-*.r2.dev`) é **somente leitura** — nunca permite
  escrita nem exclusão.
- **Não existe escrita anônima direta no bucket.** Os uploads passam sempre pelo
  Worker, que valida tipo (`image/*`), tamanho (30 MB) e **gera o nome do arquivo
  no servidor** (UUID). Assim é impossível sobrescrever uma foto existente ou
  escolher caminhos arbitrários: todo upload é sempre um objeto **novo**.
- Não há rota para excluir fotos.
- **Rate limit** no endpoint de upload (rate limiter nativo da Cloudflare): 300
  uploads por 60s por IP. É **aproximado e por IP**, então convidados no mesmo
  Wi-Fi compartilham a cota — o limite é propositalmente generoso para nunca
  bloquear convidados, apenas barrar spam/abuso (retorna HTTP 429).

---

## Estrutura do repositório

```
.
├── index.html            # Página do álbum
├── style.css             # Estilos
├── script.js             # Lógica do frontend (chama a API do Worker)
├── assets/               # Imagens fixas do site
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

E, em `worker/src/index.js`, garanta que `ALLOWED_ORIGIN` seja o endereço do
site publicado no Vercel. Depois rode `npm run deploy` na pasta `worker`.

---

## Teste local

```powershell
python -m http.server 4173
```

Abra `http://localhost:4173`.

> Observação: o Worker libera CORS apenas para o domínio de produção do Vercel.
> Se for testar upload localmente, inclua `http://localhost:4173` no
> `ALLOWED_ORIGIN` do Worker (ou faça o teste já pelo site publicado).

---

## Deploy do frontend

Publique `index.html`, `style.css`, `script.js` e a pasta `assets` no Vercel
(ou outro host estático). O endereço **não muda** — os QR codes já impressos
continuam válidos.

---

## Checklist do dia do evento

- [ ] `npm run db:apply` executado (tabelas `photos` e `reactions` criadas)
- [ ] `GET /api/photos` responde `{"photos":[]}`
- [ ] Upload funcionando pelo site publicado
- [ ] Reações funcionando
- [ ] Teste de volume (50+ fotos)
- [ ] Teste em 4G e Wi-Fi
- [ ] QR codes apontando para o endereço do Vercel

---

## Observações

- O endereço `pub-*.r2.dev` é o modo de desenvolvimento do R2 e tem limite de
  requisições. Para uso prolongado ou maior tráfego, conecte um **domínio
  próprio** ao bucket (Custom Domains) e troque apenas o `CDN_BASE`.
