const canvasPathInput = document.querySelector("#canvasPath");
const vaultPathInput = document.querySelector("#vaultPath");
const outputPathInput = document.querySelector("#outputPath");
const embedImagesInput = document.querySelector("#embedImages");
const pickCanvasButton = document.querySelector("#pickCanvas");
const pickVaultButton = document.querySelector("#pickVault");
const pickOutputButton = document.querySelector("#pickOutput");
const convertButton = document.querySelector("#convertButton");
const revealButton = document.querySelector("#revealButton");
const statusPill = document.querySelector("#statusPill");
const nodeCount = document.querySelector("#nodeCount");
const groupCount = document.querySelector("#groupCount");
const edgeCount = document.querySelector("#edgeCount");
const logEl = document.querySelector("#log");
const dropZone = document.querySelector("#dropZone");

let lastOutputPath = "";

function trimPath(value) {
  return String(value || "").trim().replace(/^"|"$/g, "");
}

function setStatus(label, kind = "idle") {
  statusPill.textContent = label;
  statusPill.className = `status-pill ${kind}`;
}

function setLog(lines) {
  logEl.textContent = Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines || "");
}

function resetStats() {
  nodeCount.textContent = "0";
  groupCount.textContent = "0";
  edgeCount.textContent = "0";
}

function syncButtons() {
  const canConvert = Boolean(trimPath(canvasPathInput.value) && trimPath(outputPathInput.value));
  convertButton.disabled = !canConvert;
  revealButton.disabled = !lastOutputPath;
}

async function applyCanvasPath(filePath) {
  if (!filePath) return;
  canvasPathInput.value = filePath;
  const defaults = await window.canvasConverter.guessDefaults(filePath);
  if (defaults) {
    if (!trimPath(vaultPathInput.value)) vaultPathInput.value = defaults.vaultDir;
    outputPathInput.value = defaults.outputPath;
  }
  lastOutputPath = "";
  resetStats();
  setStatus("待转换", "idle");
  setLog(`已选择: ${filePath}`);
  syncButtons();
}

async function pickCanvas() {
  const filePath = await window.canvasConverter.pickCanvas();
  await applyCanvasPath(filePath);
}

async function pickVault() {
  const dirPath = await window.canvasConverter.pickVault();
  if (!dirPath) return;
  vaultPathInput.value = dirPath;
  syncButtons();
}

async function pickOutput() {
  const outputPath = await window.canvasConverter.pickOutput(trimPath(canvasPathInput.value));
  if (!outputPath) return;
  outputPathInput.value = outputPath;
  lastOutputPath = "";
  syncButtons();
}

async function convert() {
  const inputPath = trimPath(canvasPathInput.value);
  const outputPath = trimPath(outputPathInput.value);
  if (!inputPath || !outputPath) return;

  convertButton.disabled = true;
  revealButton.disabled = true;
  setStatus("转换中", "running");
  setLog("正在转换...");

  try {
    const result = await window.canvasConverter.convert({
      inputPath,
      outputPath,
      vaultDir: trimPath(vaultPathInput.value),
      embedImages: embedImagesInput.checked
    });

    lastOutputPath = result.outputPath;
    nodeCount.textContent = String(result.stats.nodes);
    groupCount.textContent = String(result.stats.groups);
    edgeCount.textContent = String(result.stats.edges);
    setStatus("完成", "ok");
    setLog([
      `输入: ${result.inputPath}`,
      `输出: ${result.outputPath}`,
      `Vault: ${result.vaultDir}`,
      "",
      `节点: ${result.stats.nodes}`,
      `分组: ${result.stats.groups}`,
      `连线: ${result.stats.edges}`,
      result.warnings.length ? "\n警告:" : "",
      ...result.warnings.map((warning) => `- ${warning}`)
    ]);
  } catch (error) {
    lastOutputPath = "";
    resetStats();
    setStatus("失败", "error");
    setLog(error?.message || String(error));
  } finally {
    syncButtons();
  }
}

async function revealOutput() {
  if (!lastOutputPath) return;
  await window.canvasConverter.revealOutput(lastOutputPath);
}

function installDragHandlers() {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });

  window.addEventListener("dragleave", (event) => {
    if (event.target === document.body || event.target === dropZone) {
      dropZone.classList.remove("dragging");
    }
  });

  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    const files = [...(event.dataTransfer?.files || [])];
    const canvasFile = files.find((file) => file.name.toLowerCase().endsWith(".canvas"));
    if (!canvasFile) return;
    const filePath = window.canvasConverter.getPathForFile(canvasFile);
    await applyCanvasPath(filePath);
  });
}

function installHandlers() {
  pickCanvasButton.addEventListener("click", pickCanvas);
  pickVaultButton.addEventListener("click", pickVault);
  pickOutputButton.addEventListener("click", pickOutput);
  convertButton.addEventListener("click", convert);
  revealButton.addEventListener("click", revealOutput);

  for (const input of [canvasPathInput, vaultPathInput, outputPathInput]) {
    input.addEventListener("input", () => {
      lastOutputPath = "";
      syncButtons();
    });
  }

  canvasPathInput.addEventListener("change", async () => {
    await applyCanvasPath(trimPath(canvasPathInput.value));
  });

  installDragHandlers();
  syncButtons();
}

installHandlers();
