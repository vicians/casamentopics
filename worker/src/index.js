/**
 * API do álbum de casamento — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /api/upload?key=uploads/...&guest=Nome   (body = arquivo)
 *   GET  /api/photos
 *   GET  /api/reactions?ids=id1,id2&visitor=uuid
 *   POST /api/reactions   { photo_id, reaction, visitor_id }
 *
 * O arquivo é gravado no R2 via streaming (não é carregado na memória).
 */

// ⚠️ Troque pelo endereço real do site publicado no Vercel.
const ALLOWED_ORIGIN = "https://fotos-gabisamuel.vercel.app";

const VALID_REACTIONS = ["love", "joy", "heart_eyes", "moved", "celebrate"];

// 30 MB (mesmo limite configurado no frontend).
const MAX_UPLOAD_BYTES = 31_457_280;

function extensionForContentType(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("heic")) return "heic";
  if (contentType.includes("heif")) return "heif";
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
  return {
    "Access-Control-Allow-Origin": origin || ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // ---- Upload de foto ----
      if (url.pathname === "/api/upload" && request.method === "POST") {
        if (!(await isUploadAllowed(env, request))) {
          return json({ error: "Muitos envios em pouco tempo. Aguarde um instante." }, 429, origin);
        }

        const guest = (url.searchParams.get("guest") || "Convidado especial")
          .trim()
          .slice(0, 60) || "Convidado especial";

        // Só aceita imagens.
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.startsWith("image/")) {
          return json({ error: "tipo de arquivo não permitido" }, 415, origin);
        }

        // Limita o tamanho (30 MB).
        const declaredLength = Number(request.headers.get("Content-Length") || 0);
        if (declaredLength > MAX_UPLOAD_BYTES) {
          return json({ error: "arquivo muito grande" }, 413, origin);
        }

        if (!request.body) {
          return json({ error: "arquivo ausente" }, 400, origin);
        }

        // O nome é gerado AQUI (nunca vem do cliente) → impossível sobrescrever
        // ou escolher caminhos. Upload é sempre "inserir novo".
        const key = `uploads/${Date.now()}-${crypto.randomUUID()}.${extensionForContentType(contentType)}`;

        await env.BUCKET.put(key, request.body, {
          httpMetadata: {
            contentType,
            cacheControl: "public, max-age=31536000, immutable",
          },
        });

        await env.DB.prepare(
          "INSERT INTO photos (id, key, guest_name, created_at) VALUES (?, ?, ?, ?)"
        )
          .bind(crypto.randomUUID(), key, guest, Date.now())
          .run();

        return json({ key }, 200, origin);
      }

      // ---- Listagem da galeria ----
      if (url.pathname === "/api/photos" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, key, guest_name, created_at FROM photos ORDER BY created_at DESC LIMIT 1000"
        ).all();
        return json({ photos: results || [] }, 200, origin);
      }

      // ---- Reações: leitura agregada ----
      if (url.pathname === "/api/reactions" && request.method === "GET") {
        const ids = (url.searchParams.get("ids") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 1000);
        const visitor = url.searchParams.get("visitor") || "";

        if (!ids.length) return json({ reactions: [] }, 200, origin);

        const placeholders = ids.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT photo_id, reaction, COUNT(*) AS count,
                  MAX(CASE WHEN visitor_id = ? THEN 1 ELSE 0 END) AS mine
             FROM reactions
            WHERE photo_id IN (${placeholders})
            GROUP BY photo_id, reaction`
        )
          .bind(visitor, ...ids)
          .all();

        return json({ reactions: results || [] }, 200, origin);
      }

      // ---- Reações: alternar (toggle) ----
      if (url.pathname === "/api/reactions" && request.method === "POST") {
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

      return json({ error: "not found" }, 404, origin);
    } catch (error) {
      return json({ error: String(error && error.message ? error.message : error) }, 500, origin);
    }
  },
};
