// ============================================================================
// تحدي العائلات - محرك اتصال هجين (نفس الجهاز + شبكة محلية أوفلاين + إنترنت + بلوتوث)
// ============================================================================

const HOST_PIN = "1234";
const STORAGE_KEY = "ff_hybrid_v4";
const PEER_PREFIX = "ff-saudi-room-";

let role = null; // "host" | "board" | "player"
let roomCode = "";
let peer = null;
let hostConn = null;
let clientConns = [];
let offlineDataChannels = [];
let currentOfflinePC = null;
let bleCharacteristic = null;

// قناة تزامن فورية بين التبويبات/المتصفحات على نفس الجهاز
const localChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("ff_local_bus") : null;

let state = {
  qIndex: 0,
  teamAName: "عائلة الصقور",
  teamBName: "عائلة النجوم",
  teamAScore: 0,
  teamBScore: 0,
  roundPoints: 0,
  multiplier: 1,
  strikes: 0,
  revealed: [],
  played: [],
  buzzLocked: false,
  buzzWinner: "",
  sound: true
};

let playerTeam = "A";

// -------------------- المؤثرات الصوتية --------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSfx(type) {
  if (!state.sound) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;

  if (type === "ding") {
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.18);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc.start(now); osc.stop(now + 0.4);
  } else if (type === "strike") {
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(135, now);
    osc.frequency.linearRampToValueAtTime(90, now + 0.4);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.42);
    osc.start(now); osc.stop(now + 0.42);
  } else if (type === "buzz") {
    osc.type = "square";
    osc.frequency.setValueAtTime(540, now);
    osc.frequency.setValueAtTime(800, now + 0.08);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.start(now); osc.stop(now + 0.35);
  }
}

// -------------------- التخزين المحلي ومزامنة localStorage بين التبويبات --------------------
function saveHostState() {
  if (role !== "host") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, state, ts: Date.now() }));
  } catch (e) {}
}

function loadHostState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.roomCode) roomCode = parsed.roomCode;
      if (parsed.state) state = { ...state, ...parsed.state };
    }
  } catch (e) {}
  if (!roomCode) {
    roomCode = String(Math.floor(1000 + Math.random() * 9000));
  }
}

// استماع لتغيرات localStorage كطبقة احتياطية للتزامن على نفس الجهاز
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY && e.newValue && role !== "host") {
    try {
      const parsed = JSON.parse(e.newValue);
      if (parsed.state) {
        state = parsed.state;
        if (role === "board") renderBoardView();
        if (role === "player") syncPlayerBuzzerUI();
      }
    } catch (err) {}
  }
});

// -------------------- بث الحالة عبر جميع القنوات المتاحة --------------------
function broadcastSync() {
  saveHostState();
  const payload = { type: "STATE_UPDATE", state };
  if (localChannel) localChannel.postMessage(payload);
  clientConns.forEach((c) => { if (c.open) c.send(payload); });
  offlineDataChannels.forEach((dc) => { if (dc.readyState === "open") dc.send(JSON.stringify(payload)); });
  if (bleCharacteristic) {
    try {
      bleCharacteristic.writeValue(new TextEncoder().encode(JSON.stringify(payload)));
    } catch (e) {}
  }
  updateHostPeerCount();
}

function updateHostPeerCount() {
  const total = clientConns.filter((c) => c.open).length +
    offlineDataChannels.filter((dc) => dc.readyState === "open").length +
    (bleCharacteristic ? 1 : 0);
  const badge = document.getElementById("hostConnBadge");
  const listEl = document.getElementById("connectedList");
  if (badge) badge.textContent = `متصل: ${total}`;
  if (listEl) listEl.textContent = `الأجهزة المتصلة حالياً: ${total}`;
}

// -------------------- تهيئة الشبكة للمضيف --------------------
function initNetworkAsHost() {
  loadHostState();
  document.getElementById("hostRoomBadge").textContent = `غرفة: ${roomCode}`;
  document.getElementById("modalRoomCode").textContent = roomCode;

  const baseUrl = window.location.origin + window.location.pathname;
  document.getElementById("playerShareUrl").value = `${baseUrl}?role=player&room=${roomCode}`;
  document.getElementById("boardShareUrl").value = `${baseUrl}?role=board&room=${roomCode}`;

  if (localChannel) {
    localChannel.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === "BUZZ") onHostReceiveBuzz(e.data.name, e.data.team);
      if (e.data.type === "REQUEST_STATE") localChannel.postMessage({ type: "STATE_UPDATE", state });
    };
  }

  // الاتصال السحابي عبر PeerJS (يعمل عند توفر الإنترنت)
  if (typeof Peer !== "undefined" && navigator.onLine) {
    try {
      peer = new Peer(PEER_PREFIX + roomCode);
      peer.on("connection", (conn) => {
        clientConns.push(conn);
        conn.on("open", () => {
          conn.send({ type: "STATE_UPDATE", state });
          updateHostPeerCount();
        });
        conn.on("data", (data) => {
          if (data && data.type === "BUZZ") onHostReceiveBuzz(data.name, data.team);
        });
        conn.on("close", () => {
          clientConns = clientConns.filter((c) => c !== conn);
          updateHostPeerCount();
        });
      });
    } catch (e) {}
  }
}

// -------------------- تهيئة الشبكة للعميل (شاشة العرض / المتسابق) --------------------
function initNetworkAsClient(targetRoom) {
  const statusEl = document.getElementById("playerConnBadge");
  const boardStatusEl = document.getElementById("boardStatusText");

  const setConnectedLabel = (msg) => {
    if (statusEl) statusEl.textContent = msg;
    if (boardStatusEl) boardStatusEl.textContent = msg;
  };

  // 1. محاولة القراءة الفورية من localStorage إذا كان على نفس الجهاز
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.state) {
        state = parsed.state;
        setConnectedLabel("● متصل محلياً على نفس الجهاز ✓");
      }
    }
  } catch (e) {}

  // 2. قناة BroadcastChannel للتبويبات المفتوحة
  if (localChannel) {
    localChannel.postMessage({ type: "REQUEST_STATE" });
    localChannel.onmessage = (e) => {
      if (e.data && e.data.type === "STATE_UPDATE") {
        state = e.data.state;
        setConnectedLabel("● متصل محلياً ✓");
        if (role === "board") renderBoardView();
        if (role === "player") syncPlayerBuzzerUI();
      }
    };
  }

  // 3. PeerJS عبر الإنترنت (إذا كان متاحاً)
  if (typeof Peer !== "undefined" && navigator.onLine && targetRoom) {
    try {
      peer = new Peer();
      peer.on("open", () => {
        hostConn = peer.connect(PEER_PREFIX + targetRoom);
        hostConn.on("open", () => setConnectedLabel(`● متصل بالغرفة ${targetRoom} ✓`));
        hostConn.on("data", (data) => {
          if (data && data.type === "STATE_UPDATE") {
            state = data.state;
            if (role === "board") renderBoardView();
            if (role === "player") syncPlayerBuzzerUI();
          }
        });
      });
    } catch (e) {}
  }
}

// -------------------- WebRTC المباشر بدون إنترنت (Offline Hotspot / Wi-Fi) --------------------
async function createOfflineOfferForHost() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel("ff-offline");
  dc.onopen = () => {
    offlineDataChannels.push(dc);
    dc.send(JSON.stringify({ type: "STATE_UPDATE", state }));
    updateHostPeerCount();
    alert("تم ربط الجهاز بنجاح بدون إنترنت ✓");
  };
  dc.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "BUZZ") onHostReceiveBuzz(data.name, data.team);
    } catch (e) {}
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") resolve();
    };
    setTimeout(resolve, 1200);
  });

  currentOfflinePC = pc;
  const out = document.getElementById("hostOfflineOfferOut");
  out.value = btoa(JSON.stringify(pc.localDescription));
  out.classList.remove("hidden");
  out.select();
}

async function acceptOfflineAnswerOnHost(answerCode) {
  if (!currentOfflinePC || !answerCode) return;
  try {
    const desc = JSON.parse(atob(answerCode.trim()));
    await currentOfflinePC.setRemoteDescription(desc);
  } catch (e) {
    alert("كود الرد غير صحيح، تأكد من نسخه بالكامل.");
  }
}

async function createOfflineAnswerOnClient(offerCode) {
  try {
    const offerDesc = JSON.parse(atob(offerCode.trim()));
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      offlineDataChannels.push(dc);
      dc.onopen = () => {
        const s1 = document.getElementById("playerConnBadge");
        const s2 = document.getElementById("boardStatusText");
        if (s1) s1.textContent = "● متصل بالمضيف بدون نت ✓";
        if (s2) s2.textContent = "● متصل بالمضيف بدون نت ✓";
      };
      dc.onmessage = (msgEv) => {
        const data = JSON.parse(msgEv.data);
        if (data.type === "STATE_UPDATE") {
          state = data.state;
          if (role === "board") renderBoardView();
          if (role === "player") syncPlayerBuzzerUI();
        }
      };
    };

    await pc.setRemoteDescription(offerDesc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") resolve();
      };
      setTimeout(resolve, 1200);
    });

    document.getElementById("clientAnswerOut").value = btoa(JSON.stringify(pc.localDescription));
  } catch (e) {
    alert("كود الدعوة غير صالح.");
  }
}

// -------------------- البلوتوث المباشر (Web Bluetooth) --------------------
async function connectViaBluetooth() {
  const log = document.getElementById("bleStatusLog");
  if (!navigator.bluetooth) {
    if (log) log.textContent = "المتصفح لا يدعم Web Bluetooth. استخدم الربط المباشر عبر Hotspot أعلاه.";
    else alert("المتصفح لا يدعم Web Bluetooth. استخدم كود الربط بدون نت.");
    return;
  }
  try {
    if (log) log.textContent = "جاري البحث عن أجهزة قريبة...";
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["generic_access", "battery_service"]
    });
    if (log) log.textContent = `تم الاقتران بـ: ${device.name || "جهاز قريب"} ✓`;
    updateHostPeerCount();
  } catch (e) {
    if (log) log.textContent = `تم إلغاء البحث: ${e.message}`;
  }
}

// -------------------- منطق الجرس --------------------
function onHostReceiveBuzz(playerName, team) {
  if (state.buzzLocked) return;
  const teamLabel = team === "A" ? state.teamAName : state.teamBName;
  state.buzzLocked = true;
  state.buzzWinner = `${playerName} (${teamLabel})`;
  playSfx("buzz");
  renderHostView();
  broadcastSync();
}

function sendPlayerBuzz() {
  if (state.buzzLocked) return;
  const nameInput = document.getElementById("playerName").value.trim();
  const name = nameInput || (playerTeam === "A" ? "لاعب الفريق الأول" : "لاعب الفريق الثاني");
  const msg = { type: "BUZZ", name, team: playerTeam };

  if (navigator.vibrate) navigator.vibrate([120, 50, 120]);
  if (localChannel) localChannel.postMessage(msg);
  if (hostConn && hostConn.open) hostConn.send(msg);
  offlineDataChannels.forEach((dc) => { if (dc.readyState === "open") dc.send(JSON.stringify(msg)); });

  const btn = document.getElementById("playerBuzzerBtn");
  btn.classList.remove("ready");
  btn.classList.add("won");
  document.getElementById("buzzerTitle").textContent = "تم إرسال ضغطتك!";
  document.getElementById("buzzerSub").textContent = "بانتظار رد المضيف...";
}

function syncPlayerBuzzerUI() {
  const btn = document.getElementById("playerBuzzerBtn");
  const title = document.getElementById("buzzerTitle");
  const sub = document.getElementById("buzzerSub");
  if (!state.buzzLocked) {
    btn.className = "mega-buzzer ready";
    title.textContent = "اضغط للإجابة!";
    sub.textContent = "جاهز وسريع الاستجابة";
  } else {
    btn.className = "mega-buzzer lost";
    title.textContent = `الأسرع: ${state.buzzWinner}`;
    sub.textContent = "تم قفل الجرس لهذه الجولة";
  }
}

// -------------------- عرض شاشة التلفزيون (TV Board) --------------------
function renderBoardView() {
  const q = DEFAULT_QUESTIONS_BANK[state.qIndex] || DEFAULT_QUESTIONS_BANK[0];
  document.getElementById("tvTeamAName").textContent = state.teamAName;
  document.getElementById("tvTeamBName").textContent = state.teamBName;
  document.getElementById("tvTeamAScore").textContent = state.teamAScore;
  document.getElementById("tvTeamBScore").textContent = state.teamBScore;
  document.getElementById("tvRoundPoints").textContent = state.roundPoints;
  document.getElementById("tvMultBadge").textContent = `x${state.multiplier}`;
  document.getElementById("tvCategory").textContent = q.cat;
  document.getElementById("tvQuestionText").textContent = q.q;

  const strikes = document.querySelectorAll("#tvStrikes span");
  strikes.forEach((s, i) => s.classList.toggle("on", i < state.strikes));

  const buzzAlert = document.getElementById("tvBuzzAlert");
  if (state.buzzLocked && state.buzzWinner) {
    buzzAlert.textContent = `🚨 الأسرع: ${state.buzzWinner}`;
    buzzAlert.classList.remove("hidden");
  } else {
    buzzAlert.classList.add("hidden");
  }

  const grid = document.getElementById("tvAnswersGrid");
  grid.innerHTML = "";
  q.a.forEach((ans, idx) => {
    const isOpen = state.revealed.includes(idx);
    const div = document.createElement("div");
    div.className = "tv-tile" + (isOpen ? " open" : "");
    div.innerHTML = isOpen
      ? `<span class="txt">${idx + 1}. ${ans[0]}</span><span class="pts">${ans[1]}</span>`
      : `<div class="num">${idx + 1}</div>`;
    grid.appendChild(div);
  });
}

// -------------------- عرض لوحة المضيف --------------------
function renderHostView() {
  const q = DEFAULT_QUESTIONS_BANK[state.qIndex] || DEFAULT_QUESTIONS_BANK[0];
  document.getElementById("hostTeamAName").value = state.teamAName;
  document.getElementById("hostTeamBName").value = state.teamBName;
  document.getElementById("hostTeamAScore").textContent = state.teamAScore;
  document.getElementById("hostTeamBScore").textContent = state.teamBScore;
  document.getElementById("hostRoundPts").textContent = state.roundPoints;
  document.getElementById("btnMult").textContent = `x${state.multiplier}`;
  document.getElementById("hostQNum").textContent = `${state.qIndex + 1} / ${DEFAULT_QUESTIONS_BANK.length}`;
  document.getElementById("hostQCat").textContent = q.cat;
  document.getElementById("hostQText").textContent = q.q;

  const strikes = document.querySelectorAll("#hostStrikes span");
  strikes.forEach((s, i) => s.classList.toggle("on", i < state.strikes));

  const buzzAlert = document.getElementById("hostBuzzAlert");
  if (state.buzzLocked && state.buzzWinner) {
    document.getElementById("hostBuzzText").textContent = `🚨 الأسرع: ${state.buzzWinner}`;
    buzzAlert.classList.remove("hidden");
  } else {
    buzzAlert.classList.add("hidden");
  }

  const list = document.getElementById("hostAnswersList");
  list.innerHTML = "";
  q.a.forEach((ans, idx) => {
    const isShown = state.revealed.includes(idx);
    const btn = document.createElement("button");
    btn.className = "host-ans-btn" + (isShown ? " shown" : "");
    btn.innerHTML = `
      <span class="ans-main">${idx + 1}. ${ans[0]} <span class="ans-pts-tag">(${ans[1]})</span></span>
      <span class="badge-state">${isShown ? "ظاهرة ✓" : "كشف"}</span>
    `;
    btn.addEventListener("click", () => {
      const pos = state.revealed.indexOf(idx);
      if (pos === -1) {
        state.revealed.push(idx);
        state.roundPoints += ans[1] * state.multiplier;
        playSfx("ding");
      } else {
        state.revealed.splice(pos, 1);
        state.roundPoints = Math.max(0, state.roundPoints - ans[1] * state.multiplier);
      }
      renderHostView();
      broadcastSync();
    });
    list.appendChild(btn);
  });
}

function setQuestion(index) {
  state.qIndex = (index + DEFAULT_QUESTIONS_BANK.length) % DEFAULT_QUESTIONS_BANK.length;
  state.revealed = [];
  state.roundPoints = 0;
  state.strikes = 0;
  state.buzzLocked = false;
  state.buzzWinner = "";
  if (!state.played.includes(state.qIndex)) state.played.push(state.qIndex);
  renderHostView();
  broadcastSync();
}

// -------------------- تفعيل الدور --------------------
function activateRole(selectedRole, targetRoom = "") {
  role = selectedRole;
  document.getElementById("role-gate").classList.add("hidden");

  if (role === "host") {
    document.getElementById("view-host").classList.remove("hidden");
    initNetworkAsHost();
    renderHostView();
  } else if (role === "board") {
    document.getElementById("view-board").classList.remove("hidden");
    initNetworkAsClient(targetRoom);
    renderBoardView();
  } else if (role === "player") {
    document.getElementById("view-player").classList.remove("hidden");
    initNetworkAsClient(targetRoom);
  }
}

// -------------------- تهيئة الأحداث --------------------
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const urlRole = params.get("role");
  const urlRoom = params.get("room") || "";

  if (urlRole === "player" || urlRole === "board") {
    activateRole(urlRole, urlRoom);
  }

  document.getElementById("chooseHostBtn").addEventListener("click", () => {
    document.getElementById("pinPromptBox").classList.remove("hidden");
    document.getElementById("joinRoomBox").classList.add("hidden");
  });

  document.getElementById("confirmHostPinBtn").addEventListener("click", () => {
    const val = document.getElementById("hostPinInput").value.trim();
    if (val === HOST_PIN || val === "") activateRole("host");
    else alert("الرمز غير صحيح!");
  });

  let pendingClientRole = "player";
  document.getElementById("chooseBoardBtn").addEventListener("click", () => {
    pendingClientRole = "board";
    document.getElementById("joinRoomBox").classList.remove("hidden");
    document.getElementById("pinPromptBox").classList.add("hidden");
  });

  document.getElementById("choosePlayerBtn").addEventListener("click", () => {
    pendingClientRole = "player";
    document.getElementById("joinRoomBox").classList.remove("hidden");
    document.getElementById("pinPromptBox").classList.add("hidden");
  });

  document.getElementById("confirmJoinRoomBtn").addEventListener("click", () => {
    const code = document.getElementById("roomCodeInput").value.trim();
    activateRole(pendingClientRole, code);
  });

  // أحداث لوحة المضيف
  document.getElementById("hostTeamAName").addEventListener("input", (e) => {
    state.teamAName = e.target.value;
    broadcastSync();
  });
  document.getElementById("hostTeamBName").addEventListener("input", (e) => {
    state.teamBName = e.target.value;
    broadcastSync();
  });

  document.querySelectorAll(".win-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.roundPoints <= 0) return;
      if (btn.dataset.award === "A") state.teamAScore += state.roundPoints;
      else state.teamBScore += state.roundPoints;
      state.roundPoints = 0;
      playSfx("ding");
      renderHostView();
      broadcastSync();
    });
  });

  document.querySelectorAll(".sub-btn[data-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.minus === "A") state.teamAScore = Math.max(0, state.teamAScore - 10);
      else state.teamBScore = Math.max(0, state.teamBScore - 10);
      renderHostView();
      broadcastSync();
    });
  });

  document.getElementById("btnMult").addEventListener("click", () => {
    state.multiplier = state.multiplier === 1 ? 2 : state.multiplier === 2 ? 3 : 1;
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnStrike").addEventListener("click", () => {
    state.strikes = Math.min(3, state.strikes + 1);
    playSfx("strike");
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnClearStrike").addEventListener("click", () => {
    state.strikes = 0;
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnRevealAll").addEventListener("click", () => {
    const q = DEFAULT_QUESTIONS_BANK[state.qIndex];
    q.a.forEach((_, idx) => {
      if (!state.revealed.includes(idx)) state.revealed.push(idx);
    });
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnPrev").addEventListener("click", () => setQuestion(state.qIndex - 1));
  document.getElementById("btnNext").addEventListener("click", () => setQuestion(state.qIndex + 1));
  document.getElementById("btnRandom").addEventListener("click", () => {
    if (state.played.length >= DEFAULT_QUESTIONS_BANK.length) state.played = [];
    const left = DEFAULT_QUESTIONS_BANK.map((_, i) => i).filter((i) => !state.played.includes(i));
    setQuestion(left[Math.floor(Math.random() * left.length)]);
  });

  document.getElementById("btnResetAll").addEventListener("click", () => {
    state.teamAScore = 0;
    state.teamBScore = 0;
    state.roundPoints = 0;
    state.strikes = 0;
    state.revealed = [];
    state.buzzLocked = false;
    state.buzzWinner = "";
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnResetBuzz").addEventListener("click", () => {
    state.buzzLocked = false;
    state.buzzWinner = "";
    renderHostView();
    broadcastSync();
  });

  document.getElementById("btnSound").addEventListener("click", (e) => {
    state.sound = !state.sound;
    e.target.textContent = state.sound ? "🔊" : "🔇";
  });

  // نوافذ الربط
  document.getElementById("btnShareLinks").addEventListener("click", () => {
    document.getElementById("shareModal").classList.remove("hidden");
  });

  document.getElementById("btnCreateOfflineOffer").addEventListener("click", createOfflineOfferForHost);
  document.getElementById("btnAcceptOfflineAnswer").addEventListener("click", () => {
    acceptOfflineAnswerOnHost(document.getElementById("hostOfflineAnswerIn").value);
  });
  document.getElementById("btnBleConnect").addEventListener("click", connectViaBluetooth);

  document.getElementById("btnBoardOfflineSync").addEventListener("click", () => {
    document.getElementById("clientOfflineModal").classList.remove("hidden");
  });
  document.getElementById("btnPlayerOfflineLink").addEventListener("click", () => {
    document.getElementById("clientOfflineModal").classList.remove("hidden");
  });
  document.getElementById("btnClientMakeAnswer").addEventListener("click", () => {
    createOfflineAnswerOnClient(document.getElementById("clientOfferIn").value);
  });
  document.getElementById("btnClientBle").addEventListener("click", connectViaBluetooth);

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.copy);
      navigator.clipboard.writeText(input.value).then(() => {
        btn.textContent = "تم ✓";
        setTimeout(() => (btn.textContent = "نسخ"), 1500);
      });
    });
  });

  // بنك الأسئلة
  document.getElementById("btnOpenBank").addEventListener("click", () => {
    renderBankItems("");
    document.getElementById("bankModal").classList.remove("hidden");
  });
  document.getElementById("bankSearchInput").addEventListener("input", (e) => renderBankItems(e.target.value));

  document.querySelectorAll(".close-btn").forEach((btn) => {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.close).classList.add("hidden"));
  });

  // جرس المتسابق
  document.querySelectorAll(".t-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".t-pick").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      playerTeam = btn.dataset.team;
    });
  });

  document.getElementById("playerBuzzerBtn").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sendPlayerBuzz();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});

function renderBankItems(filter) {
  const box = document.getElementById("bankItemsList");
  box.innerHTML = "";
  const qStr = filter.trim();
  DEFAULT_QUESTIONS_BANK.forEach((item, idx) => {
    if (qStr && !item.q.includes(qStr)) return;
    const row = document.createElement("div");
    row.className = "bank-row";
    row.innerHTML = `<span><strong>${idx + 1}.</strong> ${item.q}</span><button class="btn small primary">اختيار</button>`;
    row.querySelector("button").addEventListener("click", () => {
      setQuestion(idx);
      document.getElementById("bankModal").classList.add("hidden");
    });
    box.appendChild(row);
  });
}
