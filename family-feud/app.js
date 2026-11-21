// ============================================================================
// منطق لعبة تحدي العائلات (Family Feud) - يعمل بدون إنترنت + تعدد الأجهزة
// ============================================================================

const STORAGE_KEY = "ff_arabic_state_v2";
const CHANNEL_NAME = "ff_arabic_live_channel";

let questionsBank = [];
let state = {
  currentIndex: 0,
  teamAName: "عائلة الصقور",
  teamBName: "عائلة النجوم",
  teamAScore: 0,
  teamBScore: 0,
  roundPoints: 0,
  multiplier: 1,
  strikes: 0,
  revealed: [],
  peekMode: false,
  soundEnabled: true,
  playedIndices: [],
  buzzLocked: false,
  buzzWinner: null,
  playerTeam: "A"
};

// قناة تزامن محلية فورية بين التبويبات/الأجهزة على نفس الشبكة المحلية
const channel = ("BroadcastChannel" in window) ? new BroadcastChannel(CHANNEL_NAME) : null;
let bleCharacteristic = null;
let connectedPeers = 0;

// -------------------- نظام الصوت (Web Audio API بدون ملفات خارجية) --------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(type) {
  if (!state.soundEnabled) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;

  if (type === "ding") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.18);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
    osc.start(now);
    osc.stop(now + 0.45);
  } else if (type === "strike") {
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(130, now);
    osc.frequency.linearRampToValueAtTime(95, now + 0.4);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
    osc.start(now);
    osc.stop(now + 0.45);
  } else if (type === "buzz") {
    osc.type = "square";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.setValueAtTime(780, now + 0.08);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  } else if (type === "win") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.12);
    osc.frequency.setValueAtTime(783.99, now + 0.24);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
    osc.start(now);
    osc.stop(now + 0.6);
  }
}

// -------------------- التخزين المحلي التلقائي --------------------
function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.questionsBank) && parsed.questionsBank.length > 0) {
        questionsBank = parsed.questionsBank;
      } else {
        questionsBank = [...DEFAULT_QUESTIONS_BANK];
      }
      if (parsed.state) {
        state = { ...state, ...parsed.state };
      }
    } else {
      questionsBank = [...DEFAULT_QUESTIONS_BANK];
    }
  } catch (e) {
    questionsBank = [...DEFAULT_QUESTIONS_BANK];
  }
  if (state.currentIndex >= questionsBank.length) state.currentIndex = 0;
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ questionsBank, state }));
    const badge = document.getElementById("saveStatus");
    if (badge) badge.textContent = "● محفوظ محلياً ✓";
  } catch (e) {
    console.warn("تعذر الحفظ المحلي:", e);
  }
}

// -------------------- تزامن الأجهزة (BroadcastChannel + Bluetooth) --------------------
function broadcastMessage(payload) {
  if (channel) channel.postMessage(payload);
  if (bleCharacteristic) {
    try {
      const encoder = new TextEncoder();
      bleCharacteristic.writeValue(encoder.encode(JSON.stringify(payload)));
    } catch (e) {
      console.warn("BLE write error", e);
    }
  }
}

if (channel) {
  channel.onmessage = (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === "PING") {
      channel.postMessage({ type: "PONG" });
    } else if (data.type === "PONG") {
      connectedPeers++;
      updatePeerUI();
    } else if (data.type === "BUZZ") {
      handleIncomingBuzz(data.player, data.team, data.ts);
    } else if (data.type === "RESET_BUZZ") {
      resetBuzzLocal();
    } else if (data.type === "SYNC_STATE") {
      state = { ...state, ...data.state };
      renderAll();
    }
  };
}

function updatePeerUI() {
  const peerCountEl = document.getElementById("peerCount");
  const peerLogEl = document.getElementById("peerLog");
  const connBadge = document.getElementById("connStatus");
  if (peerCountEl) peerCountEl.textContent = connectedPeers;
  if (peerLogEl) peerLogEl.textContent = `الأجهزة المتصلة حالياً: ${connectedPeers}`;
  if (connBadge) {
    connBadge.textContent = connectedPeers > 0 ? `متصل (${connectedPeers})` : "جاهز للربط";
  }
}

// -------------------- منطق الجرس فائق السرعة --------------------
function triggerBuzzer(customName = null, customTeam = null) {
  if (state.buzzLocked) return;
  const playerInput = document.getElementById("playerNameInput");
  const player = customName || (playerInput && playerInput.value.trim()) ||
    (state.playerTeam === "A" ? state.teamAName : state.teamBName);
  const team = customTeam || state.playerTeam;
  const ts = performance.now();

  handleIncomingBuzz(player, team, ts);
  broadcastMessage({ type: "BUZZ", player, team, ts });
}

function handleIncomingBuzz(player, team, ts) {
  if (state.buzzLocked) return;
  state.buzzLocked = true;
  state.buzzWinner = { player, team, ts };

  if (navigator.vibrate) navigator.vibrate([120, 50, 120]);
  playTone("buzz");

  const banner = document.getElementById("buzzBanner");
  const winnerText = document.getElementById("buzzWinnerText");
  const teamLabel = team === "A" ? state.teamAName : state.teamBName;
  if (banner && winnerText) {
    winnerText.textContent = `🚨 الأسرع: ${player} (${teamLabel})`;
    banner.classList.remove("hidden");
  }

  const bigBtn = document.getElementById("bigBuzzerBtn");
  const mainLbl = document.getElementById("buzzerMainLabel");
  const subLbl = document.getElementById("buzzerSubLabel");
  if (bigBtn && mainLbl && subLbl) {
    bigBtn.classList.remove("ready");
    bigBtn.classList.add("won");
    mainLbl.textContent = `ضغط أولاً: ${player}`;
    subLbl.textContent = "بانتظار المضيف لتصفير الجرس";
  }
}

function resetBuzzLocal() {
  state.buzzLocked = false;
  state.buzzWinner = null;
  const banner = document.getElementById("buzzBanner");
  if (banner) banner.classList.add("hidden");

  const bigBtn = document.getElementById("bigBuzzerBtn");
  const mainLbl = document.getElementById("buzzerMainLabel");
  const subLbl = document.getElementById("buzzerSubLabel");
  if (bigBtn && mainLbl && subLbl) {
    bigBtn.classList.remove("won", "locked");
    bigBtn.classList.add("ready");
    mainLbl.textContent = "اضغط للإجابة!";
    subLbl.textContent = "جاهز وسريع الاستجابة";
  }
}

// -------------------- عرض اللوحة وتحديث الواجهة --------------------
function getCurrentQuestion() {
  return questionsBank[state.currentIndex] || questionsBank[0];
}

function renderAll() {
  const q = getCurrentQuestion();
  document.getElementById("bankCount").textContent = questionsBank.length;
  document.getElementById("teamAName").value = state.teamAName;
  document.getElementById("teamBName").value = state.teamBName;
  document.getElementById("teamAScore").textContent = state.teamAScore;
  document.getElementById("teamBScore").textContent = state.teamBScore;
  document.getElementById("roundPoints").textContent = state.roundPoints;
  document.getElementById("btnMultiplier").textContent = `x${state.multiplier}`;

  // الأخطاء X
  const strikeBoxes = document.querySelectorAll("#strikesDisplay .strike-box");
  strikeBoxes.forEach((box, idx) => {
    box.classList.toggle("on", idx < state.strikes);
  });

  // السؤال
  document.getElementById("questionCounter").textContent = `سؤال ${state.currentIndex + 1} من ${questionsBank.length}`;
  document.getElementById("questionCategory").textContent = q.cat || "عام";
  document.getElementById("questionText").textContent = q.q;
  document.getElementById("singleQCat").textContent = q.cat || "عام";
  document.getElementById("singleQText").textContent = q.q;

  renderAnswersGrid("answersGrid", q);
  renderAnswersGrid("singleAnswersGrid", q);
  saveData();
}

function renderAnswersGrid(containerId, q) {
  const grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = "";

  q.a.forEach((item, idx) => {
    const [ansText, pts] = item;
    const isRevealed = state.revealed.includes(idx);
    const tile = document.createElement("div");
    tile.className = "answer-tile" + (isRevealed ? " revealed" : "");

    if (isRevealed) {
      tile.innerHTML = `
        <span class="ans-label">${idx + 1}. ${ansText}</span>
        <span class="ans-pts">${pts}</span>
      `;
    } else {
      tile.innerHTML = `<div class="tile-num">${idx + 1}</div>`;
      if (state.peekMode && containerId === "answersGrid") {
        tile.innerHTML += `<div class="tile-peek"><span>${ansText}</span><span>(${pts})</span></div>`;
      }
    }

    tile.addEventListener("click", () => toggleAnswer(idx, pts));
    grid.appendChild(tile);
  });
}

function toggleAnswer(idx, pts) {
  const pos = state.revealed.indexOf(idx);
  if (pos === -1) {
    state.revealed.push(idx);
    state.roundPoints += pts * state.multiplier;
    playTone("ding");
  } else {
    state.revealed.splice(pos, 1);
    state.roundPoints = Math.max(0, state.roundPoints - pts * state.multiplier);
  }
  renderAll();
  broadcastMessage({ type: "SYNC_STATE", state });
}

function loadQuestion(index) {
  state.currentIndex = (index + questionsBank.length) % questionsBank.length;
  state.revealed = [];
  state.roundPoints = 0;
  state.strikes = 0;
  if (!state.playedIndices.includes(state.currentIndex)) {
    state.playedIndices.push(state.currentIndex);
  }
  resetBuzzLocal();
  broadcastMessage({ type: "RESET_BUZZ" });
  renderAll();
}

function pickRandomQuestion() {
  if (state.playedIndices.length >= questionsBank.length) {
    state.playedIndices = [];
  }
  const unplayed = questionsBank
    .map((_, i) => i)
    .filter((i) => !state.playedIndices.includes(i));
  const rand = unplayed[Math.floor(Math.random() * unplayed.length)];
  loadQuestion(rand);
}

// -------------------- ربط البلوتوث المباشر (Web Bluetooth) --------------------
async function scanBluetooth() {
  const bleLog = document.getElementById("bleLog");
  if (!navigator.bluetooth) {
    bleLog.textContent = "المتصفح الحالي لا يدعم Web Bluetooth. استخدم كروم على أندرويد/كمبيوتر أو الربط المحلي عبر الشبكة.";
    return;
  }
  try {
    bleLog.textContent = "جاري البحث عن أجهزة بلوتوث قريبة...";
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["battery_service", "generic_access"]
    });
    bleLog.textContent = `تم الاقتران بـ: ${device.name || "جهاز غير مسمى"} ✓`;
    connectedPeers++;
    updatePeerUI();
  } catch (err) {
    bleLog.textContent = `تم إلغاء البحث: ${err.message}`;
  }
}

// -------------------- إدارة بنك الأسئلة --------------------
function renderBankList(filter = "") {
  const list = document.getElementById("bankList");
  if (!list) return;
  list.innerHTML = "";
  const query = filter.trim();

  questionsBank.forEach((item, idx) => {
    if (query && !item.q.includes(query) && !(item.cat && item.cat.includes(query))) return;
    const row = document.createElement("div");
    row.className = "bank-item";
    row.innerHTML = `
      <span><strong>${idx + 1}.</strong> [${item.cat || "عام"}] ${item.q}</span>
      <button class="btn-small" data-play-idx="${idx}">عرض</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      loadQuestion(idx);
      document.getElementById("bankModal").classList.add("hidden");
    });
    list.appendChild(row);
  });
}

// -------------------- تهيئة الأحداث عند تحميل الصفحة --------------------
document.addEventListener("DOMContentLoaded", () => {
  loadData();
  renderAll();
  if (channel) channel.postMessage({ type: "PING" });

  // التبديل بين الشاشات
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${btn.dataset.mode}`).classList.add("active");
    });
  });

  // أسماء الفرق ومنح النقاط
  document.getElementById("teamAName").addEventListener("input", (e) => {
    state.teamAName = e.target.value;
    saveData();
  });
  document.getElementById("teamBName").addEventListener("input", (e) => {
    state.teamBName = e.target.value;
    saveData();
  });

  document.querySelectorAll(".btn-award").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.roundPoints <= 0) return;
      if (btn.dataset.award === "A") state.teamAScore += state.roundPoints;
      else state.teamBScore += state.roundPoints;
      state.roundPoints = 0;
      playTone("win");
      renderAll();
    });
  });

  document.querySelectorAll(".btn-minus").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.minus === "A") state.teamAScore = Math.max(0, state.teamAScore - 10);
      else state.teamBScore = Math.max(0, state.teamBScore - 10);
      renderAll();
    });
  });

  // المضاعف والأخطاء
  document.getElementById("btnMultiplier").addEventListener("click", () => {
    state.multiplier = state.multiplier === 1 ? 2 : state.multiplier === 2 ? 3 : 1;
    renderAll();
  });

  document.getElementById("btnAddStrike").addEventListener("click", () => {
    state.strikes = Math.min(3, state.strikes + 1);
    playTone("strike");
    renderAll();
  });

  document.getElementById("btnClearStrikes").addEventListener("click", () => {
    state.strikes = 0;
    renderAll();
  });

  // أدوات السؤال والتنقل
  document.getElementById("btnPeekToggle").addEventListener("click", () => {
    state.peekMode = !state.peekMode;
    renderAll();
  });

  document.getElementById("btnRevealAll").addEventListener("click", () => {
    const q = getCurrentQuestion();
    q.a.forEach((_, idx) => {
      if (!state.revealed.includes(idx)) state.revealed.push(idx);
    });
    renderAll();
  });

  document.getElementById("btnPrevQ").addEventListener("click", () => loadQuestion(state.currentIndex - 1));
  document.getElementById("btnNextQ").addEventListener("click", () => loadQuestion(state.currentIndex + 1));
  document.getElementById("btnRandomQ").addEventListener("click", pickRandomQuestion);
  document.getElementById("btnSingleRandom").addEventListener("click", pickRandomQuestion);

  document.getElementById("btnResetGame").addEventListener("click", () => {
    state.teamAScore = 0;
    state.teamBScore = 0;
    state.roundPoints = 0;
    state.strikes = 0;
    state.multiplier = 1;
    state.revealed = [];
    renderAll();
  });

  // الجرس
  const bigBuzzer = document.getElementById("bigBuzzerBtn");
  bigBuzzer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    triggerBuzzer();
  });

  document.getElementById("btnResetBuzz").addEventListener("click", () => {
    resetBuzzLocal();
    broadcastMessage({ type: "RESET_BUZZ" });
  });

  document.querySelectorAll(".pick-team").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pick-team").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.playerTeam = btn.dataset.team;
    });
  });

  document.getElementById("singleBuzzA").addEventListener("pointerdown", () => {
    triggerBuzzer(state.teamAName, "A");
    alert(`🚨 ضغط أولاً: ${state.teamAName}`);
    resetBuzzLocal();
  });

  document.getElementById("singleBuzzB").addEventListener("pointerdown", () => {
    triggerBuzzer(state.teamBName, "B");
    alert(`🚨 ضغط أولاً: ${state.teamBName}`);
    resetBuzzLocal();
  });

  // الصوت والنوافذ المنبثقة
  document.getElementById("btnSoundToggle").addEventListener("click", (e) => {
    state.soundEnabled = !state.soundEnabled;
    e.target.textContent = state.soundEnabled ? "🔊" : "🔇";
    saveData();
  });

  document.getElementById("btnConnectModal").addEventListener("click", () => {
    document.getElementById("connectModal").classList.remove("hidden");
  });

  document.getElementById("btnBankModal").addEventListener("click", () => {
    renderBankList();
    document.getElementById("bankModal").classList.remove("hidden");
  });

  document.querySelectorAll(".close-modal").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.close).classList.add("hidden");
    });
  });

  document.getElementById("btnBleScan").addEventListener("click", scanBluetooth);
  document.getElementById("btnPingPeers").addEventListener("click", () => {
    connectedPeers = 0;
    updatePeerUI();
    if (channel) channel.postMessage({ type: "PING" });
  });

  // إضافة سؤال جديد وحفظه
  document.getElementById("btnSaveNewQ").addEventListener("click", () => {
    const qText = document.getElementById("newQText").value.trim();
    const ansInputs = document.querySelectorAll(".ans-in");
    const ptsInputs = document.querySelectorAll(".pts-in");
    const answers = [];

    ansInputs.forEach((inp, i) => {
      const val = inp.value.trim();
      const pts = parseInt(ptsInputs[i].value, 10) || 10;
      if (val) answers.push([val, pts]);
    });

    if (!qText || answers.length < 2) {
      alert("يرجى كتابة السؤال وإجابتين على الأقل.");
      return;
    }

    questionsBank.unshift({ cat: "مخصص", q: qText, a: answers });
    document.getElementById("newQText").value = "";
    ansInputs.forEach((inp) => (inp.value = ""));
    saveData();
    renderBankList();
    loadQuestion(0);
    alert("تم حفظ السؤال بنجاح!");
  });

  document.getElementById("bankSearch").addEventListener("input", (e) => {
    renderBankList(e.target.value);
  });

  document.getElementById("btnExportJs").addEventListener("click", () => {
    const code = `const DEFAULT_QUESTIONS_BANK = ${JSON.stringify(questionsBank, null, 2)};`;
    navigator.clipboard.writeText(code).then(() => {
      alert("تم نسخ كود questions.js إلى الحافظة!");
    });
  });

  // تسجيل Service Worker للعمل بدون إنترنت بعد أول زيارة
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
