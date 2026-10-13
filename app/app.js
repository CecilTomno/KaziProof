const TENANT_ID = "demo-cleaning-co";
const DB_NAME = "crewproof-local-v1";
const MAX_PHOTOS = 2;
let databasePromise;
let workers = [];
let selectedWorkerId = localStorage.getItem("crewproof-worker") || "worker-musa";
let selectedJobId = null;
let currentView = localStorage.getItem("crewproof-view") || "office";
let forcedOffline = false;
let toastTimer;
let photoData = [];
let signaturePad = null;

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const safeImageSource = value => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value || "") ? value : "";

function openLocalDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "mutation_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("local_database_failed"));
  });
  return databasePromise;
}

async function storeRequest(storeName, mode, method, value) {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = method === "getAll" ? store.getAll() : method === "get" ? store.get(value) : method === "delete" ? store.delete(value) : store.put(value);
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("local_storage_failed"));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("local_transaction_aborted"));
  });
}
const getAll = store => storeRequest(store, "readonly", "getAll");
const getOne = (store, key) => storeRequest(store, "readonly", "get", key);
const putOne = (store, value) => storeRequest(store, "readwrite", "put", value);
const deleteOne = (store, key) => storeRequest(store, "readwrite", "delete", key);

function localDateISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function prettyDate(value) {
  if (!value) return "Date not set";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return escapeHtml(value);
  return new Intl.DateTimeFormat("en-KE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
}
function shortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-KE", { hour: "numeric", minute: "2-digit" }).format(date);
}
function isEffectivelyOnline() {
  return navigator.onLine && !forcedOffline;
}
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}
function setNetworkState(serverReachable = navigator.onLine) {
  const badge = $("#networkBadge");
  const simulated = forcedOffline;
  const isOnline = navigator.onLine && !simulated && serverReachable;
  badge.classList.toggle("offline", !isOnline);
  badge.querySelector("span").textContent = simulated || !navigator.onLine ? "Offline · saved on phone" : serverReachable ? "Connected to demo" : "Server unavailable";
  $("#offlineNotice").hidden = isOnline;
  $("#offlineToggle").classList.toggle("enabled", simulated);
  $("#offlineToggle").textContent = simulated ? "Stop offline simulation" : "Simulate offline";
  $("#createJobButton").disabled = !isOnline;
}
function setPendingCount(count) {
  $("#pendingCount").textContent = String(count);
  const tag = $("#workerPendingTag");
  tag.hidden = count === 0;
  tag.textContent = String(count);
}

async function cacheServerJobs(serverJobs) {
  const cached = await getAll("jobs");
  const oldById = new Map(cached.map(job => [job.id, job]));
  const outbox = await getAll("outbox");
  const pendingByJob = new Map(outbox.map(event => [event.job_id, event]));
  const merged = serverJobs.map(remote => {
    const event = pendingByJob.get(remote.id);
    if (!event) return remote;
    return {
      ...remote,
      status: "pending_sync",
      local_completion: {
        payload: event.payload,
        occurred_at: event.occurred_at,
        review_required: false
      }
    };
  });
  for (const event of outbox) {
    if (!merged.some(job => job.id === event.job_id) && oldById.has(event.job_id)) {
      merged.push({
        ...oldById.get(event.job_id),
        status: "pending_sync",
        local_completion: { payload: event.payload, occurred_at: event.occurred_at, review_required: false }
      });
    }
  }
  for (const job of merged) await putOne("jobs", job);
}

async function fetchBootstrap() {
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error(`bootstrap_${response.status}`);
  const payload = await response.json();
  if (payload.tenant?.id !== TENANT_ID) throw new Error("tenant_context_invalid");
  if (payload.tenant.name) $("#tenantName").textContent = payload.tenant.name.toUpperCase();
  workers = payload.workers || [];
  await cacheServerJobs(payload.jobs || []);
  populateWorkerOptions();
  return payload;
}

function populateWorkerOptions() {
  const workerOptions = workers.map(worker => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`).join("");
  $("#assignWorker").innerHTML = workerOptions || '<option value="">No worker available</option>';
  $("#workerSelect").innerHTML = workerOptions || '<option value="">No worker available</option>';
  if (!workers.some(worker => worker.id === selectedWorkerId)) selectedWorkerId = workers[0]?.id || "";
  $("#workerSelect").value = selectedWorkerId;
  localStorage.setItem("crewproof-worker", selectedWorkerId);
}

function statusLabel(job) {
  if (job.status === "pending_sync") return ["Saved on phone", "pending"];
  if (job.status === "completed_pending_review") return ["Needs review", "review"];
  if (job.status === "completed") return ["Completed", "completed"];
  if (job.status === "in_progress") return ["In progress", "pending"];
  return ["Assigned", "assigned"];
}
function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}
function formatCompletion(job) {
  return job.local_completion || job.completion || null;
}
function renderProofPreview(completion) {
  const payload = completion?.payload;
  if (!payload) return "";
  const checks = (payload.checklist || []).filter(item => item.done).map(item => item.label);
  const images = (payload.evidence || []).map(item => safeImageSource(item.data_url)).filter(Boolean);
  return `<div class="completion-preview">
    <strong>${completion.review_required ? "Saved for supervisor review" : "Field update received"}</strong>${completion.occurred_at ? ` · ${escapeHtml(shortTime(completion.occurred_at))}` : ""}<br>
    ${checks.length ? `${checks.length} checklist items complete` : "Checklist submitted"}${payload.client_signoff_name ? ` · Signed by ${escapeHtml(payload.client_signoff_name)}` : ""}${payload.notes ? `<br><span>${escapeHtml(payload.notes)}</span>` : ""}
    ${images.length ? `<div class="proof-images">${images.map(src => `<img src="${src}" alt="Job completion evidence">`).join("")}</div>` : ""}
  </div>`;
}

async function renderOffice() {
  const jobs = (await getAll("jobs")).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)));
  const today = localDateISO();
  const todaysJobs = jobs.filter(job => job.scheduled_for === today);
  const completed = todaysJobs.filter(job => ["completed", "completed_pending_review"].includes(job.status)).length;
  const outbox = await getAll("outbox");
  const attention = outbox.length + todaysJobs.filter(job => job.status === "completed_pending_review").length;
  $("#metricScheduled").textContent = String(todaysJobs.length);
  $("#metricCompleted").textContent = String(completed);
  $("#metricAttention").textContent = String(attention);
  setPendingCount(outbox.length);
  $("#todayLabel").textContent = new Intl.DateTimeFormat("en-KE", { weekday: "short", day: "numeric", month: "short" }).format(new Date());

  const list = $("#officeJobs");
  if (!jobs.length) {
    list.innerHTML = '<div class="empty-state">No jobs yet. Create the first visit from the form.</div>';
    return;
  }
  list.innerHTML = jobs.map(job => {
    const [label, klass] = statusLabel(job);
    return `<article class="job-row">
      <div class="job-client"><strong>${escapeHtml(job.client_name)}</strong><small>${escapeHtml(job.site_name)} · ${escapeHtml(job.service_type)} · ${prettyDate(job.scheduled_for)}</small></div>
      <div class="job-assignee"><span class="user-badge">${escapeHtml(initials(job.assigned_worker_name))}</span><span>${escapeHtml(job.assigned_worker_name)}</span></div>
      <span class="status-pill ${klass}">${label}</span>
      ${renderProofPreview(formatCompletion(job))}
    </article>`;
  }).join("");
}

function renderWorkerJobs() {
  return getAll("jobs").then(jobs => {
    const assigned = jobs.filter(job => job.assigned_worker_id === selectedWorkerId).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)));
    $("#workerJobCount").textContent = String(assigned.length);
    $("#workerDateLabel").textContent = assigned.some(job => job.scheduled_for === localDateISO()) ? "Today · Your assigned visits" : "Your assigned visits";
    const list = $("#workerJobs");
    if (!assigned.length) {
      list.innerHTML = '<div class="empty-state">No visits assigned to this worker yet.</div>';
      $("#jobDetail").innerHTML = '<div class="empty-detail"><h2>No assigned visits</h2><p>Ask the office to assign a visit. Once it is on this phone, you can open it offline.</p></div>';
      return;
    }
    if (!assigned.some(job => job.id === selectedJobId)) selectedJobId = assigned[0].id;
    list.innerHTML = assigned.map(job => {
      const [label, klass] = statusLabel(job);
      return `<button class="worker-job ${job.id === selectedJobId ? "selected" : ""}" type="button" data-job-id="${escapeHtml(job.id)}">
        <span class="worker-job-top"><strong>${escapeHtml(job.client_name)}</strong><span class="status-pill ${klass}">${label}</span></span>
        <small>${escapeHtml(job.site_name)} · ${prettyDate(job.scheduled_for)}</small>
        <small>${escapeHtml(job.service_type)}</small>
      </button>`;
    }).join("");
    list.querySelectorAll("[data-job-id]").forEach(button => button.addEventListener("click", () => {
      selectedJobId = button.dataset.jobId;
      renderWorkerJobs();
    }));
    const job = assigned.find(item => item.id === selectedJobId);
    renderJobDetail(job);
  });
}

function renderJobDetail(job) {
  const detail = $("#jobDetail");
  if (!job) return;
  signaturePad?.destroy();
  signaturePad = null;
  const completion = formatCompletion(job);
  if (completion) {
    const payload = completion.payload || {};
    const images = (payload.evidence || []).map(item => safeImageSource(item.data_url)).filter(Boolean);
    const signature = safeImageSource(payload.signature_data_url);
    const checklist = payload.checklist || [];
    detail.innerHTML = `<div class="detail-top"><div class="detail-title"><span class="section-kicker">${job.status === "pending_sync" ? "SAVED ON THIS PHONE" : "VISIT UPDATE"}</span><h2>${escapeHtml(job.client_name)}</h2><p>${escapeHtml(job.site_name)} · ${prettyDate(job.scheduled_for)}</p></div><span class="status-pill ${job.status === "pending_sync" ? "pending" : job.status === "completed_pending_review" ? "review" : "completed"}">${job.status === "pending_sync" ? "Queued to sync" : job.status === "completed_pending_review" ? "Needs review" : "Completed"}</span></div>
      <div class="detail-service"><span>Service</span><strong>${escapeHtml(job.service_type)}</strong></div>
      <div class="checklist-title">Visit checklist <small>${checklist.filter(item => item.done).length} of ${checklist.length} complete</small></div>
      <div class="checklist">${checklist.map(item => `<div class="check-item ${item.done ? "checked" : ""}"><input type="checkbox" disabled ${item.done ? "checked" : ""}><span>${escapeHtml(item.label)}</span></div>`).join("")}</div>
      ${payload.notes ? `<div class="detail-service"><span>Worker notes</span><strong>${escapeHtml(payload.notes)}</strong></div>` : ""}
      ${payload.client_signoff_name ? `<div class="detail-service"><span>Client sign-off</span><strong>${escapeHtml(payload.client_signoff_name)}</strong></div>` : ""}
      ${images.length ? `<div class="proof-images detail-proof">${images.map(src => `<img src="${src}" alt="Saved job evidence">`).join("")}</div>` : ""}
      ${signature ? `<div class="signature-result"><span>Signature captured</span><img src="${signature}" alt="Client sign-off signature"></div>` : ""}
      <p class="signature-hint">${job.status === "pending_sync" ? "This evidence is still on the phone. Keep the app data until sync completes." : `Received by the demo server ${escapeHtml(shortTime(completion.received_at))}.`}</p>`;
    return;
  }

  const checklist = (job.checklist || []).map((item, index) => `<label class="check-item"><input type="checkbox" name="checklist" value="${escapeHtml(item.id || index)}" data-label="${escapeHtml(item.label)}"><span>${escapeHtml(item.label)}</span></label>`).join("");
  detail.innerHTML = `<div class="detail-top"><div class="detail-title"><span class="section-kicker">WORK ORDER · ${escapeHtml(job.id)}</span><h2>${escapeHtml(job.client_name)}</h2><p>${escapeHtml(job.site_name)} · ${prettyDate(job.scheduled_for)}</p></div><span class="status-pill">Assigned</span></div>
    <div class="detail-service"><span>Service</span><strong>${escapeHtml(job.service_type)}</strong></div>
    <form id="completionForm">
      <div class="checklist-title">Before you finish <small>Check each item</small></div>
      <div class="checklist">${checklist}</div>
      <div class="detail-form-grid">
        <label class="field"><span>Notes for the office or client</span><textarea name="notes" maxlength="700" placeholder="Anything the team should know?"></textarea></label>
        <div class="field"><span>Photo proof <small>(up to 2 compressed images)</small></span><label class="evidence-upload"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M3.5 11.5v3A2.5 2.5 0 0 0 6 17h8a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>Take or choose a photo</strong><small>Compressed on this phone before saving</small><input id="photoInput" type="file" accept="image/*" capture="environment" multiple></label><div id="photoPreview" class="photo-preview"></div></div>
      </div>
      <div class="signature-block"><div class="signature-head"><span>Client sign-off</span><button id="clearSignature" type="button">Clear signature</button></div><canvas id="signaturePad" class="signature-pad" aria-label="Draw client signature"></canvas><p class="signature-hint">Ask the client to sign on the screen, then enter their name below.</p><label class="field" style="margin-top:8px"><span>Client name</span><input name="signoff_name" maxlength="80" placeholder="Name of person confirming the visit" required></label></div>
      <div class="complete-row"><button class="button button-primary" type="submit"><span>Save completed visit</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button><span class="completion-note">${isEffectivelyOnline() ? "Your update will sync to the office." : "Saved locally until you reconnect."}</span></div>
    </form>`;
  photoData = [];
  bindCompletionForm(job);
}

function setupSignaturePad(canvas) {
  const context = canvas.getContext("2d");
  let drawing = false;
  let hasInk = false;
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const image = hasInk ? canvas.toDataURL("image/png") : null;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineWidth = 2.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#2c513e";
    if (image) {
      const img = new Image();
      img.onload = () => context.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = image;
    }
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  canvas.addEventListener("pointerdown", event => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    context.beginPath();
    context.moveTo(p.x, p.y);
    context.lineTo(p.x + .1, p.y + .1);
    context.stroke();
    drawing = true;
    hasInk = true;
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    const p = point(event);
    context.lineTo(p.x, p.y);
    context.stroke();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  return {
    hasInk: () => hasInk,
    dataUrl: () => canvas.toDataURL("image/png"),
    clear: () => { context.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; },
    destroy: () => resizeObserver.disconnect()
  };
}

function fileToCompressedDataUrl(file) {
  return createImageBitmap(file).then(bitmap => new Promise((resolve, reject) => {
    let scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const makeBlob = quality => new Promise(resolveBlob => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(resolveBlob, "image/jpeg", quality);
    });
    (async () => {
      let blob = await makeBlob(.68);
      if (blob && blob.size > 220_000) blob = await makeBlob(.48);
      if (blob && blob.size > 220_000) {
        scale = Math.min(scale, 800 / Math.max(bitmap.width, bitmap.height));
        blob = await makeBlob(.42);
      }
      bitmap.close();
      if (!blob || blob.size > 250_000) return reject(new Error("photo_too_large"));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("photo_read_failed"));
      reader.readAsDataURL(blob);
    })().catch(error => { bitmap.close(); reject(error); });
  }));
}

function bindCompletionForm(job) {
  const canvas = $("#signaturePad");
  signaturePad = setupSignaturePad(canvas);
  $("#clearSignature").addEventListener("click", () => signaturePad.clear());
  $("#photoInput").addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    if (photoData.length + files.length > MAX_PHOTOS) {
      showToast(`You can attach up to ${MAX_PHOTOS} photos per visit in this demo.`);
      event.target.value = "";
      return;
    }
    try {
      for (const file of files) photoData.push({ data_url: await fileToCompressedDataUrl(file), label: "Visit photo" });
      renderPhotoPreview();
    } catch (error) {
      showToast(error.message === "photo_too_large" ? "That image could not be compressed small enough. Try another photo." : "Could not read that image on this device.");
    } finally {
      event.target.value = "";
    }
  });

  $("#completionForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const checks = Array.from(form.querySelectorAll('input[name="checklist"]'));
    if (checks.some(input => !input.checked)) {
      showToast("Complete each checklist item before saving this visit.");
      return;
    }
    if (!signaturePad?.hasInk()) {
      showToast("Please capture the client's sign-off on the screen.");
      return;
    }
    const formData = new FormData(form);
    const signoffName = String(formData.get("signoff_name") || "").trim();
    if (!signoffName) {
      showToast("Enter the name of the person confirming the visit.");
      return;
    }
    const payload = {
      notes: String(formData.get("notes") || "").trim(),
      checklist: checks.map(input => ({ id: input.value, label: input.dataset.label, done: input.checked })),
      client_signoff_name: signoffName,
      signature_data_url: signaturePad.dataUrl(),
      evidence: photoData.slice()
    };
    const eventRecord = {
      mutation_id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `mut-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      tenant_id: TENANT_ID,
      job_id: job.id,
      actor_user_id: selectedWorkerId,
      event_type: "job.completed",
      expected_revision: job.revision,
      occurred_at: new Date().toISOString(),
      payload
    };
    try {
      await putOne("outbox", eventRecord);
      const localJob = await getOne("jobs", job.id) || job;
      localJob.status = "pending_sync";
      localJob.local_completion = { payload, occurred_at: eventRecord.occurred_at, review_required: false };
      await putOne("jobs", localJob);
      showToast(isEffectivelyOnline() ? "Visit saved. Syncing the update…" : "Visit saved on this phone. It will sync when you reconnect.");
      await renderAll();
      if (isEffectivelyOnline()) await syncOutbox();
    } catch (error) {
      console.error("Could not save the completion locally", error);
      showToast("Could not save this visit to the phone. Keep the app open and try again.");
    }
  });
}

function renderPhotoPreview() {
  const target = $("#photoPreview");
  if (!target) return;
  target.innerHTML = photoData.map(item => `<img src="${safeImageSource(item.data_url)}" alt="Selected visit evidence">`).join("");
}

async function renderAll() {
  setNetworkState();
  await renderOffice();
  await renderWorkerJobs();
}

function showView(view) {
  currentView = view === "worker" ? "worker" : "office";
  localStorage.setItem("crewproof-view", currentView);
  $("#officeView").hidden = currentView !== "office";
  $("#workerView").hidden = currentView !== "worker";
  document.querySelectorAll(".view-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === currentView));
  if (currentView === "worker") renderWorkerJobs();
}

async function syncOutbox() {
  if (!isEffectivelyOnline()) {
    showToast("This phone is offline. Updates are safely queued locally.");
    setNetworkState(false);
    return;
  }
  const events = (await getAll("outbox")).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  if (!events.length) {
    try {
      await fetchBootstrap();
      await renderAll();
      setNetworkState(true);
      showToast("Everything is up to date.");
    } catch {
      setNetworkState(false);
      showToast("Could not reach the demo server.");
    }
    return;
  }
  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events })
    });
    if (!response.ok) throw new Error(`sync_${response.status}`);
    const result = await response.json();
    let accepted = 0;
    let failed = 0;
    for (const item of result.results || []) {
      if (item.ok) {
        await deleteOne("outbox", item.mutation_id);
        accepted += 1;
      } else {
        failed += 1;
      }
    }
    await fetchBootstrap();
    await renderAll();
    setNetworkState(true);
    if (failed) showToast(`${accepted} update${accepted === 1 ? "" : "s"} synced; ${failed} need office review.`);
    else showToast(`${accepted} field update${accepted === 1 ? "" : "s"} synced to the office.`);
  } catch (error) {
    console.warn("Sync is waiting for a connection", error);
    setNetworkState(false);
    await renderAll();
    showToast("Could not sync yet. The update remains on this phone.");
  }
}

async function createJob(event) {
  event.preventDefault();
  if (!isEffectivelyOnline()) {
    showToast("Connect to the demo server before creating and assigning a job.");
    return;
  }
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const button = $("#createJobButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "job_create_failed");
    await fetchBootstrap();
    await renderAll();
    form.reset();
    form.elements.scheduled_for.value = localDateISO();
    showToast("Job created and assigned.");
  } catch (error) {
    showToast(error.message === "worker_not_found" ? "Choose an active worker." : "Could not create the job. Check the fields and try again.");
  } finally {
    button.disabled = !isEffectivelyOnline();
  }
}

async function refreshFromServer() {
  try {
    await fetchBootstrap();
    setNetworkState(true);
    await renderAll();
  } catch {
    setNetworkState(false);
    await renderAll();
  }
}

async function start() {
  $("#createJobForm").elements.scheduled_for.value = localDateISO();
  document.querySelectorAll(".view-tab").forEach(tab => tab.addEventListener("click", () => showView(tab.dataset.view)));
  $("#createJobForm").addEventListener("submit", createJob);
  $("#syncButton").addEventListener("click", syncOutbox);
  $("#refreshButton").addEventListener("click", refreshFromServer);
  $("#workerSelect").addEventListener("change", async event => {
    selectedWorkerId = event.target.value;
    localStorage.setItem("crewproof-worker", selectedWorkerId);
    selectedJobId = null;
    await renderWorkerJobs();
  });
  $("#offlineToggle").addEventListener("click", async () => {
    forcedOffline = !forcedOffline;
    setNetworkState();
    await renderAll();
    if (!forcedOffline) {
      await syncOutbox();
      await refreshFromServer();
    } else {
      showToast("Offline simulation on. New worker updates will stay on this phone.");
    }
  });
  $("#menuButton").addEventListener("click", () => showView(currentView === "office" ? "worker" : "office"));
  window.addEventListener("online", async () => {
    setNetworkState();
    if (!forcedOffline) {
      await syncOutbox();
      await refreshFromServer();
    }
  });
  window.addEventListener("offline", async () => {
    setNetworkState(false);
    await renderAll();
    showToast("Connection lost. Your cached jobs are still available.");
  });

  try {
    const cached = await getAll("jobs");
    workers = [
      { id: "worker-musa", name: "Musa K.", role: "worker" },
      { id: "worker-asha", name: "Asha M.", role: "worker" }
    ];
    populateWorkerOptions();
    await renderAll();
    if (navigator.onLine) {
      await fetchBootstrap();
      await syncOutbox();
      await renderAll();
      setNetworkState(true);
    } else if (!cached.length) {
      $("#officeJobs").innerHTML = '<div class="empty-state">Connect once to load the assigned demo job. It will then stay available offline.</div>';
      $("#workerJobs").innerHTML = '<div class="empty-state">Connect once to load this worker\'s assigned jobs.</div>';
      setNetworkState(false);
    }
  } catch (error) {
    console.error("KaziProof could not initialize local storage", error);
    showToast("This browser could not open local storage. Try a current version of Chrome.");
  }
  showView(currentView);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(error => console.warn("Offline app-shell cache is unavailable", error));
  }
}

start();
