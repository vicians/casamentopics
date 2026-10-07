const seedPhotos = [
  { id: "seed-1", src: "assets/1.png", caption: "Leveza em cada encontro", category: "Nós dois", alt: "Samuel e Gabriela sorrindo juntos em um jardim", seed: true },
  { id: "seed-2", src: "assets/2.png", caption: "O abraço que é casa", category: "Noivado", alt: "Gabriela abraçando Samuel ao ar livre", seed: true },
  { id: "seed-3", src: "assets/3.png", caption: "A nossa canção", category: "Nós dois", alt: "Casal sentado na grama com um instrumento musical", seed: true },
  { id: "seed-4", src: "assets/fotomaonova.jpg", caption: "Um sim para a vida inteira", category: "Noivado", alt: "Mãos do casal com as alianças", seed: true },
  { id: "seed-5", src: "assets/4.png", caption: "De mãos dadas", category: "Nós dois", alt: "Samuel e Gabriela de mãos dadas em um jardim", seed: true },
  { id: "seed-6", src: "assets/fotoroca.png", caption: "Nosso amor, nossa aventura", category: "Noivado", alt: "Samuel e Gabriela em um abraço alegre", seed: true }
];

const DB_NAME = "album-samuel-gabriela";
const STORE_NAME = "photos";
const MAX_FILE_SIZE = 30 * 1024 * 1024;

const state = {
  db: null,
  uploads: [],
  selectedFiles: [],
  previewUrls: [],
  galleryUrls: [],
  filter: "Todos",
  visiblePhotos: [],
  lightboxIndex: 0
};

const elements = {
  intro: document.querySelector("#intro"),
  enterAlbum: document.querySelector("#enterAlbum"),
  album: document.querySelector("#album"),
  gallery: document.querySelector("#gallery"),
  photoCount: document.querySelector("#photoCount"),
  emptyState: document.querySelector("#emptyState"),
  uploadDialog: document.querySelector("#uploadDialog"),
  uploadForm: document.querySelector("#uploadForm"),
  photoInput: document.querySelector("#photoInput"),
  dropZone: document.querySelector("#dropZone"),
  selectedFiles: document.querySelector("#selectedFiles"),
  photoCaption: document.querySelector("#photoCaption"),
  photoCategory: document.querySelector("#photoCategory"),
  savePhotos: document.querySelector("#savePhotos"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxCaption: document.querySelector("#lightboxCaption"),
  lightboxMeta: document.querySelector("#lightboxMeta"),
  deletePhoto: document.querySelector("#deletePhoto"),
  toast: document.querySelector("#toast")
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getStoredPhotos() {
  if (!state.db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

function storePhoto(photo) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(photo);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function removeStoredPhoto(id) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function pluralizePhotos(value) {
  return `${value} ${value === 1 ? "fotografia" : "fotografias"}`;
}

function clearObjectUrls(list) {
  list.forEach((url) => URL.revokeObjectURL(url));
  list.length = 0;
}

function renderGallery() {
  clearObjectUrls(state.galleryUrls);
  const uploads = state.uploads.map((photo) => {
    const src = URL.createObjectURL(photo.blob);
    state.galleryUrls.push(src);
    return { ...photo, src, alt: photo.caption || "Fotografia adicionada ao álbum", seed: false };
  });
  const allPhotos = [...uploads, ...seedPhotos];
  state.visiblePhotos = state.filter === "Todos" ? allPhotos : allPhotos.filter((photo) => photo.category === state.filter);

  elements.gallery.replaceChildren();
  elements.emptyState.hidden = state.visiblePhotos.length > 0;
  elements.photoCount.textContent = pluralizePhotos(allPhotos.length);

  state.visiblePhotos.forEach((photo, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "photo-card";
    card.style.animationDelay = `${Math.min(index * 55, 330)}ms`;
    card.setAttribute("aria-label", `Abrir fotografia: ${photo.caption || photo.category}`);

    const image = document.createElement("img");
    image.src = photo.src;
    image.alt = photo.alt;
    image.loading = index < 4 ? "eager" : "lazy";
    image.decoding = "async";

    const info = document.createElement("span");
    info.className = "photo-card-info";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = photo.caption || "Uma nova lembrança";
    const category = document.createElement("span");
    category.textContent = photo.category;
    copy.append(title, category);
    info.append(copy);
    info.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7"/></svg>');

    card.append(image, info);
    card.addEventListener("click", () => openLightbox(index));
    elements.gallery.append(card);
  });
}

function openLightbox(index) {
  if (!state.visiblePhotos.length) return;
  state.lightboxIndex = index;
  updateLightbox();
  elements.lightbox.showModal();
}

function updateLightbox() {
  const photo = state.visiblePhotos[state.lightboxIndex];
  if (!photo) return;
  elements.lightboxImage.src = photo.src;
  elements.lightboxImage.alt = photo.alt;
  elements.lightboxCaption.textContent = photo.caption || "Uma nova lembrança";
  elements.lightboxMeta.textContent = `${photo.category} · ${state.lightboxIndex + 1} de ${state.visiblePhotos.length}`;
  elements.deletePhoto.hidden = photo.seed;
  elements.deletePhoto.dataset.id = photo.id;
}

function moveLightbox(direction) {
  const total = state.visiblePhotos.length;
  state.lightboxIndex = (state.lightboxIndex + direction + total) % total;
  updateLightbox();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

function openUploadDialog() {
  resetUploadForm();
  elements.uploadDialog.showModal();
}

function closeUploadDialog() {
  elements.uploadDialog.close();
  resetUploadForm();
}

function resetUploadForm() {
  clearObjectUrls(state.previewUrls);
  state.selectedFiles = [];
  elements.uploadForm.reset();
  elements.selectedFiles.replaceChildren();
  elements.selectedFiles.hidden = true;
  elements.savePhotos.disabled = true;
  elements.savePhotos.textContent = "Salvar no álbum";
}

function handleFiles(files) {
  const validFiles = [...files].filter((file) => file.type.startsWith("image/") && file.size <= MAX_FILE_SIZE);
  if (!validFiles.length) {
    showToast("Escolha imagens de até 30 MB.");
    return;
  }
  if (validFiles.length !== files.length) showToast("Alguns arquivos não puderam ser adicionados.");
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
  elements.savePhotos.disabled = !state.selectedFiles.length || !state.db;
}

async function optimizeImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .88));
    return blob || file;
  } catch {
    return file;
  }
}

async function saveSelectedPhotos(event) {
  event.preventDefault();
  if (!state.selectedFiles.length || !state.db) return;
  const savedCount = state.selectedFiles.length;
  elements.savePhotos.disabled = true;
  elements.savePhotos.textContent = "Salvando…";
  try {
    const commonCaption = elements.photoCaption.value.trim();
    const category = elements.photoCategory.value;
    for (let index = 0; index < state.selectedFiles.length; index += 1) {
      const file = state.selectedFiles[index];
      const blob = await optimizeImage(file);
      await storePhoto({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${index}`,
        blob,
        caption: commonCaption || (state.selectedFiles.length > 1 ? `Lembrança ${index + 1}` : "Uma nova lembrança"),
        category,
        originalName: file.name,
        createdAt: Date.now() + index
      });
    }
    state.uploads = await getStoredPhotos();
    renderGallery();
    closeUploadDialog();
    showToast(`${pluralizePhotos(savedCount)} salvas no álbum.`);
  } catch (error) {
    console.error(error);
    elements.savePhotos.disabled = false;
    elements.savePhotos.textContent = "Tentar novamente";
    showToast("Não foi possível salvar. Verifique o espaço do navegador.");
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
elements.uploadForm.addEventListener("submit", saveSelectedPhotos);

["dragenter", "dragover"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
}));
elements.dropZone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", active);
    });
    renderGallery();
  });
});

document.querySelector("#closeLightbox").addEventListener("click", () => elements.lightbox.close());
document.querySelector("#previousPhoto").addEventListener("click", () => moveLightbox(-1));
document.querySelector("#nextPhoto").addEventListener("click", () => moveLightbox(1));
elements.deletePhoto.addEventListener("click", async () => {
  const photo = state.visiblePhotos[state.lightboxIndex];
  if (!photo || photo.seed) return;
  if (!window.confirm("Excluir esta foto deste dispositivo?")) return;
  await removeStoredPhoto(photo.id);
  state.uploads = await getStoredPhotos();
  elements.lightbox.close();
  renderGallery();
  showToast("Fotografia excluída do álbum.");
});

document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
});

[elements.uploadDialog, elements.lightbox].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});
elements.uploadDialog.addEventListener("close", resetUploadForm);

async function initializeAlbum() {
  setupRevealAnimations();
  try {
    state.db = await openDatabase();
    state.uploads = await getStoredPhotos();
  } catch (error) {
    console.warn("Armazenamento local indisponível:", error);
    document.querySelectorAll("[data-open-upload]").forEach((button) => {
      button.addEventListener("click", () => showToast("Seu navegador não permite salvar fotos localmente."), { once: true });
    });
  }
  renderGallery();
}

initializeAlbum();
