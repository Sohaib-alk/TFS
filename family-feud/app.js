// ============================================================================
// تحدي العائلات - إصلاح شامل لقراءة صور QR وضغط بيانات الربط بدون إنترنت
// ============================================================================

const HOST_PIN = "1234";
const STORAGE_KEY = "ff_instant_v7";
const FIXED_LOBBY_ID = "ff-saudi-active-lobby-2026";

let role = null; // "host" | "board" | "player"
let peer = null;
let hostConn = null;
let clientConns = [];
let offlineDataChannels = [];
let currentOfflinePC = null;
let activeScanner = null;

const localChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("ff_instant_bus") : null;

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

// -------------------- تحميل محرك قراءة الصور jsQR تلقائياً --------------------
(function loadJsQrFallback() {
  if (typeof window.jsQR === "undefined") {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
    s.defer = true;
    document.head.appendChild(s);
  }
})();

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

// -------------------- ضغط بيانات WebRTC SDP لتصغير كثافة الباركود --------------------
function packSdp(typeChar, sdp) {
  const lines = sdp.split(/\r?\n/);
  const ufrag = (lines.find(l => l.startsWith("a=ice-ufrag:")) || "").split(":")[1] || "";
  const pwd = (lines.find(l => l.startsWith("a=ice-pwd:")) || "").split(":")[1] || "";
  const fp = (lines.find(l => l.startsWith("a=fingerprint:")) || "").replace("a=fingerprint:", "");
  const cands = lines
    .filter(l => l.startsWith("a=candidate:") && l.includes("typ host"))
    .slice(0, 2)
    .map(l => l.replace("a=candidate:", ""));
  return JSON.stringify({ t: typeChar, u: ufrag, p: pwd, f: fp, c: cands });
}

function unpackSdp(obj) {
  const sdpLines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${obj.u}`,
    `a=ice-pwd:${obj.p}`,
    `a=fingerprint:${obj.f}`,
    `a=setup:${obj.t === "o" ? "actpass" : "active"}`,
    "a=mid:0",
    "a=sctp-port:5000",
    ...(obj.c || []).map(c => `a=candidate:${c}`),
    "a=end-of-candidates"
  ];
  return sdpLines.join("\r\n") + "\r\n";
}

// -------------------- التخزين المحلي ومزامنة التبويبات --------------------
function saveHostState() {
  if (role !== "host") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: true, state, ts: Date.now() }));
  } catch (e) {}
}

function loadHostState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.state) state = { ...state, ...parsed.state };
    }
  } catch (e) {}
}

window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY && e.newValue && role && role !== "host") {
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

// -------------------- اكتشاف الجلسة النشطة تلقائياً --------------------
function startAutoDiscovery() {
  const showBanner = (teamA, teamB) => {
    const card = document.getElementById("liveSessionCard");
    const sub = document.getElementById("liveSessionSub");
    if (card && sub) {
      sub.textContent = `جلسة (${teamA} ضد ${teamB}) نشطة الآن — انضم بنقرة واحدة`;
      card.classList.remove("hidden");
    }
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.state && (Date.now() - (parsed.ts || 0) < 3600000)) {
        state = parsed.state;
        showBanner(state.teamAName, state.teamBName);
      }
    }
  } catch (e) {}

  if (localChannel) {
    localChannel.postMessage({ type: "DISCOVER" });
    localChannel.onmessage = (e) => {
      if (e.data && e.data.type === "STATE_UPDATE") {
        state = e.data.state;
        showBanner(state.teamAName, state.teamBName);
      }
    };
  }

  if (typeof Peer !== "undefined" && navigator.onLine) {
    try {
      const probePeer = new Peer();
      probePeer.on("open", () => {
        const conn = probePeer.connect(FIXED_LOBBY_ID);
        conn.on("open", () => {
          hostConn = conn;
          peer = probePeer;
          conn.on("data", (data) => {
            if (data && data.type === "STATE_UPDATE") {
              state = data.state;
              showBanner(state.teamAName, state.teamBName);
              if (role === "board") renderBoardView();
              if (role === "player") syncPlayerBuzzerUI();
            }
          });
        });
      });
    } catch (e) {}
  }
}

// -------------------- بث الحالة لجميع المتصلين --------------------
function broadcastSync() {
  saveHostState();
  const payload = { type: "STATE_UPDATE", state };
  if (localChannel) localChannel.postMessage(payload);
  clientConns.forEach((c) => { if (c.open) c.send(payload); });
  offlineDataChannels.forEach((dc) => { if (dc.readyState === "open") dc.send(JSON.stringify(payload)); });
  updateHostPeerCount();
}

function updateHostPeerCount() {
  const total = clientConns.filter((c) => c.open).length +
    offlineDataChannels.filter((dc) => dc.readyState === "open").length;
  const badge = document.getElementById("hostConnBadge");
  const listEl = document.getElementById("connectedList");
  if (badge) badge.textContent = `متصل: ${total}`;
  if (listEl) listEl.textContent = `الأجهزة المتصلة حالياً: ${total}`;
}

// -------------------- تهيئة الشبكة للمضيف --------------------
function initNetworkAsHost() {
  loadHostState();
  const modePill = document.getElementById("hostNetMode");
  if (modePill) {
    modePill.textContent = navigator.onLine ? "🟢 بث تلقائي (أونلاين)" : "🟠 وضع البر (بدون نت)";
  }

  if (localChannel) {
    localChannel.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === "BUZZ") onHostReceiveBuzz(e.data.name, e.data.team);
      if (e.data.type === "DISCOVER" || e.data.type === "REQUEST_STATE") {
        localChannel.postMessage({ type: "STATE_UPDATE", state });
      }
    };
  }

  if (typeof Peer !== "undefined" && navigator.onLine) {
    try {
      peer = new Peer(FIXED_LOBBY_ID);
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

// -------------------- تهيئة العميل --------------------
function initNetworkAsClient() {
  const statusEl = document.getElementById("playerConnBadge");
  const boardStatusEl = document.getElementById("boardStatusText");
  const setStatus = (txt) => {
    if (statusEl) statusEl.textContent = txt;
    if (boardStatusEl) boardStatusEl.textContent = txt;
  };

  if (hostConn && hostConn.open) {
    setStatus("● متصل بالجلسة تلقائياً ✓");
  } else if (localChannel) {
    localChannel.postMessage({ type: "REQUEST_STATE" });
    localChannel.onmessage = (e) => {
      if (e.data && e.data.type === "STATE_UPDATE") {
        state = e.data.state;
        setStatus("● متصل بالجلسة محلياً ✓");
        if (role === "board") renderBoardView();
        if (role === "player") syncPlayerBuzzerUI();
      }
    };
  }

  if (!hostConn && typeof Peer !== "undefined" && navigator.onLine) {
    try {
      peer = new Peer();
      peer.on("open", () => {
        hostConn = peer.connect(FIXED_LOBBY_ID);
        hostConn.on("open", () => setStatus("● متصل بالجلسة تلقائياً ✓"));
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

// -------------------- رسم وحفظ ومشاركة وقراءة صور QR عالية الدقة --------------------
function renderQrCode(containerId, textData) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(box, {
      text: textData,
      width: 360,
      height: 360,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.L
    });
  } else {
    box.textContent = textData;
  }
}

// إضافة إطار أبيض عريض حول الباركود لضمان نجاح القراءة 100% من الاستوديو
function getPaddedQrDataUrl(containerId) {
  const container = document.getElementById(containerId);
  const srcCanvas = container.querySelector("canvas");
  const srcImg = container.querySelector("img");
  const source = srcCanvas || srcImg;
  if (!source) return null;

  const size = 440;
  const pad = 40;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = size;
  outCanvas.height = size;
  const ctx = outCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, pad, pad, size - pad * 2, size - pad * 2);
  return outCanvas.toDataURL("image/png");
}

function downloadQrImage(containerId, filename) {
  const dataUrl = getPaddedQrDataUrl(containerId);
  if (!dataUrl) {
    alert("يرجى إنشاء الباركود أولاً.");
    return;
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareQrImage(containerId, filename) {
  const dataUrl = getPaddedQrDataUrl(containerId);
  if (!dataUrl) return;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "باركود تحدي العائلات" });
    } else {
      downloadQrImage(containerId, filename);
    }
  } catch (e) {
    downloadQrImage(containerId, filename);
  }
}

// محرك قراءة متعدد الطبقات للصورة المرفوعة (BarcodeDetector + jsQR + Html5Qrcode)
async function decodeQrFromImageFile(file) {
  if (!file) return null;

  const imgBitmap = await createImageBitmap(file);

  // 1. المحاولة الأولى: واجهة المتصفح الأصلية BarcodeDetector (فورية ودقيقة جداً)
  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const codes = await detector.detect(imgBitmap);
      if (codes && codes.length > 0 && codes[0].rawValue) {
        return codes[0].rawValue;
      }
    } catch (e) {}
  }

  // 2. المحاولة الثانية: محرك jsQR على عدة مقاسات للصورة
  if (typeof window.jsQR !== "undefined") {
    const scales = [1, 0.75, 0.5];
    for (const sc of scales) {
      const w = Math.max(200, Math.floor(imgBitmap.width * sc));
      const h = Math.max(200, Math.floor(imgBitmap.height * sc));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(imgBitmap, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const code = window.jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
      if (code && code.data) {
        return code.data;
      }
    }
  }

  // 3. المحاولة الثالثة: Html5Qrcode
  if (typeof Html5Qrcode !== "undefined") {
    try {
      const reader = new Html5Qrcode("qrFileReaderHidden");
      const text = await reader.scanFile(file, false);
      reader.clear();
      if (text) return text;
    } catch (e) {}
  }

  alert("تعذر قراءة الباركود من هذه الصورة. تأكد من اختيار صورة الباركود المحفوظة مباشرة.");
  return null;
}

async function stopActiveScanner() {
  if (activeScanner) {
    try { await activeScanner.stop(); } catch (e) {}
    activeScanner = null;
  }
}

// -------------------- خطوات الربط بدون إنترنت (المضيف) --------------------
async function generateHostOfflineQr() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel("ff-offline");
  dc.onopen = () => {
    offlineDataChannels.push(dc);
    dc.send(JSON.stringify({ type: "STATE_UPDATE", state }));
    updateHostPeerCount();
    stopActiveScanner();
    document.getElementById("hostScannerBox").classList.add("hidden");
    alert("✅ تم ربط اللاعب بنجاح بدون إنترنت!");
  };
  dc.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "BUZZ") onHostReceiveBuzz(data.name, data.team);
    } catch (e) {}
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") r(); };
    setTimeout(r, 1000);
  });

  currentOfflinePC = pc;
  const compactOffer = packSdp("o", pc.localDescription.sdp);
  document.getElementById("hostQrContainer").classList.remove("hidden");
  renderQrCode("hostQrCanvas", compactOffer);
}

async function handleHostAnswerPayload(decodedText) {
  try {
    const parsed = JSON.parse(decodedText);
    if (parsed.t === "a" && currentOfflinePC) {
      await stopActiveScanner();
      document.getElementById("hostScannerBox").classList.add("hidden");
      const fullSdp = parsed.s || unpackSdp(parsed);
      await currentOfflinePC.setRemoteDescription({ type: "answer", sdp: fullSdp });
      const listEl = document.getElementById("connectedList");
      if (listEl) listEl.textContent = "⏳ جاري إتمام الاتصال المباشر مع اللاعب...";
    } else {
      alert("هذه الصورة ليست باركود رد من اللاعب (تأكد من رفع صورة الرد).");
    }
  } catch (e) {
    alert("حدث خطأ أثناء معالجة باركود الرد: " + e.message);
  }
}

async function startHostReplyScanner() {
  const scanDiv = document.getElementById("hostScannerBox");
  scanDiv.classList.remove("hidden");
  await stopActiveScanner();
  if (typeof Html5Qrcode === "undefined") return;
  activeScanner = new Html5Qrcode("hostScannerBox");
  activeScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 220 },
    async (decodedText) => await handleHostAnswerPayload(decodedText)
  ).catch((err) => alert("تعذر فتح الكاميرا: " + err));
}

// -------------------- خطوات الربط بدون إنترنت (اللاعب / الشاشة) --------------------
function openClientQrModal() {
  document.getElementById("clientQrModal").classList.remove("hidden");
  document.getElementById("clientReplyQrContainer").classList.add("hidden");
  document.getElementById("clientScannerBox").classList.add("hidden");
  document.getElementById("clientQrStepText").textContent = "اختر صورة باركود المضيف من الاستوديو (أو امسحها بالكاميرا):";
}

async function handleClientOfferPayload(decodedText) {
  try {
    const parsed = JSON.parse(decodedText);
    if (parsed.t === "o") {
      await stopActiveScanner();
      document.getElementById("clientScannerBox").classList.add("hidden");
      document.getElementById("clientQrStepText").textContent = "⏳ جاري إنشاء باركود الرد...";
      const fullSdp = parsed.s || unpackSdp(parsed);
      await buildClientAnswerQr(fullSdp);
    } else {
      alert("هذه الصورة ليست باركود دعوة من المضيف.");
    }
  } catch (e) {
    alert("صيغة الباركود غير صالحة: " + e.message);
  }
}

async function startClientCameraScan() {
  const scanDiv = document.getElementById("clientScannerBox");
  scanDiv.classList.remove("hidden");
  await stopActiveScanner();
  if (typeof Html5Qrcode === "undefined") return;
  activeScanner = new Html5Qrcode("clientScannerBox");
  activeScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 220 },
    async (decodedText) => await handleClientOfferPayload(decodedText)
  ).catch((err) => alert("يرجى السماح بالوصول للكاميرا: " + err));
}

async function buildClientAnswerQr(offerSdp) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    offlineDataChannels.push(dc);
    dc.onopen = () => {
      document.getElementById("clientQrModal").classList.add("hidden");
      const s1 = document.getElementById("playerConnBadge");
      const s2 = document.getElementById("boardStatusText");
      if (s1) s1.textContent = "● متصل بالمضيف بدون نت ✓";
      if (s2) s2.textContent = "● متصل بالمضيف بدون نت ✓";
      alert("✅ تم الاتصال بالمضيف بنجاح!");
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

  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await new Promise((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") r(); };
    setTimeout(r, 1000);
  });

  const compactAnswer = packSdp("a", pc.localDescription.sdp);
  document.getElementById("clientQrStepText").textContent = "✅ تم قراءة باركود المضيف! احفظ باركود الرد هذا أو شاركه للمضيف:";
  document.getElementById("clientReplyQrContainer").classList.remove("hidden");
  renderQrCode("clientReplyQrCanvas", compactAnswer);
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
function activateRole(selectedRole) {
  role = selectedRole;
  document.getElementById("role-gate").classList.add("hidden");

  if (role === "host") {
    document.getElementById("view-host").classList.remove("hidden");
    initNetworkAsHost();
    renderHostView();
  } else if (role === "board") {
    document.getElementById("view-board").classList.remove("hidden");
    initNetworkAsClient();
    renderBoardView();
  } else if (role === "player") {
    document.getElementById("view-player").classList.remove("hidden");
    initNetworkAsClient();
  }
}

// -------------------- تهيئة الأحداث --------------------
document.addEventListener("DOMContentLoaded", () => {
  startAutoDiscovery();

  document.getElementById("btnAutoJoinPlayer").addEventListener("click", () => activateRole("player"));
  document.getElementById("btnAutoJoinBoard").addEventListener("click", () => activateRole("board"));
  document.getElementById("choosePlayerBtn").addEventListener("click", () => activateRole("player"));
  document.getElementById("chooseBoardBtn").addEventListener("click", () => activateRole("board"));

  document.getElementById("chooseHostBtn").addEventListener("click", () => {
    document.getElementById("pinPromptBox").classList.remove("hidden");
  });

  document.getElementById("confirmHostPinBtn").addEventListener("click", () => {
    const val = document.getElementById("hostPinInput").value.trim();
    if (val === HOST_PIN || val === "") activateRole("host");
    else alert("الرمز غير صحيح!");
  });

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

  // أحداث QR (إنشاء، حفظ صورة، مشاركة صورة، ورفع صورة)
  document.getElementById("btnShareLinks").addEventListener("click", () => {
    document.getElementById("shareModal").classList.remove("hidden");
  });
  document.getElementById("btnGenHostQr").addEventListener("click", generateHostOfflineQr);
  document.getElementById("btnDownloadHostQr").addEventListener("click", () => {
    downloadQrImage("hostQrCanvas", "family-feud-invite.png");
  });
  document.getElementById("btnShareHostQrImg").addEventListener("click", () => {
    shareQrImage("hostQrCanvas", "family-feud-invite.png");
  });
  document.getElementById("hostReplyFileIn").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await decodeQrFromImageFile(file);
    e.target.value = "";
    if (text) await handleHostAnswerPayload(text);
  });
  document.getElementById("btnHostScanReplyQr").addEventListener("click", startHostReplyScanner);

  // أحداث العميل لرفع صورة QR أو مسحها
  document.getElementById("btnPlayerScanQr").addEventListener("click", openClientQrModal);
  document.getElementById("btnBoardScanQr").addEventListener("click", openClientQrModal);
  document.getElementById("btnClientOpenCam").addEventListener("click", startClientCameraScan);
  document.getElementById("clientOfferFileIn").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await decodeQrFromImageFile(file);
    e.target.value = "";
    if (text) await handleClientOfferPayload(text);
  });
  document.getElementById("btnDownloadClientQr").addEventListener("click", () => {
    downloadQrImage("clientReplyQrCanvas", "family-feud-reply.png");
  });
  document.getElementById("btnShareClientQrImg").addEventListener("click", () => {
    shareQrImage("clientReplyQrCanvas", "family-feud-reply.png");
  });

  // بنك الأسئلة
  document.getElementById("btnOpenBank").addEventListener("click", () => {
    renderBankItems("");
    document.getElementById("bankModal").classList.remove("hidden");
  });
  document.getElementById("bankSearchInput").addEventListener("input", (e) => renderBankItems(e.target.value));

  document.querySelectorAll(".close-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await stopActiveScanner();
      document.getElementById(btn.dataset.close).classList.add("hidden");
    });
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
