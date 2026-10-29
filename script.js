// Backend: Cloudflare Worker + R2. O site continua publicado no Vercel.
const API_BASE = "https://casamento-api.samuelvcallegaro.workers.dev";
const CDN_BASE = "https://pub-f77d17221fca4030bd4cef5c245225b3.r2.dev";
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 4;
const AUTO_REFRESH_MS = 45_000;
const AUTO_REFRESH_JITTER_MS = 15_000;
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
  selectedFiles: [],
  previewUrls: [],
  visitorId: getVisitorId(),
  reactionsAvailable: true,
  reactionRequests: new Set(),
  lightboxIndex: 0,
  uploadInProgress: false
};

const elements = {
  intro: document.querySelector("#intro"),
  enterAlbum: document.querySelector("#enterAlbum"),
  album: document.querySelector("#album"),
  galleryStage: document.querySelector("#galleryStage"),
  gallery: document.querySelector("#gallery"),
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
  lightboxCaption: document.querySelector("#lightboxCaption"),
  lightboxMeta: document.querySelector("#lightboxMeta"),
  lightboxReactions: document.querySelector("#lightboxReactions"),
  scheduleDialog: document.querySelector("#scheduleDialog"),
  scheduleProgress: document.querySelector("#scheduleProgress"),
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

function pluralizePhotos(value) {
  return `${value} ${value === 1 ? "fotografia" : "fotografias"}`;
}

function clearObjectUrls(list) {
  list.forEach((url) => URL.revokeObjectURL(url));
  list.length = 0;
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

async function getReactionData(photoIds) {
  const reactions = new Map(photoIds.map((photoId) => [photoId, emptyReactionState()]));
  if (!photoIds.length || !state.reactionsAvailable) return reactions;

  const params = new URLSearchParams({
    ids: photoIds.join(","),
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

function renderGallery() {
  elements.gallery.replaceChildren();
  elements.gallery.setAttribute("aria-busy", "false");
  elements.photoCount.textContent = pluralizePhotos(state.photos.length);

  if (!state.photos.length) {
    elements.galleryStage.hidden = true;
    setEmptyState(
      "Ainda não há fotos aqui",
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
    openButton.setAttribute("aria-label", `Abrir fotografia enviada por ${photo.guestName}`);

    const image = document.createElement("img");
    image.src = photo.src;
    image.alt = `Fotografia do casamento enviada por ${photo.guestName}`;
    image.loading = index < 4 ? "eager" : "lazy";
    image.decoding = "async";

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

    openButton.append(image);
    openButton.insertAdjacentHTML("beforeend", `<span class="photo-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><span class="photo-zoom" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 16 16 8M9 8h7v7"/></svg></span>`);
    openButton.addEventListener("click", () => openLightbox(index));
    card.append(openButton, info, createReactionBar(photo));
    elements.gallery.append(card);
  });
}

async function loadPhotos({ silent = false } = {}) {
  if (!API_BASE) {
    elements.photoCount.textContent = "Álbum indisponível";
    setEmptyState("Não foi possível abrir o álbum", "Atualize a página e tente novamente.");
    return;
  }

  if (!silent) {
    elements.gallery.setAttribute("aria-busy", "true");
    elements.photoCount.textContent = "Carregando fotografias…";
  }

  try {
    const response = await fetch(`${API_BASE}/api/photos`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload.photos) ? payload.photos : [];

    const nextPhotos = rows.map((row) => ({
      id: row.id,
      name: row.key,
      src: `${CDN_BASE}/${row.key}`,
      guestName: row.guest_name || "Convidado especial",
      createdAt: row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
      reactions: emptyReactionState().counts,
      myReaction: null
    }));

    try {
      const reactionData = await getReactionData(nextPhotos.map(({ id }) => id));
      nextPhotos.forEach((photo) => {
        const photoReactions = reactionData.get(photo.id);
        if (!photoReactions) return;
        photo.reactions = photoReactions.counts;
        photo.myReaction = photoReactions.myReaction;
      });
    } catch (error) {
      nextPhotos.forEach((photo) => {
        const previousPhoto = state.photos.find(({ id }) => id === photo.id);
        if (!previousPhoto) return;
        photo.reactions = { ...previousPhoto.reactions };
        photo.myReaction = previousPhoto.myReaction;
      });
      console.warn("Não foi possível atualizar as reações:", error);
    }

    const changed = nextPhotos.length !== state.photos.length
      || nextPhotos.some((photo, index) => (
        photo.id !== state.photos[index]?.id
        || photo.guestName !== state.photos[index]?.guestName
        || reactionSignature(photo) !== reactionSignature(state.photos[index] || {})
      ));
    state.photos = nextPhotos;
    if (changed || !silent) renderGallery();
  } catch (error) {
    console.error("Não foi possível carregar as fotos:", error);
    if (silent) return;
    elements.gallery.replaceChildren();
    elements.galleryStage.hidden = true;
    elements.gallery.setAttribute("aria-busy", "false");
    elements.photoCount.textContent = "Álbum aguardando conexão";
    setEmptyState(
      "O álbum não carregou agora",
      "Verifique a conexão e tente novamente, ou avise os noivos."
    );
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
  elements.lightboxImage.src = photo.src;
  elements.lightboxImage.alt = `Fotografia do casamento enviada por ${photo.guestName}`;
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
  elements.uploadForm.reset();
  elements.selectedFiles.replaceChildren();
  elements.selectedFiles.hidden = true;
  if (elements.uploadProgress) elements.uploadProgress.hidden = true;
  if (elements.uploadProgressBar) elements.uploadProgressBar.style.width = "0%";
  elements.savePhotos.disabled = true;
  elements.savePhotos.textContent = "Enviar para o álbum";
}

function handleFiles(files) {
  const incoming = [...files];
  const validFiles = incoming.filter((file) => file.type.startsWith("image/") && file.size <= MAX_FILE_SIZE);
  if (!validFiles.length) {
    showToast("Escolha imagens de até 30 MB.");
    return;
  }
  if (validFiles.length !== incoming.length) showToast("Alguns arquivos não puderam ser adicionados.");
  state.selectedFiles = validFiles.slice(0, 20);
  renderSelectedFiles();
}

function renderSelectedFiles() {
  clearObjectUrls(state.previewUrls);
  elements.selectedFiles.replaceChildren();
  state.selectedFiles.slice(0, 7).forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const preview = document.createElement("div");
    preview.className = "file-preview";
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    const number = document.createElement("span");
    number.textContent = index + 1;
    preview.append(image, number);
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

function extensionForFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (extension && extension.length <= 5) return extension;
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

async function optimizeImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .86));
    if (blob) return { blob, extension: "webp", contentType: "image/webp" };
  } catch (error) {
    console.warn("A foto será enviada no formato original:", error);
  }
  return { blob: file, extension: extensionForFile(file), contentType: file.type || "image/jpeg" };
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function uploadWithProgress(blob, contentType, guestName, onProgress) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}/api/upload?guest=${encodeURIComponent(guestName)}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload falhou (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Erro de rede no upload"));
    xhr.ontimeout = () => reject(new Error("Tempo limite de upload excedido"));
    xhr.send(blob);
  });
}

async function uploadOneWithRetry(blob, contentType, guestName, onProgress) {
  let lastError;
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await uploadWithProgress(blob, contentType, guestName, onProgress);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === UPLOAD_ATTEMPTS - 1) break;
      onProgress?.(0);
      await sleep(2 ** attempt * 1000 + Math.random() * 500);
    }
  }
  throw lastError || new Error("Upload falhou");
}

async function uploadSelectedPhotos(event) {
  event.preventDefault();
  if (!state.selectedFiles.length || !API_BASE || state.uploadInProgress) return;

  state.uploadInProgress = true;
  elements.savePhotos.disabled = true;
  setUploadProgress(0);
  const guestName = elements.guestName.value.trim() || "Convidado especial";
  const total = state.selectedFiles.length;
  let uploadedCount = 0;

  try {
    for (let index = 0; index < total; index += 1) {
      const optimized = await optimizeImage(state.selectedFiles[index]);
      await uploadOneWithRetry(optimized.blob, optimized.contentType, guestName, (fraction) => {
        setUploadProgress(
          (index + fraction) / total,
          `Enviando ${index + 1} de ${total}…`
        );
      });
      uploadedCount += 1;
    }

    state.uploadInProgress = false;
    setUploadProgress(0);
    elements.uploadDialog.close();
    resetUploadForm();
    await loadPhotos();
    showToast(`${pluralizePhotos(total)} enviadas com sucesso.`);
    document.querySelector("#galeria").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("Erro ao enviar fotos:", error);
    state.uploadInProgress = false;
    setUploadProgress(0);
    if (uploadedCount > 0) {
      elements.uploadDialog.close();
      resetUploadForm();
      await loadPhotos();
      showToast(`${pluralizePhotos(uploadedCount)} enviadas; não foi possível concluir as demais.`);
      return;
    }
    elements.savePhotos.disabled = false;
    elements.savePhotos.textContent = "Tentar novamente";
    showToast("Não foi possível enviar. Verifique a conexão e tente novamente.");
  }
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
}

elements.enterAlbum.addEventListener("click", enterAlbum);
document.querySelectorAll("[data-open-upload]").forEach((button) => button.addEventListener("click", openUploadDialog));
document.querySelectorAll("[data-close-upload]").forEach((button) => button.addEventListener("click", closeUploadDialog));
document.querySelectorAll("[data-open-schedule]").forEach((button) => button.addEventListener("click", openScheduleDialog));
document.querySelectorAll("[data-close-schedule]").forEach((button) => button.addEventListener("click", closeScheduleDialog));
scheduleInputs().forEach((input) => input.addEventListener("change", updateScheduleProgress));
elements.photoInput.addEventListener("change", (event) => handleFiles(event.target.files));
elements.uploadForm.addEventListener("submit", uploadSelectedPhotos);

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

document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
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

function startAutoRefresh() {
  const tick = () => {
    if (!document.hidden && !state.uploadInProgress && !state.reactionRequests.size && !elements.uploadDialog.open && !elements.lightbox.open && !elements.scheduleDialog.open) {
      loadPhotos({ silent: true });
    }
    window.setTimeout(tick, AUTO_REFRESH_MS + Math.random() * AUTO_REFRESH_JITTER_MS);
  };
  window.setTimeout(tick, AUTO_REFRESH_MS);
}

function initializeAlbum() {
  setupRevealAnimations();
  loadScheduleProgress();
  loadPhotos();
  startAutoRefresh();
}

initializeAlbum();
