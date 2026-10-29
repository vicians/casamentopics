/**
 * API do álbum de casamento — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /api/upload?guest=Nome&upload=<idempotency-id>   (foto ou vídeo)
 *   POST /api/upload?photo=<id>&variant=thumb             (miniatura WebP)
 *   GET  /api/photos?before=<ts>&beforeId=<id>&limit=<n>  (paginado)
 *   GET  /api/reactions?ids=id1,id2&visitor=uuid
 *   POST /api/reactions   { photo_id, reaction, visitor_id }
 *
 * O arquivo é gravado no R2 via streaming (não é carregado na memória).
 */

// Origens autorizadas a chamar a API. Inclua aqui o domínio do site publicado
// e o endereço usado em desenvolvimento. Origens fora desta lista não recebem
// cabeçalho CORS (o navegador bloqueia a leitura/resposta).
const ALLOWED_ORIGINS = [
  "https://fotos-gabisamuel.vercel.app",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

// Também aceita os deployments do Vercel deste projeto (produção e previews),
// caso o domínio mude sem aviso. Ajuste o prefixo se o projeto for renomeado.
const VERCEL_ORIGIN_PATTERN = /^https:\/\/(fotos-gabisamuel|casamentopics)[a-z0-9-]*\.vercel\.app$/;

const VALID_REACTIONS = ["love", "joy", "heart_eyes", "moved", "celebrate"];

// Limites de upload.
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

// Janela de cache da listagem no edge (segundos). Como cada convidado consulta
// a galeria a cada ~90s, cachear por alguns segundos colapsa centenas de
// leituras do D1 em uma única query — evita estourar a cota diária de leitura.
const PHOTOS_CACHE_TTL = 25;

// O D1 aceita no máximo 100 parâmetros vinculados por query. Como o `visitor`
// ocupa 1, fatiamos os ids em lotes de 90 para nunca estourar esse limite.
const REACTION_ID_CHUNK = 90;

// Segundos sugeridos ao cliente quando o rate limit de upload é atingido.
const RATE_LIMIT_RETRY_AFTER = 30;

// Paginação da galeria.
const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || VERCEL_ORIGIN_PATTERN.test(origin);
}

// Chave canônica de cache (a URL inteira, incluindo o cursor de paginação).
function photosCacheKey(url) {
  return new Request(url.toString(), { method: "GET" });
}

function firstPageUrl(origin) {
  return new URL("/api/photos", origin);
}

function isVideoExtension(key) {
  return /\.(mp4|webm|mov|m4v)$/i.test(key || "");
}

// Lê as reações de vários ids em lotes, respeitando o limite de parâmetros.
async function fetchReactionRows(env, ids, visitor) {
  const rows = [];
  for (let i = 0; i < ids.length; i += REACTION_ID_CHUNK) {
    const chunk = ids.slice(i, i + REACTION_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT photo_id, reaction, COUNT(*) AS count,
              MAX(CASE WHEN visitor_id = ? THEN 1 ELSE 0 END) AS mine
         FROM reactions
        WHERE photo_id IN (${placeholders})
        GROUP BY photo_id, reaction`
    )
      .bind(visitor, ...chunk)
      .all();
    if (results) rows.push(...results);
  }
  return rows;
}

function extensionForContentType(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  return "jpg";
}

// Verifica o rate limit do upload. Em qualquer falha (binding ausente ou erro),
// libera o upload — o rate limiter nunca deve derrubar um envio legítimo.
async function isUploadAllowed(env, request) {
  const limiter = env.UPLOAD_RATE_LIMITER;
  if (!limiter) return true;
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  try {
    const { success } = await limiter.limit({ key: ip });
    return success;
  } catch (error) {
    return true;
  }
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  // Só devolve CORS para origens conhecidas. Para as demais, o navegador
  // bloqueia a resposta sozinho, sem precisar de 403.
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

// Aguarda a invalidação (em vez de waitUntil) para que o cliente que atualiza a
// galeria logo após o upload já veja a nova lembrança, sem esperar o TTL.
async function invalidateFirstPage(origin) {
  await caches.default.delete(photosCacheKey(firstPageUrl(origin)));
}

// ---- Upload de foto/vídeo ------------------------------------------------
async function handleMediaUpload(request, env, url, origin) {
  const guest = (url.searchParams.get("guest") || "Convidado especial")
    .trim()
    .slice(0, 60) || "Convidado especial";

  const contentType = request.headers.get("Content-Type") || "";
  const isVideo = contentType.startsWith("video/");

  if (!isVideo && !contentType.startsWith("image/")) {
    return json({ error: "tipo de arquivo não permitido" }, 415, origin);
  }
  if (isVideo && !ALLOWED_VIDEO_TYPES.some((type) => contentType.startsWith(type))) {
    return json({ error: "formato de vídeo não suportado" }, 415, origin);
  }
  if (contentType.includes("heic") || contentType.includes("heif")) {
    return json({ error: "formato HEIC não suportado; envie em JPG" }, 415, origin);
  }

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) {
    return json({ error: "arquivo muito grande" }, 413, origin);
  }
  if (!request.body) {
    return json({ error: "arquivo ausente" }, 400, origin);
  }

  // Idempotência: se o mesmo upload já foi concluído, devolve a chave (e o id)
  // existente em vez de criar uma mídia duplicada no retry.
  const uploadId = (url.searchParams.get("upload") || "").trim().slice(0, 100);
  if (uploadId) {
    try {
      const existing = await env.DB.prepare(
        "SELECT key FROM uploads WHERE upload_id = ?"
      )
        .bind(uploadId)
        .first();
      if (existing) {
        const photo = await env.DB.prepare("SELECT id FROM photos WHERE key = ?")
          .bind(existing.key)
          .first();
        return json(
          {
            key: existing.key,
            id: photo ? photo.id : null,
            mediaType: isVideoExtension(existing.key) ? "video" : "image",
            duplicate: true,
          },
          200,
          origin
        );
      }
    } catch (error) {
      // A tabela de idempotência é opcional: segue com o upload normal.
    }
  }

  // O nome é gerado AQUI (nunca vem do cliente) → impossível sobrescrever
  // ou escolher caminhos. Upload é sempre "inserir novo".
  const key = `uploads/${Date.now()}-${crypto.randomUUID()}.${extensionForContentType(contentType)}`;

  // `request.body` é um stream com tamanho conhecido, que o R2 aceita sem
  // carregar o arquivo inteiro na memória do Worker.
  await env.BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const photoId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO photos (id, key, guest_name, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(photoId, key, guest, Date.now())
      .run();
  } catch (error) {
    try {
      await env.BUCKET.delete(key);
    } catch (cleanupError) {
      // melhor esforço: não mascarar o erro original
    }
    throw error;
  }

  if (uploadId) {
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO uploads (upload_id, key, created_at) VALUES (?, ?, ?)"
      )
        .bind(uploadId, key, Date.now())
        .run();
    } catch (error) {
      // Sem a tabela de idempotência o upload continua válido.
    }
  }

  await invalidateFirstPage(url.origin);

  return json({ key, id: photoId, mediaType: isVideo ? "video" : "image" }, 200, origin);
}

// ---- Upload de miniatura -------------------------------------------------
async function handleThumbUpload(request, env, url, origin) {
  const photoId = (url.searchParams.get("photo") || "").trim().slice(0, 100);
  if (!photoId) return json({ error: "foto não informada" }, 400, origin);

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("image/")) {
    return json({ error: "miniatura inválida" }, 415, origin);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_THUMB_BYTES) {
    return json({ error: "miniatura muito grande" }, 413, origin);
  }
  if (!request.body) {
    return json({ error: "arquivo ausente" }, 400, origin);
  }

  try {
    const existing = await env.DB.prepare(
      "SELECT thumb_key FROM photo_thumbs WHERE photo_id = ?"
    )
      .bind(photoId)
      .first();
    if (existing) {
      return json({ thumbKey: existing.thumb_key, duplicate: true }, 200, origin);
    }
  } catch (error) {
    // Tabela de miniaturas ausente: segue sem idempotência.
  }

  const photo = await env.DB.prepare("SELECT id FROM photos WHERE id = ?")
    .bind(photoId)
    .first();
  if (!photo) return json({ error: "foto não encontrada" }, 404, origin);

  const key = `thumbs/${Date.now()}-${crypto.randomUUID()}.webp`;
  await env.BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO photo_thumbs (photo_id, thumb_key, created_at) VALUES (?, ?, ?)"
    )
      .bind(photoId, key, Date.now())
      .run();
  } catch (error) {
    try {
      await env.BUCKET.delete(key);
    } catch (cleanupError) {
      // melhor esforço
    }
    throw error;
  }

  await invalidateFirstPage(url.origin);

  return json({ thumbKey: key }, 200, origin);
}

// ---- Listagem paginada ---------------------------------------------------
async function handlePhotosList(request, env, ctx, url, origin) {
  const cache = caches.default;
  const cacheKey = photosCacheKey(url);

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Reaplica o CORS da origem atual: o corpo é o mesmo para todos.
    const headers = new Headers(cached.headers);
    const cors = corsHeaders(origin);
    if (cors["Access-Control-Allow-Origin"]) {
      headers.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]);
    } else {
      headers.delete("Access-Control-Allow-Origin");
    }
    return new Response(cached.body, { status: cached.status, headers });
  }

  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const before = Number(url.searchParams.get("before") || 0);
  const beforeId = (url.searchParams.get("beforeId") || "").trim().slice(0, 100);
  const hasCursor = Boolean(before && beforeId);

  const where = hasCursor
    ? "WHERE (p.created_at < ? OR (p.created_at = ? AND p.id < ?))"
    : "";
  const order = "ORDER BY p.created_at DESC, p.id DESC";
  const baseColumns = "p.id, p.key, p.guest_name, p.created_at";
  const limitClause = "LIMIT ?";

  const joinSql = `SELECT ${baseColumns}, t.thumb_key
                     FROM photos p
                     LEFT JOIN photo_thumbs t ON t.photo_id = p.id
                     ${where} ${order} ${limitClause}`;
  const plainSql = `SELECT ${baseColumns} FROM photos p ${where} ${order} ${limitClause}`;

  const bindArgs = hasCursor ? [before, before, beforeId, limit + 1] : [limit + 1];

  let rows;
  try {
    const { results } = await env.DB.prepare(joinSql).bind(...bindArgs).all();
    rows = results || [];
  } catch (error) {
    // Se a tabela de miniaturas ainda não existir, a galeria continua
    // funcionando com as imagens completas.
    const { results } = await env.DB.prepare(plainSql).bind(...bindArgs).all();
    rows = results || [];
  }

  const hasMore = rows.length > limit;
  const photos = hasMore ? rows.slice(0, limit) : rows;
  const last = photos[photos.length - 1] || null;

  let total = photos.length;
  try {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM photos").first();
    if (countRow) total = Number(countRow.total) || 0;
  } catch (error) {
    // sem contagem exata: usa o que foi carregado
  }

  const response = json(
    {
      photos,
      total,
      hasMore,
      nextBefore: last ? last.created_at : null,
      nextBeforeId: last ? last.id : null,
    },
    200,
    origin
  );
  response.headers.set("Cache-Control", `public, max-age=${PHOTOS_CACHE_TTL}`);

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// ---- Reações -------------------------------------------------------------
async function handleReactionsGet(env, url, origin) {
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 1000);
  const visitor = url.searchParams.get("visitor") || "";

  if (!ids.length) return json({ reactions: [] }, 200, origin);

  const results = await fetchReactionRows(env, ids, visitor);
  return json({ reactions: results }, 200, origin);
}

async function handleReactionsPost(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const { photo_id, reaction, visitor_id } = body || {};

  if (!photo_id || !visitor_id || !VALID_REACTIONS.includes(reaction)) {
    return json({ error: "dados inválidos" }, 400, origin);
  }

  const existing = await env.DB.prepare(
    "SELECT reaction FROM reactions WHERE photo_id = ? AND visitor_id = ?"
  )
    .bind(photo_id, visitor_id)
    .first();

  if (existing && existing.reaction === reaction) {
    await env.DB.prepare(
      "DELETE FROM reactions WHERE photo_id = ? AND visitor_id = ?"
    )
      .bind(photo_id, visitor_id)
      .run();
    return json({ reaction: null }, 200, origin);
  }

  await env.DB.prepare(
    `INSERT INTO reactions (photo_id, visitor_id, reaction) VALUES (?, ?, ?)
     ON CONFLICT (photo_id, visitor_id) DO UPDATE SET reaction = excluded.reaction`
  )
    .bind(photo_id, visitor_id, reaction)
    .run();

  return json({ reaction }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/api/upload" && request.method === "POST") {
        if (!(await isUploadAllowed(env, request))) {
          return json(
            { error: "Muitos envios em pouco tempo. Aguarde um instante." },
            429,
            origin,
            { "Retry-After": String(RATE_LIMIT_RETRY_AFTER) }
          );
        }
        if (url.searchParams.get("variant") === "thumb") {
          return await handleThumbUpload(request, env, url, origin);
        }
        return await handleMediaUpload(request, env, url, origin);
      }

      if (url.pathname === "/api/photos" && request.method === "GET") {
        return await handlePhotosList(request, env, ctx, url, origin);
      }

      if (url.pathname === "/api/reactions" && request.method === "GET") {
        return await handleReactionsGet(env, url, origin);
      }

      if (url.pathname === "/api/reactions" && request.method === "POST") {
        return await handleReactionsPost(request, env, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (error) {
      // Nunca expõe detalhe interno ao convidado.
      console.error("Erro na API do álbum:", error);
      return json({ error: "erro interno" }, 500, origin);
    }
  },
};
