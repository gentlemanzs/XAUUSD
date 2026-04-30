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
  } catch(e) {}
}

// [TỐI ƯU DOM 3.4 & HTML REPAINT 2.3] Biến lưu trạng thái để tránh đè innerHTML không cần thiết
let currentRenderedStates = { xauStr: "", sjcStr: "" };

function renderMain(d) {
  try { localStorage.setItem('xau_main_cache', JSON.stringify(d)); } catch(e) {}

  const usdText = fmtVND.format(d.usd);
  if (elements.usd.innerText !== usdText) elements.usd.innerText = usdText;
  
  const diffText = fmtVND.format(d.diff);
  if (elements.diff.innerText !== diffText) elements.diff.innerText = diffText;
  
  if (elements.percent.innerText !== d.percent) elements.percent.innerText = d.percent;

  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  const newXauSig = `${d.xau}_${xChange}`; // Tạo chữ ký kiểm tra
  
  if (currentRenderedStates.xauStr !== newXauSig) {
    elements.xau.innerHTML = `
      <div class="xau-wrapper">
        <div>${fmtXAU.format(d.xau)}</div>
        <div class="sjc-sub ${isXUp ? 'xau-up' : 'xau-down'}">
          ${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}
        </div>
      </div>
    `;
    currentRenderedStates.xauStr = newXauSig;
  }

  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const newGapText = (gVal > 0 ? "+" : "") + fmtVND.format(gVal);
    if (elements.gapChange.innerText !== newGapText) {
      elements.gapChange.innerText = newGapText;
      elements.gapChange.style.color = gVal > 0 ? "var(--up-color)" : (gVal < 0 ? "var(--down-color)" : "var(--secondary-text)");
    }
  }

  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  const newSjcSig = `${d.sjc}_${change}`;

  if (currentRenderedStates.sjcStr !== newSjcSig) {
    elements.sjc.innerHTML = `
      <div>${fmtVND.format(d.sjc)}</div>
      <div class="sjc-sub ${isUp ? 'change-up' : 'change-down'}">
        ${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}
      </div>
    `;
    currentRenderedStates.sjcStr = newSjcSig;
  }

  const timeStr = d.timeStr || new Date().toLocaleTimeString('vi-VN');
  const newStatusHtml = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
  if (elements.lastTime.innerHTML !== newStatusHtml) elements.lastTime.innerHTML = newStatusHtml;
}

async function fetchHistory() {
  try {
    // [TỐI ƯU 3.1 & 2.2] Chỉ gọi giới hạn bản ghi tùy theo trạng thái đang thu gọn hay bung rộng
    const limit = isExpanded ? 1000 : 50; 
    const res = await fetch(`${HIST_API}?limit=${limit}`, { cache: "no-store" });
    historyData = await res.json(); 
    
    try { localStorage.setItem('xau_hist_cache', JSON.stringify(historyData)); } catch(e) {}

    currentData = [...historyData]; 
    renderTable(); 
    updateChart(currentData);
  } catch(e) {}
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
    // [TỐI ƯU 3.3] Dùng trực tiếp r.timeStr do Backend trả về, tiết kiệm cực nhiều CPU
    tr.innerHTML = `
      <td class="col-action" style="display: ${displayStyle};">
        <input type="checkbox" class="log-checkbox" value="${r._id}">
      </td>
      <td class="col-time">${r.timeStr || '--'}</td> 
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
  elements.filterBox.style.display = isExpanded ? "flex" : "none";
  elements.toggleBtn.innerText = isExpanded ? "−" : "+";
  elements.actionHeader.style.display = isExpanded ? "table-cell" : "none";
  currentPage = 1;
  // Cập nhật lại data mẻ lớn (1000) khi bung bảng
  fetchHistory(); 
}

function applyFilter() {
  const startStr = elements.startDate.value;
  const endStr = elements.endDate.value;
  
  currentData = (!startStr && !endStr) ? [...historyData] : historyData.filter(r => {
    const d = new Date(r.createdAt);
    if(isNaN(d)) return false;
    const formatted = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
    if(startStr && formatted < startStr) return false;
    if(endStr && formatted > endStr) return false;
    return true;
  });
  
  currentPage = 1; 
  renderTable(); 
  updateChart(currentData);
}

function resetFilter() {
  elements.startDate.value = "";
  elements.endDate.value = "";
  currentData = [...historyData]; 
  currentPage = 1; 
  renderTable(); 
  updateChart(currentData);
}

function toggleSelectAll(source) {
  const checkboxes = document.querySelectorAll('.log-checkbox');
  checkboxes.forEach(cb => cb.checked = source.checked);
}

async function deleteSelected() {
  const checkedBoxes = document.querySelectorAll('.log-checkbox:checked');
  if (checkedBoxes.length === 0) { alert("Vui lòng tích chọn ít nhất 1 dòng để xóa."); return; }
  if (!confirm(`Bạn có chắc chắn muốn xóa ${checkedBoxes.length} bản ghi đã chọn?`)) return;

  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  try {
    const res = await fetch('/api/history/bulk-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    });
    if (res.ok) await fetchHistory(); else alert("Lỗi khi xóa dữ liệu!");
  } catch(e) { console.error(e); alert("Lỗi mạng!"); }
}

function updateChart(fullData) {
  if (!fullData || fullData.length === 0) return;

  // [TỐI ƯU 3.2 & 2.1] Cắt giảm tối đa 150 điểm để vẽ biểu đồ, tránh treo trình duyệt điện thoại
  const MAX_POINTS = 150;
  const data = fullData.slice(0, MAX_POINTS);

  const currentSignature = `${data.length}_${data[0].createdAt}`;
  if (currentSignature === lastChartSignature) return; 

  lastChartSignature = currentSignature;
  const chartCanvas = document.getElementById('gapChart');
  const ctx = chartCanvas.getContext('2d');
  
  const totalPoints = data.length;
  const labels = [];
  const gaps = [];

  for (let i = totalPoints - 1; i >= 0; i--) {
    const r = data[i];
    // Tái sử dụng timeStr từ server, cắt lấy phần giờ:phút "HH:mm"
    labels.push(r.timeStr ? r.timeStr.substring(0, 5) : "--:--");
    gaps.push(r.diff / 1000000);
  }

  const wrapper = chartCanvas.parentElement;
  const scrollContainer = document.querySelector('.chart-scroll-container');
  const containerWidth = scrollContainer.clientWidth || window.innerWidth;

  const maxSpacing = 110; 
  let minSpacing = 75;  

  if (totalPoints * minSpacing > 30000) minSpacing = Math.floor(30000 / totalPoints);
  
  const minPointsToFill = Math.ceil(containerWidth / maxSpacing);

  if (totalPoints > 0 && totalPoints < minPointsToFill) {
    const padCount = minPointsToFill - totalPoints;
    for (let i = 0; i < padCount; i++) {
      labels.push(' '.repeat(i + 1)); 
      gaps.push(null); 
    }
  }

  const validGaps = gaps.filter(g => g !== null);
  let yMin = 0;
  let yMax = 0;

  if (validGaps.length > 0) {
    const minVal = Math.min(...validGaps);
    const maxVal = Math.max(...validGaps);
    const range = maxVal - minVal;
    const padding = Math.max(range * 0.2, 0.5); 
    yMin = minVal - padding;
    yMax = maxVal + padding;
  }

  const calculatedWidth = totalPoints * minSpacing;

  if (calculatedWidth > containerWidth) {
    wrapper.style.setProperty('width', calculatedWidth + 'px', 'important');
    wrapper.style.setProperty('min-width', calculatedWidth + 'px', 'important');
  } else {
    wrapper.style.setProperty('width', '100%', 'important');
    wrapper.style.setProperty('min-width', '100%', 'important');
  }

  if (myChart) {
    myChart.data.labels = labels;
    myChart.data.datasets[0].data = gaps;
    myChart.options.scales.y.suggestedMin = yMin;
    myChart.options.scales.y.suggestedMax = yMax;
    myChart.update('none');
  } else {
    myChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: gaps,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, 
        plugins: { legend: { display: false } },
        scales: {
          y: {
            suggestedMin: yMin, suggestedMax: yMax, beginAtZero: false,
            ticks: { maxTicksLimit: 6, callback: (val) => val.toFixed(1) + 'M', color: '#64748b', font: { size: 11 } },
            grid: { color: 'rgba(226, 232, 240, 0.6)' }
          },
          x: {
            ticks: { autoSkip: true, maxRotation: 0, color: '#64748b', font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });
  }
  
  const isAtRightEdge = scrollContainer.scrollWidth - scrollContainer.clientWidth <= scrollContainer.scrollLeft + 50;
  requestAnimationFrame(() => {
    if (isAtRightEdge || data.length <= 10) {
      scrollContainer.scrollLeft = (totalPoints < minPointsToFill) ? 0 : scrollContainer.scrollWidth;
    }
  });
}

try {
  const cachedMain = localStorage.getItem('xau_main_cache');
  if (cachedMain) {
    const parsedMain = JSON.parse(cachedMain);
    renderMain(parsedMain);
    lastSJCValue = parsedMain.sjc; 
  }

  const cachedHistory = localStorage.getItem('xau_hist_cache');
  if (cachedHistory) {
    historyData = JSON.parse(cachedHistory);
    currentData = [...historyData];
    renderTable();
    updateChart(currentData);
  }
} catch(e) { console.error("Lỗi đọc cache:", e); }

initSSE();

setTimeout(() => { if (lastSJCValue === null) load(); }, 3000);

const pullContainer = document.createElement("div");
pullContainer.className = "cyber-pull-container";
pullContainer.innerHTML = `
  <div class="pulse-bars">
    <div class="pulse-bar" id="bar1"></div><div class="pulse-bar" id="bar2"></div>
    <div class="pulse-bar" id="bar3"></div><div class="pulse-bar" id="bar4"></div>
  </div>
  <div class="cyber-text">Đồng bộ dữ liệu...</div>
`;
document.body.appendChild(pullContainer);

let startY = 0; let isPulling = false; let isRefreshing = false; const pullThreshold = 120; 
const textEl = pullContainer.querySelector('.cyber-text');
const bars = [ document.getElementById('bar1'), document.getElementById('bar2'), document.getElementById('bar3'), document.getElementById('bar4') ];
const targetHeights = [12, 24, 16, 20]; 

window.addEventListener("touchstart", (e) => { 
  if (window.scrollY <= 0 && !isRefreshing) { startY = e.touches[0].clientY; isPulling = true; } 
}, { passive: true });

window.addEventListener("touchmove", (e) => {
  if (!isPulling || isRefreshing) return;
  const diff = e.touches[0].clientY - startY;
  if (diff > 0 && window.scrollY <= 0) {
    if (e.cancelable) e.preventDefault();
    const moveY = Math.min(diff * 0.4, 90); 
    pullContainer.style.top = `${-80 + moveY}px`;
    const pullRatio = Math.min(diff / pullThreshold, 1);
    bars.forEach((bar, index) => { bar.style.height = `${4 + (targetHeights[index] - 4) * pullRatio}px`; });
    if (diff > pullThreshold) { pullContainer.classList.add('ready'); textEl.innerText = "Thả tay để tải mới!"; } 
    else { pullContainer.classList.remove('ready'); textEl.innerText = "Kéo thêm chút nữa..."; }
  }
}, { passive: false });

window.addEventListener("touchend", (e) => {
  if (!isPulling || isRefreshing) return;
  isPulling = false;
  const diff = e.changedTouches[0].clientY - startY;
  bars.forEach(bar => bar.style.height = '');
  if (diff > pullThreshold) {
    isRefreshing = true;
    pullContainer.classList.remove('ready'); pullContainer.classList.add('refreshing'); pullContainer.style.top = "20px"; 
    textEl.innerText = "Updating...";
    load().then(() => {
      textEl.innerText = "Success!";
      pullContainer.classList.remove('refreshing'); pullContainer.classList.add('ready');
      bars.forEach((bar, idx) => bar.style.height = `${targetHeights[idx]}px`);
      setTimeout(() => { 
        pullContainer.style.top = "-80px"; 
        setTimeout(() => { isRefreshing = false; pullContainer.classList.remove('ready'); }, 300);
      }, 1200);
    });
  } else { pullContainer.style.top = "-80px"; }
}, { passive: true });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (evtSource) { evtSource.close(); evtSource = null; console.log("⏸ Tab ẩn. Đã tạm ngắt SSE để tiết kiệm pin."); }
  } else {
    console.log("▶ Tab hoạt động. Đang kết nối và tải lại dữ liệu mới nhất...");
    load(); initSSE();
  }
});