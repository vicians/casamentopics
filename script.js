const SUPABASE_URL = "https://zhqvzmtxbogtfkvgntko.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpocXZ6bXR4Ym9ndGZrdmdudGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzOTE0NDYsImV4cCI6MjEwNjk2NzQ0Nn0.fEDRljNELH7aGXA4a04XEH3ZI_KGFCxq7oeGJdgMLNU";
const BUCKET_NAME = "casamento-fotos";
const UPLOAD_FOLDER = "uploads";
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const AUTO_REFRESH_MS = 20_000;

const storageClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

const state = {
  photos: [],
  selectedFiles: [],
  previewUrls: [],
  guestNames: new Map(),
  lightboxIndex: 0,
  uploadInProgress: false
};

const elements = {
  intro: document.querySelector("#intro"),
  enterAlbum: document.querySelector("#enterAlbum"),
  album: document.querySelector("#album"),
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
  guestName: document.querySelector("#photoCaption"),
  savePhotos: document.querySelector("#savePhotos"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxCaption: document.querySelector("#lightboxCaption"),
  lightboxMeta: document.querySelector("#lightboxMeta"),
  toast: document.querySelector("#toast")
};

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

function isMissingBucketError(error) {
  const statusCode = String(error?.statusCode ?? "");
  const message = String(error?.message ?? "");
  return error?.code === "NoSuchBucket"
    || statusCode === "404"
    || /bucket not found/i.test(message);
}

function guestNameFromMetadata(file) {
  const metadata = file.metadata || {};
  return file.user_metadata?.guestName
    || file.userMetadata?.guestName
    || metadata.guestName
    || metadata.guest_name
    || metadata.user_metadata?.guestName
    || metadata.userMetadata?.guestName
    || "Convidado especial";
}

async function loadGuestNames(files) {
  const guestNames = new Map();
  const uncachedFiles = [];

  files.forEach((file) => {
    if (state.guestNames.has(file.id)) {
      guestNames.set(file.id, state.guestNames.get(file.id));
    } else {
      uncachedFiles.push(file);
    }
  });

  const batchSize = 8;
  for (let index = 0; index < uncachedFiles.length; index += batchSize) {
    const batch = uncachedFiles.slice(index, index + batchSize);
    await Promise.all(batch.map(async (file) => {
      try {
        const path = `${UPLOAD_FOLDER}/${file.name}`;
        const { data, error } = await storageClient.storage.from(BUCKET_NAME).info(path);
        if (error) throw error;
        const guestName = guestNameFromMetadata(data);
        state.guestNames.set(file.id, guestName);
        guestNames.set(file.id, guestName);
      } catch (error) {
        console.warn(`Não foi possível carregar o nome associado a ${file.name}:`, error);
        guestNames.set(file.id, guestNameFromMetadata(file));
      }
    }));
  }

  return guestNames;
}

function setEmptyState(title, copy) {
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.emptyState.hidden = false;
}

function renderGallery() {
  elements.gallery.replaceChildren();
  elements.gallery.setAttribute("aria-busy", "false");
  elements.photoCount.textContent = pluralizePhotos(state.photos.length);

  if (!state.photos.length) {
    setEmptyState(
      "Ainda não há fotos aqui",
      "Seja o primeiro a compartilhar uma lembrança do nosso casamento."
    );
    return;
  }

  elements.emptyState.hidden = true;
  state.photos.forEach((photo, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "photo-card";
    card.style.animationDelay = `${Math.min(index * 55, 330)}ms`;
    card.setAttribute("aria-label", `Abrir fotografia enviada por ${photo.guestName}`);

    const image = document.createElement("img");
    image.src = photo.src;
    image.alt = `Fotografia do casamento enviada por ${photo.guestName}`;
    image.loading = index < 4 ? "eager" : "lazy";
    image.decoding = "async";

    const info = document.createElement("span");
    info.className = "photo-card-info";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = photo.guestName;
    const date = document.createElement("span");
    date.textContent = formatUploadDate(photo.createdAt);
    copy.append(title, date);
    info.append(copy);
    info.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7"/></svg>');

    card.append(image, info);
    card.addEventListener("click", () => openLightbox(index));
    elements.gallery.append(card);
  });
}

async function loadPhotos({ silent = false } = {}) {
  if (!storageClient) {
    elements.photoCount.textContent = "Álbum indisponível";
    setEmptyState("Não foi possível abrir o álbum", "Atualize a página e tente novamente.");
    return;
  }

  if (!silent) {
    elements.gallery.setAttribute("aria-busy", "true");
    elements.photoCount.textContent = "Carregando fotografias…";
  }

  try {
    const files = [];
    const pageSize = 100;
    for (let offset = 0; offset < 1000; offset += pageSize) {
      const { data, error } = await storageClient.storage
        .from(BUCKET_NAME)
        .list(UPLOAD_FOLDER, {
          limit: pageSize,
          offset,
          sortBy: { column: "created_at", order: "desc" }
        });
      if (error) throw error;
      files.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }

    const imageFiles = files
      .filter((file) => file.id && /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name));
    const guestNames = await loadGuestNames(imageFiles);
    const nextPhotos = imageFiles
      .map((file) => {
        const path = `${UPLOAD_FOLDER}/${file.name}`;
        const { data: publicData } = storageClient.storage.from(BUCKET_NAME).getPublicUrl(path);
        return {
          id: file.id,
          name: file.name,
          src: publicData.publicUrl,
          guestName: guestNames.get(file.id) || guestNameFromMetadata(file),
          createdAt: file.created_at || file.updated_at
        };
      });

    const changed = nextPhotos.length !== state.photos.length
      || nextPhotos.some((photo, index) => (
        photo.id !== state.photos[index]?.id
        || photo.guestName !== state.photos[index]?.guestName
      ));
    state.photos = nextPhotos;
    if (changed || !silent) renderGallery();
  } catch (error) {
    console.error("Não foi possível carregar as fotos do Supabase:", error);
    elements.gallery.replaceChildren();
    elements.gallery.setAttribute("aria-busy", "false");
    if (isMissingBucketError(error)) {
      elements.photoCount.textContent = "Bucket ainda não configurado";
      setEmptyState(
        "O álbum ainda não foi configurado",
        "Execute o arquivo supabase-setup.sql no painel do Supabase."
      );
    } else {
      elements.photoCount.textContent = "Álbum aguardando configuração";
      setEmptyState(
        "O álbum ainda não está disponível",
        "Tente novamente em alguns instantes ou avise os noivos."
      );
    }
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

function resetUploadForm() {
  if (state.uploadInProgress) return;
  clearObjectUrls(state.previewUrls);
  state.selectedFiles = [];
  elements.uploadForm.reset();
  elements.selectedFiles.replaceChildren();
  elements.selectedFiles.hidden = true;
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
  elements.savePhotos.disabled = !state.selectedFiles.length || !storageClient;
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

async function uploadSelectedPhotos(event) {
  event.preventDefault();
  if (!state.selectedFiles.length || !storageClient || state.uploadInProgress) return;

  state.uploadInProgress = true;
  elements.savePhotos.disabled = true;
  const guestName = elements.guestName.value.trim() || "Convidado especial";
  let uploadedCount = 0;

  try {
    const total = state.selectedFiles.length;
    for (let index = 0; index < total; index += 1) {
      elements.savePhotos.textContent = `Enviando ${index + 1} de ${total}…`;
      const optimized = await optimizeImage(state.selectedFiles[index]);
      const filename = `${Date.now()}-${randomId()}.${optimized.extension}`;
      const path = `${UPLOAD_FOLDER}/${filename}`;
      const { data, error } = await storageClient.storage.from(BUCKET_NAME).upload(path, optimized.blob, {
        cacheControl: "3600",
        contentType: optimized.contentType,
        upsert: false,
        metadata: { guestName }
      });
      if (error) throw error;
      if (data?.id) state.guestNames.set(data.id, guestName);
      uploadedCount += 1;
    }

    state.uploadInProgress = false;
    elements.uploadDialog.close();
    resetUploadForm();
    await loadPhotos();
    showToast(`${pluralizePhotos(total)} enviadas com sucesso.`);
    document.querySelector("#galeria").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("Erro ao enviar fotos ao Supabase:", error);
    state.uploadInProgress = false;
    if (uploadedCount > 0) {
      elements.uploadDialog.close();
      resetUploadForm();
      await loadPhotos();
      showToast(`${pluralizePhotos(uploadedCount)} enviadas; não foi possível concluir as demais.`);
      return;
    }
    elements.savePhotos.disabled = false;
    elements.savePhotos.textContent = "Tentar novamente";
    showToast(isMissingBucketError(error)
      ? "O álbum ainda não foi configurado no Supabase."
      : "Não foi possível enviar. Tente novamente ou avise os noivos.");
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

[elements.uploadDialog, elements.lightbox].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !state.uploadInProgress) dialog.close();
  });
});
elements.uploadDialog.addEventListener("cancel", (event) => {
  if (state.uploadInProgress) event.preventDefault();
});
elements.uploadDialog.addEventListener("close", resetUploadForm);

function startAutoRefresh() {
  window.setInterval(() => {
    if (!document.hidden && !state.uploadInProgress && !elements.uploadDialog.open && !elements.lightbox.open) {
      loadPhotos({ silent: true });
    }
  }, AUTO_REFRESH_MS);
}

function initializeAlbum() {
  setupRevealAnimations();
  loadPhotos();
  startAutoRefresh();
}

initializeAlbum();
