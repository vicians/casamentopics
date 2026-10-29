// Backend: Cloudflare Worker + R2. O site continua publicado no Vercel.
const API_BASE = "https://casamento-api.samuelvcallegaro.workers.dev";
const CDN_BASE = "https://pub-f77d17221fca4030bd4cef5c245225b3.r2.dev";
const MAX_IMAGE_SIZE = 30 * 1024 * 1024;
const MAX_VIDEO_SIZE = 80 * 1024 * 1024;
const IMAGE_UPLOAD_TIMEOUT_MS = 120_000;
const VIDEO_UPLOAD_TIMEOUT_MS = 300_000;
const UPLOAD_ATTEMPTS = 4;
const AUTO_REFRESH_MS = 90_000;
const AUTO_REFRESH_JITTER_MS = 15_000;
// Reações só são rebuscadas por completo de tempos em tempos (e de forma
// incremental para fotos novas), para não multiplicar leituras no banco.
const REACTION_REFRESH_MS = 10 * 60 * 1000;
// Status HTTP em que vale a pena tentar de novo. Erros 4xx (arquivo inválido,
// grande demais etc.) não devem ser repetidos.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const QUEUE_DB = "casamento-upload-queue";
const QUEUE_STORE = "pending";
const QUEUE_VERSION = 1;
const VISITOR_STORAGE_KEY = "casamento-reaction-visitor";
const SCHEDULE_STORAGE_KEY = "casamento-roteiro-fotos";
const REACTIONS = [
  { key: "love", emoji: "❤️", label: "Amei" },
  { key: "joy", emoji: "😂", label: "Muito bom" },
  { key: "heart_eyes", emoji: "😍", label: "Que lindos" },
  { key: "moved", emoji: "🥰", label: "Emocionante" },
  { key: "celebrate", emoji: "🎉", label: "Viva os noivos" }
];

const state = {
  photos: [],
  photosTotal: 0,
  photosHasMore: false,
  photosBefore: null,
  photosBeforeId: null,
  loadingPhotos: false,
  loadingMore: false,
  resumeDismissed: false,
  resumingUploads: false,
  selectedFiles: [],
  previewUrls: [],
  visitorId: getVisitorId(),
  reactionsAvailable: true,
  reactionRequests: new Set(),
  reactionPhotos: new Set(),
  lastReactionRefresh: 0,
  lightboxIndex: 0,
  uploadInProgress: false,
  // Status por arquivo ("pending" | "uploading" | "done" | "error") e chave de
  // idempotência reaproveitada entre tentativas do mesmo arquivo.
  fileStatus: new WeakMap(),
  uploadIds: new WeakMap(),
  fileElements: new WeakMap()
};

const elements = {
  intro: document.querySelector("#intro"),
  enterAlbum: document.querySelector("#enterAlbum"),
  album: document.querySelector("#album"),
  galleryStage: document.querySelector("#galleryStage"),
  gallery: document.querySelector("#gallery"),
  galleryMore: document.querySelector("#galleryMore"),
  loadMorePhotos: document.querySelector("#loadMorePhotos"),
  photoCount: document.querySelector("#photoCount"),
  emptyState: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyCopy: document.querySelector("#emptyCopy"),
  uploadDialog: document.querySelector("#uploadDialog"),
  uploadForm: document.querySelector("#uploadForm"),
  photoInput: document.querySelector("#photoInput"),
  dropZone: document.querySelector("#dropZone"),
  selectedFiles: document.querySelector("#selectedFiles"),
  uploadProgress: document.querySelector("#uploadProgress"),
  uploadProgressBar: document.querySelector("#uploadProgressBar"),
  guestName: document.querySelector("#photoCaption"),
  savePhotos: document.querySelector("#savePhotos"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxVideo: document.querySelector("#lightboxVideo"),
  lightboxCaption: document.querySelector("#lightboxCaption"),
  lightboxMeta: document.querySelector("#lightboxMeta"),
  lightboxReactions: document.querySelector("#lightboxReactions"),
  scheduleDialog: document.querySelector("#scheduleDialog"),
  scheduleProgress: document.querySelector("#scheduleProgress"),
  resumeBanner: document.querySelector("#resumeBanner"),
  resumeText: document.querySelector("#resumeText"),
  resumeUploads: document.querySelector("#resumeUploads"),
  dismissResume: document.querySelector("#dismissResume"),
  toast: document.querySelector("#toast")
};

function createUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function getVisitorId() {
  try {
    const savedId = localStorage.getItem(VISITOR_STORAGE_KEY);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedId || "")) {
      return savedId;
    }
    const visitorId = createUuid();
    localStorage.setItem(VISITOR_STORAGE_KEY, visitorId);
    return visitorId;
  } catch (error) {
    console.warn("Não foi possível salvar a identificação local das reações:", error);
    return createUuid();
  }
}

function pluralizeMedia(value) {
  return `${value} ${value === 1 ? "lembrança" : "lembranças"}`;
}

function sentLabel(value) {
  return `${pluralizeMedia(value)} ${value === 1 ? "enviada" : "enviadas"}`;
}

function clearObjectUrls(list) {
  list.forEach((url) => URL.revokeObjectURL(url));
  list.length = 0;
}

// ---- Fila offline (IndexedDB) -------------------------------------------
// Guarda o blob otimizado antes do envio. Se a aba fechar ou a rede cair, o
// convidado pode retomar o envio na próxima visita sem perder a foto.
function openQueueDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const request = indexedDB.open(QUEUE_DB, QUEUE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueAdd(item) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).put(item);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

async function queueRemove(id) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

async function queueAll() {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readonly");
    const request = tx.objectStore(QUEUE_STORE).getAll();
    request.onsuccess = () => { db.close(); resolve(request.result || []); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function updateResumeBanner() {
  let items = [];
  try {
    items = await queueAll();
  } catch (error) {
    items = [];
  }
  const visible = items.length > 0
    && !state.resumeDismissed
    && !document.body.classList.contains("intro-active");
  elements.resumeBanner.hidden = !visible;
  if (!visible) return;
  elements.resumeText.textContent = `${items.length} ${items.length === 1 ? "lembrança pendente" : "lembranças pendentes"} de envio.`;
}

async function resumePendingUploads() {
  if (state.resumingUploads || state.uploadInProgress) return;
  let items = [];
  try {
    items = await queueAll();
  } catch (error) {
    return;
  }
  if (!items.length) {
    await updateResumeBanner();
    return;
  }

  state.resumingUploads = true;
  elements.resumeUploads.disabled = true;
  let done = 0;

  for (const item of items) {
    try {
      const uploaded = await uploadOneWithRetry(
        (onProgress) => uploadWithProgress(item.blob, item.contentType, item.guestName, item.id, onProgress)
      );
      if (item.thumbBlob && uploaded?.id) {
        try {
          await uploadOneWithRetry(
            (onProgress) => uploadThumbWithProgress(uploaded.id, item.thumbBlob, onProgress)
          );
        } catch (error) {
          // a miniatura é opcional; a mídia principal já foi enviada
        }
      }
      await queueRemove(item.id);
      done += 1;
    } catch (error) {
      console.warn("Falha ao retomar upload:", error);
      break;
    }
  }

  state.resumingUploads = false;
  elements.resumeUploads.disabled = false;
  if (done > 0) {
    await loadPhotos({ reset: true });
    showToast(`${done} ${done === 1 ? "lembrança enviada" : "lembranças enviadas"} ao retomar.`);
  } else {
    showToast("Ainda não foi possível retomar os envios.");
  }
  await updateResumeBanner();
}

function formatUploadDate(value) {
  if (!value) return "Nosso casamento";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Nosso casamento";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setEmptyState(title, copy) {
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.emptyState.hidden = false;
}

function emptyReactionState() {
  return {
    counts: Object.fromEntries(REACTIONS.map(({ key }) => [key, 0])),
    myReaction: null
  };
}

function reactionSignature(photo) {
  return `${photo.myReaction || ""}:${REACTIONS.map(({ key }) => photo.reactions?.[key] || 0).join(":")}`;
}

// Mantém a URL abaixo do limite de 16 KB da Cloudflare, mesmo com centenas de
// fotos carregadas (cada id tem ~36 caracteres).
const REACTION_REQUEST_CHUNK = 40;

async function getReactionData(photoIds) {
  const reactions = new Map(photoIds.map((photoId) => [photoId, emptyReactionState()]));
  if (!photoIds.length || !state.reactionsAvailable) return reactions;

  for (let i = 0; i < photoIds.length; i += REACTION_REQUEST_CHUNK) {
    try {
      const chunk = photoIds.slice(i, i + REACTION_REQUEST_CHUNK);
      const params = new URLSearchParams({
        ids: chunk.join(","),
        visitor: state.visitorId
      });
      const response = await fetch(`${API_BASE}/api/reactions?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();

      (payload.reactions || []).forEach((row) => {
        const photoReactions = reactions.get(row.photo_id);
        if (!photoReactions || !REACTIONS.some(({ key }) => key === row.reaction)) return;
        photoReactions.counts[row.reaction] = Number(row.count) || 0;
        if (row.mine) photoReactions.myReaction = row.reaction;
      });
    } catch (error) {
      // Um lote com falha não deve apagar as reações dos demais. Para um único
      // lote (ex.: toggle de uma foto), propaga o erro para o chamador.
      if (photoIds.length <= REACTION_REQUEST_CHUNK) throw error;
      console.warn("Falha ao ler um lote de reações:", error);
    }
  }
  return reactions;
}

function createReactionBar(photo, modifier = "") {
  const bar = document.createElement("div");
  bar.className = `reaction-bar${modifier ? ` ${modifier}` : ""}`;
  bar.dataset.photoId = photo.id;
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Reações à fotografia");

  const prompt = document.createElement("span");
  prompt.className = "reaction-label";
  prompt.textContent = "Reaja";
  bar.append(prompt);

  REACTIONS.forEach((reaction) => {
    const count = photo.reactions?.[reaction.key] || 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reaction-button";
    button.dataset.reaction = reaction.key;
    button.dataset.label = reaction.label;
    button.title = reaction.label;
    button.setAttribute("aria-pressed", String(photo.myReaction === reaction.key));
    button.setAttribute("aria-label", `${reaction.label}: ${count} ${count === 1 ? "reação" : "reações"}`);
    button.innerHTML = `<span class="reaction-emoji" aria-hidden="true">${reaction.emoji}</span><span class="reaction-count">${count}</span>`;
    button.addEventListener("click", () => toggleReaction(photo.id, reaction.key));
    bar.append(button);
  });

  return bar;
}

function updateReactionViews(photoId) {
  const photo = state.photos.find((item) => item.id === photoId);
  if (!photo) return;

  document.querySelectorAll(".reaction-bar").forEach((bar) => {
    if (bar.dataset.photoId !== photoId) return;
    bar.querySelectorAll(".reaction-button").forEach((button) => {
      const reaction = REACTIONS.find(({ key }) => key === button.dataset.reaction);
      if (!reaction) return;
      const count = photo.reactions?.[reaction.key] || 0;
      button.querySelector(".reaction-count").textContent = count;
      button.setAttribute("aria-pressed", String(photo.myReaction === reaction.key));
      button.setAttribute("aria-label", `${reaction.label}: ${count} ${count === 1 ? "reação" : "reações"}`);
      button.disabled = state.reactionRequests.has(photoId);
    });
  });
}

async function toggleReaction(photoId, reactionKey) {
  const photo = state.photos.find((item) => item.id === photoId);
  if (!photo || state.reactionRequests.has(photoId)) return;
  if (!state.reactionsAvailable) {
    showToast("As reações estão indisponíveis no momento.");
    return;
  }

  const previousReaction = photo.myReaction;
  const nextReaction = previousReaction === reactionKey ? null : reactionKey;
  const previousCounts = { ...photo.reactions };
  if (previousReaction) photo.reactions[previousReaction] = Math.max(0, (photo.reactions[previousReaction] || 0) - 1);
  if (nextReaction) photo.reactions[nextReaction] = (photo.reactions[nextReaction] || 0) + 1;
  photo.myReaction = nextReaction;
  state.reactionRequests.add(photoId);
  updateReactionViews(photoId);

  try {
    const response = await fetch(`${API_BASE}/api/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photo_id: photoId,
        reaction: reactionKey,
        visitor_id: state.visitorId
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const refreshed = await getReactionData([photoId]);
    const serverState = refreshed.get(photoId);
    if (serverState) {
      photo.reactions = serverState.counts;
      photo.myReaction = serverState.myReaction;
    }
  } catch (error) {
    photo.reactions = previousCounts;
    photo.myReaction = previousReaction;
    console.error("Não foi possível salvar a reação:", error);
    showToast("Não foi possível salvar sua reação. Tente novamente.");
  } finally {
    state.reactionRequests.delete(photoId);
    updateReactionViews(photoId);
  }
}

function isVideoKey(key) {
  const extension = String(key || "").split(".").pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(extension);
}

function comparePhotos(a, b) {
  return (b.createdAtMs - a.createdAtMs) || String(b.id).localeCompare(String(a.id));
}

function updateGalleryMore() {
  if (!elements.galleryMore) return;
  elements.galleryMore.hidden = !state.photosHasMore || !state.photos.length;
}

function renderGallery() {
  elements.gallery.replaceChildren();
  elements.gallery.setAttribute("aria-busy", "false");
  elements.photoCount.textContent = pluralizeMedia(state.photosTotal || state.photos.length);

  if (!state.photos.length) {
    elements.galleryStage.hidden = true;
    updateGalleryMore();
    setEmptyState(
      "Ainda não há lembranças aqui",
      "Seja o primeiro a compartilhar uma lembrança do nosso casamento."
    );
    return;
  }

  elements.emptyState.hidden = true;
  elements.galleryStage.hidden = false;
  state.photos.forEach((photo, index) => {
    const card = document.createElement("article");
    card.className = "photo-card";
    card.style.animationDelay = `${Math.min(index * 55, 330)}ms`;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "photo-open";
    openButton.setAttribute("aria-label", `Abrir lembrança enviada por ${photo.guestName}`);

    const isVideo = photo.mediaType === "video";
    const hasPoster = Boolean(photo.thumbSrc && photo.thumbSrc !== photo.src);

    if (isVideo && !hasPoster) {
      const video = document.createElement("video");
      video.src = photo.src;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-hidden", "true");
      openButton.append(video);
    } else {
      const image = document.createElement("img");
      image.src = photo.thumbSrc || photo.src;
      image.alt = isVideo
        ? `Vídeo do casamento enviado por ${photo.guestName}`
        : `Lembrança do casamento enviada por ${photo.guestName}`;
      image.loading = index < 4 ? "eager" : "lazy";
      image.decoding = "async";
      openButton.append(image);
    }

    if (isVideo) {
      openButton.insertAdjacentHTML("beforeend", '<span class="photo-play" aria-hidden="true">▶</span>');
    }

    const info = document.createElement("div");
    info.className = "photo-card-info";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = photo.guestName;
    const date = document.createElement("span");
    date.textContent = formatUploadDate(photo.createdAt);
    copy.append(title, date);
    info.append(copy);
    info.insertAdjacentHTML("beforeend", '<span class="photo-card-mark" aria-hidden="true">S · G</span>');

    openButton.insertAdjacentHTML("beforeend", `<span class="photo-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><span class="photo-zoom" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 16 16 8M9 8h7v7"/></svg></span>`);
    openButton.addEventListener("click", () => openLightbox(index));
    card.append(openButton, info, createReactionBar(photo));
    elements.gallery.append(card);
  });

  updateGalleryMore();
}

async function loadPhotos({ silent = false, reset = true } = {}) {
  if (!API_BASE) {
    elements.photoCount.textContent = "Álbum indisponível";
    setEmptyState("Não foi possível abrir o álbum", "Atualize a página e tente novamente.");
    return;
  }
  if (state.loadingPhotos) return;
  state.loadingPhotos = true;

  if (!silent) {
    elements.gallery.setAttribute("aria-busy", "true");
    elements.photoCount.textContent = "Carregando lembranças…";
  }

  try {
    const params = new URLSearchParams();
    if (!reset && state.photosBefore && state.photosBeforeId) {
      params.set("before", String(state.photosBefore));
      params.set("beforeId", state.photosBeforeId);
    }
    const query = params.toString();
    const response = await fetch(`${API_BASE}/api/photos${query ? `?${query}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload.photos) ? payload.photos : [];

    const incoming = rows.map((row) => ({
      id: row.id,
      name: row.key,
      src: `${CDN_BASE}/${row.key}`,
      thumbSrc: row.thumb_key ? `${CDN_BASE}/${row.thumb_key}` : `${CDN_BASE}/${row.key}`,
      mediaType: isVideoKey(row.key) ? "video" : "image",
      guestName: row.guest_name || "Convidado especial",
      createdAt: row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
      createdAtMs: Number(row.created_at) || 0,
      reactions: emptyReactionState().counts,
      myReaction: null
    }));

    // Mantém as reações já conhecidas para não "zerar" a galeria a cada refresh.
    const existingById = new Map(state.photos.map((photo) => [photo.id, photo]));
    incoming.forEach((photo) => {
      const previous = existingById.get(photo.id);
      if (!previous) return;
      photo.reactions = { ...previous.reactions };
      photo.myReaction = previous.myReaction;
    });

    let nextPhotos;
    if (reset) {
      const merged = new Map();
      incoming.forEach((photo) => merged.set(photo.id, photo));
      state.photos.forEach((photo) => {
        if (!merged.has(photo.id)) merged.set(photo.id, photo);
      });
      nextPhotos = [...merged.values()].sort(comparePhotos);
    } else {
      nextPhotos = [...state.photos, ...incoming];
    }

    // Busca reações apenas para fotos novas; de tempos em tempos refaz tudo para
    // captar as reações dos outros convidados. Evita ler o banco inteiro sempre.
    const allIds = nextPhotos.map(({ id }) => id);
    const fullRefresh = Date.now() - state.lastReactionRefresh > REACTION_REFRESH_MS;
    const idsToFetch = fullRefresh
      ? allIds
      : allIds.filter((id) => !state.reactionPhotos.has(id));

    if (idsToFetch.length) {
      try {
        const reactionData = await getReactionData(idsToFetch);
        idsToFetch.forEach((id) => state.reactionPhotos.add(id));
        if (fullRefresh) state.lastReactionRefresh = Date.now();
        nextPhotos.forEach((photo) => {
          const photoReactions = reactionData.get(photo.id);
          if (!photoReactions) return;
          photo.reactions = photoReactions.counts;
          photo.myReaction = photoReactions.myReaction;
        });
      } catch (error) {
        console.warn("Não foi possível atualizar as reações:", error);
      }
    }

    const changed = nextPhotos.length !== state.photos.length
      || nextPhotos.some((photo, index) => (
        photo.id !== state.photos[index]?.id
        || photo.guestName !== state.photos[index]?.guestName
        || photo.thumbSrc !== state.photos[index]?.thumbSrc
        || reactionSignature(photo) !== reactionSignature(state.photos[index] || {})
      ));

    // Cursor: atualiza no primeiro carregamento ou ao carregar a próxima
    // página. Num refresh da primeira página, preserva o cursor já carregado.
    if (!reset || state.photos.length === 0) {
      state.photosBefore = payload.nextBefore ?? null;
      state.photosBeforeId = payload.nextBeforeId ?? null;
      state.photosHasMore = Boolean(payload.hasMore);
    }

    state.photosTotal = Number(payload.total) || nextPhotos.length;
    state.photos = nextPhotos;
    if (changed || !silent) renderGallery();
  } catch (error) {
    console.error("Não foi possível carregar as lembranças:", error);
    if (silent) return;
    elements.gallery.replaceChildren();
    elements.galleryStage.hidden = true;
    elements.gallery.setAttribute("aria-busy", "false");
    elements.photoCount.textContent = "Álbum aguardando conexão";
    updateGalleryMore();
    setEmptyState(
      "O álbum não carregou agora",
      "Verifique a conexão e tente novamente, ou avise os noivos."
    );
  } finally {
    state.loadingPhotos = false;
  }
}

async function loadMorePhotos() {
  if (!state.photosHasMore || !state.photosBefore || !state.photosBeforeId || state.loadingMore || state.loadingPhotos) return;
  state.loadingMore = true;
  elements.loadMorePhotos.disabled = true;
  elements.loadMorePhotos.textContent = "Carregando…";
  try {
    await loadPhotos({ silent: true, reset: false });
  } finally {
    state.loadingMore = false;
    elements.loadMorePhotos.disabled = false;
    elements.loadMorePhotos.textContent = "Carregar mais lembranças";
    updateGalleryMore();
  }
}

function openLightbox(index) {
  if (!state.photos.length) return;
  state.lightboxIndex = index;
  updateLightbox();
  elements.lightbox.showModal();
}

function updateLightbox() {
  const photo = state.photos[state.lightboxIndex];
  if (!photo) return;
  const isVideo = photo.mediaType === "video";

  if (isVideo) {
    elements.lightboxImage.hidden = true;
    elements.lightboxImage.removeAttribute("src");
    elements.lightboxVideo.hidden = false;
    elements.lightboxVideo.poster = photo.thumbSrc && photo.thumbSrc !== photo.src ? photo.thumbSrc : "";
    elements.lightboxVideo.src = photo.src;
    elements.lightboxVideo.load();
  } else {
    elements.lightboxVideo.pause();
    elements.lightboxVideo.hidden = true;
    elements.lightboxVideo.removeAttribute("src");
    elements.lightboxVideo.load();
    elements.lightboxImage.hidden = false;
    elements.lightboxImage.src = photo.src;
    elements.lightboxImage.alt = `Lembrança do casamento enviada por ${photo.guestName}`;
  }

  elements.lightboxCaption.textContent = photo.guestName;
  elements.lightboxMeta.textContent = `${formatUploadDate(photo.createdAt)} · ${state.lightboxIndex + 1} de ${state.photos.length}`;
  elements.lightboxReactions.replaceChildren(createReactionBar(photo, "reaction-bar-lightbox"));
}

function moveLightbox(direction) {
  const total = state.photos.length;
  if (!total) return;
  state.lightboxIndex = (state.lightboxIndex + direction + total) % total;
  updateLightbox();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function openUploadDialog() {
  resetUploadForm();
  elements.uploadDialog.showModal();
}

function closeUploadDialog() {
  if (state.uploadInProgress) return;
  elements.uploadDialog.close();
}

function scheduleInputs() {
  return [...elements.scheduleDialog.querySelectorAll(".schedule-item input")];
}

function updateScheduleProgress() {
  const inputs = scheduleInputs();
  const done = inputs.filter((input) => input.checked).length;
  elements.scheduleProgress.innerHTML = `<strong>${done}</strong> de ${inputs.length} etapas concluídas`;
  try {
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(
      Object.fromEntries(inputs.map((input) => [input.id, input.checked]))
    ));
  } catch (error) {
    console.warn("Não foi possível salvar o progresso do roteiro:", error);
  }
}

function loadScheduleProgress() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SCHEDULE_STORAGE_KEY)) || {};
  } catch (error) {
    saved = {};
  }
  scheduleInputs().forEach((input) => { input.checked = Boolean(saved[input.id]); });
  updateScheduleProgress();
}

function openScheduleDialog() {
  elements.scheduleDialog.showModal();
}

function closeScheduleDialog() {
  elements.scheduleDialog.close();
}

function setUploadProgress(fraction, label) {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (elements.uploadProgressBar) {
    elements.uploadProgressBar.style.width = `${Math.round(clamped * 100)}%`;
  }
  if (elements.uploadProgress) {
    elements.uploadProgress.hidden = !(clamped > 0);
  }
  if (typeof label === "string") elements.savePhotos.textContent = label;
}

function resetUploadForm() {
  if (state.uploadInProgress) return;
  clearObjectUrls(state.previewUrls);
  state.selectedFiles = [];
  state.fileStatus = new WeakMap();
  state.uploadIds = new WeakMap();
  state.fileElements = new WeakMap();
  elements.uploadForm.reset();
  elements.selectedFiles.replaceChildren();
  elements.selectedFiles.hidden = true;
  if (elements.uploadProgress) elements.uploadProgress.hidden = true;
  if (elements.uploadProgressBar) elements.uploadProgressBar.style.width = "0%";
  elements.savePhotos.disabled = true;
  elements.savePhotos.textContent = "Enviar para o álbum";
}

function fileSignature(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function handleFiles(files) {
  const incoming = [...files];
  const validFiles = incoming.filter((file) => {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (isVideo && !ALLOWED_VIDEO_TYPES.has(file.type)) return false;
    const limit = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
    return (isImage || isVideo) && file.size <= limit;
  });
  if (!validFiles.length) {
    showToast("Escolha fotos de até 30 MB ou vídeos de até 80 MB.");
    return;
  }

  // Ignora arquivos idênticos já selecionados (evita enviar a mesma mídia 2x).
  const seen = new Set(state.selectedFiles.map(fileSignature));
  const unique = validFiles.filter((file) => {
    const signature = fileSignature(file);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });

  if (unique.length < validFiles.length) showToast("Algumas lembranças já estavam na lista.");
  if (validFiles.length !== incoming.length) showToast("Alguns arquivos não puderam ser adicionados.");
  if (unique.length > 20) showToast("Você pode enviar até 20 lembranças por vez.");

  state.selectedFiles = unique.slice(0, 20);
  renderSelectedFiles();
}

function statusText(status) {
  if (status === "uploading") return "↑";
  if (status === "done") return "✓";
  if (status === "error") return "!";
  return "";
}

function setFileStatus(file, status) {
  state.fileStatus.set(file, status);
  const preview = state.fileElements.get(file);
  if (!preview) return;
  preview.dataset.status = status;
  const badge = preview.querySelector(".file-status");
  if (!badge) return;
  badge.dataset.status = status;
  badge.textContent = statusText(status);
}

function renderSelectedFiles() {
  clearObjectUrls(state.previewUrls);
  elements.selectedFiles.replaceChildren();
  state.fileElements = new WeakMap();
  state.selectedFiles.slice(0, 7).forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const status = state.fileStatus.get(file) || "pending";
    const preview = document.createElement("div");
    preview.className = "file-preview";
    preview.dataset.status = status;
    if (file.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      preview.append(video);
    } else {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      preview.append(image);
    }
    const number = document.createElement("span");
    number.className = "file-number";
    number.textContent = index + 1;
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.dataset.status = status;
    badge.textContent = statusText(status);
    preview.append(number, badge);
    state.fileElements.set(file, preview);
    elements.selectedFiles.append(preview);
  });
  if (state.selectedFiles.length > 7) {
    const more = document.createElement("div");
    more.className = "file-preview";
    more.style.display = "grid";
    more.style.placeItems = "center";
    more.textContent = `+${state.selectedFiles.length - 7}`;
    elements.selectedFiles.append(more);
  }
  elements.selectedFiles.hidden = !state.selectedFiles.length;
  elements.savePhotos.disabled = !state.selectedFiles.length || !API_BASE;
}

function isHeicFile(file) {
  return /^image\/hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
}

function renderToBlob(bitmap, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

// Extrai um quadro do vídeo para usar como miniatura/pôster. Se o navegador
// não conseguir (codec, política de mídia), devolve null e a galeria mostra o
// próprio <video> com metadados.
function createVideoPoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (blob) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(blob);
    };

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      const target = Math.min(1, Math.max(0.1, (video.duration || 2) / 2));
      try {
        video.currentTime = target;
      } catch (error) {
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), "image/webp", .72);
      } catch (error) {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 10000);
    video.src = url;
  });
}

async function optimizeMedia(file) {
  if (file.type.startsWith("video/")) {
    return {
      blob: file,
      contentType: file.type || "video/mp4",
      thumb: await createVideoPoster(file),
      isVideo: true
    };
  }

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const full = await renderToBlob(bitmap, 2200, .86);
      const thumb = await renderToBlob(bitmap, 600, .72);
      if (full) return { blob: full, contentType: "image/webp", thumb, isVideo: false };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.warn("A foto será enviada no formato original:", error);
  }

  // HEIC não é decodificado por vários navegadores. Melhor avisar do que subir
  // um arquivo que não vai aparecer na galeria.
  if (isHeicFile(file)) throw new Error("HEIC_NOT_SUPPORTED");

  return { blob: file, contentType: file.type || "image/jpeg", thumb: null, isVideo: false };
}

// Reaproveita a mesma chave de idempotência entre tentativas do mesmo arquivo:
// se o servidor já gravou a foto, o retry devolve a existente em vez de duplicar.
function uploadIdFor(file) {
  let id = state.uploadIds.get(file);
  if (!id) {
    id = createUuid();
    state.uploadIds.set(file, id);
  }
  return id;
}

function postBlob(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = contentType.startsWith("video/")
      ? VIDEO_UPLOAD_TIMEOUT_MS
      : IMAGE_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let payload = {};
        try {
          payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch (error) {
          payload = {};
        }
        resolve(payload);
        return;
      }
      const error = new Error(`Upload falhou (HTTP ${xhr.status})`);
      error.status = xhr.status;
      error.retryAfter = Number(xhr.getResponseHeader("Retry-After")) || 0;
      reject(error);
    };
    xhr.onerror = () => {
      const error = new Error("Erro de rede no upload");
      error.status = 0;
      reject(error);
    };
    xhr.ontimeout = () => {
      const error = new Error("Tempo limite de upload excedido");
      error.status = 0;
      reject(error);
    };
    xhr.send(blob);
  });
}

function uploadWithProgress(blob, contentType, guestName, uploadId, onProgress) {
  const url = `${API_BASE}/api/upload?guest=${encodeURIComponent(guestName)}&upload=${encodeURIComponent(uploadId)}`;
  return postBlob(url, blob, contentType, onProgress);
}

function uploadThumbWithProgress(photoId, blob, onProgress) {
  const url = `${API_BASE}/api/upload?photo=${encodeURIComponent(photoId)}&variant=thumb`;
  return postBlob(url, blob, "image/webp", onProgress);
}

async function uploadOneWithRetry(post, onProgress) {
  let lastError;
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await post(onProgress);
    } catch (error) {
      lastError = error;
      const retryable = !error.status || RETRYABLE_STATUS.has(error.status);
      if (attempt === UPLOAD_ATTEMPTS - 1 || !retryable) break;
      onProgress?.(0);
      // Em 429 respeita o Retry-After do servidor, em vez de insistir à toa.
      const wait = error.status === 429
        ? Math.min(Math.max(error.retryAfter || 15, 5), 60) * 1000
        : 2 ** attempt * 1000 + Math.random() * 500;
      await sleep(wait);
    }
  }
  throw lastError || new Error("Upload falhou");
}

async function uploadSelectedPhotos(event) {
  event.preventDefault();
  if (!state.selectedFiles.length || !API_BASE || state.uploadInProgress || state.resumingUploads) return;

  state.uploadInProgress = true;
  elements.savePhotos.disabled = true;
  setUploadProgress(0);
  const guestName = elements.guestName.value.trim() || "Convidado especial";
  const total = state.selectedFiles.length;
  let uploadedCount = 0;
  const failed = [];

  for (let index = 0; index < total; index += 1) {
    const file = state.selectedFiles[index];
    setFileStatus(file, "uploading");
    setUploadProgress(index / total, `Enviando ${index + 1} de ${total}…`);

    try {
      const optimized = await optimizeMedia(file);
      const uploadId = uploadIdFor(file);

      // Guarda na fila antes de enviar: se a aba fechar no meio, a lembrança
      // pode ser retomada depois sem perder o arquivo.
      try {
        await queueAdd({
          id: uploadId,
          blob: optimized.blob,
          thumbBlob: optimized.thumb || null,
          contentType: optimized.contentType,
          guestName,
          createdAt: Date.now()
        });
      } catch (error) {
        console.warn("Não foi possível salvar a fila offline:", error);
      }

      const uploaded = await uploadOneWithRetry(
        (onProgress) => uploadWithProgress(
          optimized.blob,
          optimized.contentType,
          guestName,
          uploadId,
          onProgress
        ),
        (fraction) => {
          setUploadProgress(
            (index + fraction) / total,
            `Enviando ${index + 1} de ${total}…`
          );
        }
      );

      if (optimized.thumb && uploaded?.id) {
        try {
          await uploadOneWithRetry(
            (onProgress) => uploadThumbWithProgress(uploaded.id, optimized.thumb, onProgress)
          );
        } catch (error) {
          console.warn("Miniatura não pôde ser enviada:", error);
        }
      }

      try {
        await queueRemove(uploadId);
      } catch (error) {
        console.warn("Não foi possível limpar a fila offline:", error);
      }

      uploadedCount += 1;
      setFileStatus(file, "done");
    } catch (error) {
      console.error("Erro ao enviar lembrança:", error);
      setFileStatus(file, "error");
      failed.push({ file, error });
    }
  }

  state.uploadInProgress = false;
  setUploadProgress(0);

  if (uploadedCount > 0) await loadPhotos({ reset: true });

  if (!failed.length) {
    elements.uploadDialog.close();
    resetUploadForm();
    showToast(`${sentLabel(uploadedCount)} com sucesso.`);
    document.querySelector("#galeria").scrollIntoView({ behavior: "smooth", block: "start" });
    await updateResumeBanner();
    return;
  }

  // HEIC não tem como ser reenviado: avisa e deixa na lista só as falhas
  // temporárias, para o convidado tentar de novo sem repetir as que já subiram.
  const retryable = failed
    .filter(({ error }) => error?.message !== "HEIC_NOT_SUPPORTED")
    .map(({ file }) => file);
  const unsupportedCount = failed.length - retryable.length;

  const parts = [];
  if (uploadedCount > 0) parts.push(sentLabel(uploadedCount));
  if (retryable.length > 0) {
    parts.push(`${retryable.length} ${retryable.length === 1 ? "falhou" : "falharam"}`);
  }
  if (unsupportedCount > 0) {
    parts.push(`${unsupportedCount} HEIC não suportada${unsupportedCount === 1 ? "" : "s"}`);
  }
  showToast(`${parts.join("; ")}.`);

  if (!retryable.length) {
    elements.uploadDialog.close();
    resetUploadForm();
    await updateResumeBanner();
    return;
  }

  state.selectedFiles = retryable;
  renderSelectedFiles();
  elements.savePhotos.disabled = false;
  elements.savePhotos.textContent = "Tentar novamente";
  await updateResumeBanner();
}

function setupRevealAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: .14 });
  document.querySelectorAll(".reveal").forEach((item) => observer.observe(item));
}

function enterAlbum() {
  elements.album.removeAttribute("inert");
  elements.enterAlbum.blur();
  window.scrollTo({ top: 0, behavior: "instant" });
  elements.album.focus({ preventScroll: true });
  document.body.classList.remove("intro-active");
  window.requestAnimationFrame(() => elements.intro.classList.add("is-leaving"));
  updateResumeBanner();
}

elements.enterAlbum.addEventListener("click", enterAlbum);
document.querySelectorAll("[data-open-upload]").forEach((button) => button.addEventListener("click", openUploadDialog));
document.querySelectorAll("[data-close-upload]").forEach((button) => button.addEventListener("click", closeUploadDialog));
document.querySelectorAll("[data-open-schedule]").forEach((button) => button.addEventListener("click", openScheduleDialog));
document.querySelectorAll("[data-close-schedule]").forEach((button) => button.addEventListener("click", closeScheduleDialog));
scheduleInputs().forEach((input) => input.addEventListener("change", updateScheduleProgress));
elements.photoInput.addEventListener("change", (event) => handleFiles(event.target.files));
elements.uploadForm.addEventListener("submit", uploadSelectedPhotos);
elements.loadMorePhotos.addEventListener("click", loadMorePhotos);
elements.resumeUploads.addEventListener("click", resumePendingUploads);
elements.dismissResume.addEventListener("click", () => {
  state.resumeDismissed = true;
  elements.resumeBanner.hidden = true;
});

["dragenter", "dragover"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
}));
elements.dropZone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

document.querySelector("#closeLightbox").addEventListener("click", () => elements.lightbox.close());
document.querySelector("#previousPhoto").addEventListener("click", () => moveLightbox(-1));
document.querySelector("#nextPhoto").addEventListener("click", () => moveLightbox(1));

elements.lightbox.addEventListener("close", () => {
  elements.lightboxVideo.pause();
  elements.lightboxVideo.removeAttribute("src");
  elements.lightboxVideo.load();
});

document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
  // Não sequestra as setas enquanto o convidado usa os controles do vídeo.
  if (event.target === elements.lightboxVideo) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
});

[elements.uploadDialog, elements.lightbox, elements.scheduleDialog].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !state.uploadInProgress) dialog.close();
  });
});
elements.uploadDialog.addEventListener("cancel", (event) => {
  if (state.uploadInProgress) event.preventDefault();
});
elements.uploadDialog.addEventListener("close", resetUploadForm);

// Evita perder um envio em andamento se o convidado fechar/atualizar a aba.
window.addEventListener("beforeunload", (event) => {
  if (!state.uploadInProgress) return;
  event.preventDefault();
  event.returnValue = "";
});

function startAutoRefresh() {
  const tick = () => {
    if (
      !document.hidden
      && !state.uploadInProgress
      && !state.resumingUploads
      && !state.loadingMore
      && !state.reactionRequests.size
      && !elements.uploadDialog.open
      && !elements.lightbox.open
      && !elements.scheduleDialog.open
    ) {
      loadPhotos({ silent: true, reset: true });
    }
    window.setTimeout(tick, AUTO_REFRESH_MS + Math.random() * AUTO_REFRESH_JITTER_MS);
  };
  window.setTimeout(tick, AUTO_REFRESH_MS);
}

function initializeAlbum() {
  setupRevealAnimations();
  loadScheduleProgress();
  loadPhotos({ reset: true });
  updateResumeBanner();
  startAutoRefresh();
}

initializeAlbum();
