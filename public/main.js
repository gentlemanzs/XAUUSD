const API = "/api/gold";
const HIST_API = "/api/history"; 
const elements = {
  usd: document.getElementById("usd"), xau: document.getElementById("xau"),
  sjc: document.getElementById("sjc"), diff: document.getElementById("diff"),
  percent: document.getElementById("percent"), gapChange: document.getElementById("gapChange"), lastTime: document.getElementById("lastTime"),
  historyTable: document.getElementById("history"), filterBox: document.getElementById("filterBox"),
  startDate: document.getElementById("startDate"), endDate: document.getElementById("endDate"), toggleBtn: document.getElementById("toggleBtn"),
  actionHeader: document.getElementById("actionHeader"), pagination: document.getElementById("pagination")
};

const fmtVND = new Intl.NumberFormat('vi-VN');
const fmtXAU = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let historyData = []; 
let currentData = []; 
let lastSJCValue = null; 
let myChart = null;
let lastChartSignature = "";
let isExpanded = false; 
let currentPage = 1;

let evtSource = null;
let lastFetchTime = 0;

function safeFetchHistory(isInit = false) {
  const now = Date.now();
  if (!isInit && now - lastFetchTime < 2000) return;
  lastFetchTime = now;
  fetchHistory();
}

const dateCache = new Map();

/* ===== NẠP SIÊU TỐC TỪ BỘ NHỚ TRÌNH DUYỆT (CHỐNG CHỚP TRẮNG) ===== */
function loadLocalCache() {
  try {
    const cachedMain = localStorage.getItem('xau_main_data');
    if (cachedMain) {
      const d = JSON.parse(cachedMain);
      renderMain(d);
      lastSJCValue = d.sjc;
    }
    const cachedHist = localStorage.getItem('xau_hist_data');
    if (cachedHist) {
      historyData = JSON.parse(cachedHist);
      currentData = [...historyData];
      renderTable();
      updateChart(currentData);
    }
  } catch(e) {}
}

function initSSE() {
  if (evtSource && evtSource.readyState !== EventSource.CLOSED) return;
  
  evtSource = new EventSource("/api/stream");
  evtSource.onopen = () => { console.log("🟢 SSE đã kết nối thành công"); };

  evtSource.onmessage = (event) => {
    if (!event.data) return;
    const d = JSON.parse(event.data);
    if (!d?.updatedAt) return;
    
    elements.lastTime.style.color = "#10b981";
    setTimeout(() => elements.lastTime.style.color = "#64748b", 2000);
    
    renderMain(d);
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      const isFirstLoad = lastSJCValue === null;
      lastSJCValue = d.sjc;
      safeFetchHistory(isFirstLoad);
    }
  };

  evtSource.onerror = () => {
    console.warn("SSE mất kết nối, trình duyệt đang tự động thử reconnect...");
    elements.lastTime.innerHTML = "🔴 Mất kết nối. Đang thử lại...";
    elements.lastTime.style.color = "var(--down-color)";
  };
}

async function load() {
  try {
    const res = await fetch(`${API}?t=${Date.now()}`);
    const d = await res.json();
    if (!d?.updatedAt) return;
    
    renderMain(d);
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      const isFirstLoad = lastSJCValue === null;
      lastSJCValue = d.sjc;
      safeFetchHistory(isFirstLoad);
    }
  } catch(e) { console.error(e); }
}

function renderMain(d) {
  // LƯU VÀO CACHE TRÌNH DUYỆT ĐỂ LẦN SAU F5 SẼ HIỆN NGAY LẬP TỨC
  localStorage.setItem('xau_main_data', JSON.stringify(d));

  const usdText = fmtVND.format(d.usd);
  if (elements.usd.innerText !== usdText) elements.usd.innerText = usdText;
  
  const diffText = fmtVND.format(d.diff);
  if (elements.diff.innerText !== diffText) elements.diff.innerText = diffText;
  if (elements.percent.innerText !== d.percent) elements.percent.innerText = d.percent;

  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  const xColorClass = isXUp ? 'xau-up' : 'xau-down';
  const newXauHtml = `
    <div class="xau-wrapper">
      <div>${fmtXAU.format(d.xau)}</div>
      <div class="sjc-sub ${xColorClass}">${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}</div>
    </div>
  `;
  if (elements.xau.innerHTML !== newXauHtml) elements.xau.innerHTML = newXauHtml;

  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const gPrefix = gVal > 0 ? "+" : ""; 
    const newGapText = gPrefix + fmtVND.format(gVal);
    if (elements.gapChange.innerText !== newGapText) {
      elements.gapChange.innerText = newGapText;
      if (gVal > 0) elements.gapChange.style.color = "var(--up-color)";
      else if (gVal < 0) elements.gapChange.style.color = "var(--down-color)";
      else elements.gapChange.style.color = "var(--secondary-text)";
    }
  }

  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  const newSjcHtml = `
    <div>${fmtVND.format(d.sjc)}</div>
    <div class="sjc-sub ${isUp ? 'change-up' : 'change-down'}">${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}</div>
  `;
  if (elements.sjc.innerHTML !== newSjcHtml) elements.sjc.innerHTML = newSjcHtml;

  const updateTime = new Date(d.updatedAt);
  const timeStr = isNaN(updateTime) ? new Date().toLocaleTimeString('vi-VN') : updateTime.toLocaleTimeString('vi-VN');
  const newStatusHtml = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
  if (elements.lastTime.innerHTML !== newStatusHtml) elements.lastTime.innerHTML = newStatusHtml;
}

async function fetchHistory() {
  try {
    const res = await fetch(HIST_API, { cache: "no-store" });
    historyData = await res.json(); 
    
    // LƯU BẢNG LỊCH SỬ VÀO CACHE TRÌNH DUYỆT
    localStorage.setItem('xau_hist_data', JSON.stringify(historyData));
    
    currentData = [...historyData]; 
    renderTable(); 
    updateChart(currentData);
  } catch(e) { console.error(e); }
}

function formatVNDateTime(isoString) {
  if (dateCache.has(isoString)) return dateCache.get(isoString); 
  const d = new Date(isoString);
  if (isNaN(d)) return "--";
  const formatted = d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (dateCache.size > 300) {
    const firstKey = dateCache.keys().next().value;
    dateCache.delete(firstKey);
  }
  dateCache.set(isoString, formatted);
  return formatted;
}

function renderTable() {
  const pageSize = isExpanded ? 50 : 10;
  const startIdx = isExpanded ? (currentPage - 1) * pageSize : 0;
  const endIdx = startIdx + pageSize;
  const displayData = currentData.slice(startIdx, endIdx);
  const displayStyle = isExpanded ? "table-cell" : "none";
  document.getElementById('selectAll').checked = false;

  const fragment = document.createDocumentFragment();

  displayData.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-action" style="display: ${displayStyle}; text-align: center !important;">
        <input type="checkbox" class="log-checkbox" value="${r._id}">
      </td>
      <td class="col-time">${formatVNDateTime(r.createdAt)}</td>
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${r.percent.includes('-') ? 'badge-down' : 'badge-up'}">${r.percent}</span></td>
    `;
    fragment.appendChild(tr);
  });

  elements.historyTable.innerHTML = "";
  elements.historyTable.appendChild(fragment);
  renderPagination();
}

function renderPagination() {
  const pag = elements.pagination;
  if (!isExpanded || currentData.length <= 50) { pag.style.display = "none"; return; }
  
  pag.style.display = "flex"; pag.innerHTML = "";
  const totalPages = Math.ceil(currentData.length / 50);
  
  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn"; prevBtn.innerText = "« Trước";
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; renderTable(); } };
  pag.appendChild(prevBtn);
  
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
  
  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement("button");
    btn.className = `page-btn ${i === currentPage ? "active" : ""}`; btn.innerText = i;
    btn.onclick = () => { currentPage = i; renderTable(); };
    pag.appendChild(btn);
  }
  
  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn"; nextBtn.innerText = "Sau »";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => { if (currentPage < totalPages) { currentPage++; renderTable(); } };
  pag.appendChild(nextBtn);
}

function toggleFilterBox() {
  isExpanded = !isExpanded;
  elements.filterBox.style.display = isExpanded ? "flex" : "
