// ============================================================================
// PHẦN 1: KHỞI TẠO BIẾN, DOM ELEMENTS VÀ CẤU HÌNH FORMAT
// ============================================================================
const API = "/api/gold";
const HIST_API = "/api/history";

// Gom nhóm tất cả các phần tử DOM để tránh gọi document.getElementById nhiều lần
const elements = {
  usd: document.getElementById("usd"),
  xauValue: document.getElementById("xauValue"), xauChange: document.getElementById("xauChange"),
  sjcValue: document.getElementById("sjcValue"), sjcChange: document.getElementById("sjcChange"),
  diff: document.getElementById("diff"), percent: document.getElementById("percent"),
  gapChange: document.getElementById("gapChange"), lastTime: document.getElementById("lastTime"),
  historyTable: document.getElementById("history"), filterBox: document.getElementById("filterBox"),
  startDate: document.getElementById("startDate"), endDate: document.getElementById("endDate"),
  toggleBtn: document.getElementById("toggleBtn"),
  pagination: document.getElementById("pagination")
};

// Cấu hình định dạng tiền tệ (VND) và số thập phân (USD/XAU)
const fmtVND = new Intl.NumberFormat('vi-VN');
const fmtXAU = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Biến lưu trữ trạng thái RAM của Frontend
let historyData = [];       // Lưu toàn bộ lịch sử (tối đa 1000 dòng)
let currentData = [];       // Lưu dữ liệu đang hiển thị (sau khi filter)
let lastSJCValue = null;    // Lưu giá SJC lần cuối để so sánh
let myChart = null;         // Đối tượng Chart.js
let lastChartSignature = "";// Chữ ký biểu đồ để tránh render lại biểu đồ giống nhau
let isExpanded = false;     // Trạng thái mở rộng bảng History
let currentPage = 1;        // Trang hiện tại của Pagination

let evtSource = null;       // Đối tượng Server-Sent Events (SSE)
let lastFetchTime = 0;      // Chống spam gọi API liên tục

// ============================================================================
// PHẦN 2: QUẢN LÝ OBSERVER & ĐỒNG BỘ DỮ LIỆU CƠ BẢN
// ============================================================================

// Chỉ render/update biểu đồ khi người dùng cuộn tới nó (Tối ưu hiệu năng GPU)
let isChartVisible = true;
const chartObserver = new IntersectionObserver((entries) => {
  isChartVisible = entries[0].isIntersecting;
  if (isChartVisible && myChart) myChart.update('none');
}, { threshold: 0.1 });

document.addEventListener("DOMContentLoaded", () => {
  const chartEl = document.getElementById('gapChart');
  if (chartEl) chartObserver.observe(chartEl);
});

// Hàm gọi API lịch sử an toàn, có throttle (tối thiểu 5 giây mỗi lần gọi)
function safeFetchHistory(isInit = false) {
  const now = Date.now();
  if (!isInit && now - lastFetchTime < 5000) return;
  lastFetchTime = now;
  fetchHistory();
}

// ============================================================================
// PHẦN 3: KẾT NỐI REALTIME (SERVER-SENT EVENTS)
// ============================================================================
function initSSE() {
  // Fix rò rỉ SSE: Đóng hẳn luồng cũ nếu nó đang ở trạng thái lấp lửng
  if (evtSource) {
    if (evtSource.readyState === EventSource.OPEN) return;
    evtSource.close();
  }

  evtSource = new EventSource("/api/stream");

  evtSource.onmessage = (event) => {
    if (!event.data) return;
    let d;
    try { d = JSON.parse(event.data); } catch (e) {
      console.error('[SSE] JSON parse lỗi:', e);
      return;
    }
    if (!d?.updatedAt) return;

    // Hiệu ứng chớp xanh chữ "Đang kết nối..." báo hiệu có data mới
    elements.lastTime.style.color = "#10b981";
    setTimeout(() => elements.lastTime.style.color = "#64748b", 2000);

    // Xử lý cảnh báo nếu cào lỗi
    if (d.failedAPIs && d.failedAPIs.length > 0) {
      console.warn(`[XAU] ⚠️ API lỗi lúc ${d.timeStr}:`, d.failedAPIs.join(", "), "→ Đang dùng data cũ");
    } else {
      console.log(`Updated at ${new Date().toLocaleTimeString('vi-VN')}`);
    }

    renderMain(d); // Vẽ lại các thẻ Card

    // NẾU GIÁ SJC THAY ĐỔI -> Tự động kéo lịch sử mới về
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      const isFirstLoad = lastSJCValue === null;
      lastSJCValue = d.sjc;
      safeFetchHistory(isFirstLoad);
    }
  };

  evtSource.onerror = () => {
    elements.lastTime.textContent = "🔴 Mất kết nối. Đang thử lại...";
    elements.lastTime.style.color = "var(--down-color)";
  };
}

// Hàm tải dữ liệu thủ công (Fallback khi mới vào web hoặc mất SSE)
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
  } catch (e) {
    console.error('[load] Lỗi:', e);
  }
}

// ============================================================================
// PHẦN 4: RENDER GIAO DIỆN (CÁC THẺ CARD DỮ LIỆU)
// ============================================================================
function renderMain(d) {
  // Lưu cache để mở app lần sau hiển thị ngay (Offline First)
  try { localStorage.setItem('xau_main_cache', JSON.stringify(d)); } catch (e) { }

  // Chỉ cập nhật DOM nếu giá trị thực sự thay đổi (Tối ưu Repaint/Reflow)
  const usdText = fmtVND.format(d.usd);
  if (elements.usd.textContent !== usdText) elements.usd.textContent = usdText;

  const diffText = fmtVND.format(d.diff);
  if (elements.diff.textContent !== diffText) elements.diff.textContent = diffText;
  if (elements.percent.textContent !== d.percent) elements.percent.textContent = d.percent;

  // Tính toán và bôi màu giá Vàng Thế Giới (XAU)
  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  const xauValueStr = fmtXAU.format(d.xau);
  const xauChangeStr = `${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}`;

  if (elements.xauValue.textContent !== xauValueStr) elements.xauValue.textContent = xauValueStr;
  if (elements.xauChange.textContent !== xauChangeStr) {
    elements.xauChange.textContent = xauChangeStr;
    elements.xauChange.classList.remove('xau-up', 'xau-down');
    elements.xauChange.classList.add(isXUp ? 'xau-up' : 'xau-down');
  }

  // Khối: Sự thay đổi của Market Gap
  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const newGapText = (gVal > 0 ? "+" : "") + fmtVND.format(gVal);
    if (elements.gapChange.textContent !== newGapText) {
      elements.gapChange.textContent = newGapText;
      elements.gapChange.style.color = gVal > 0 ? "var(--up-color)" : (gVal < 0 ? "var(--down-color)" : "var(--secondary-text)");
    }
  }

  if (!d.sjc) return;

  // Tính toán và bôi màu giá SJC
  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  const sjcValueStr = fmtVND.format(d.sjc);
  const sjcChangeStr = `${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}`;

  if (elements.sjcValue.textContent !== sjcValueStr) elements.sjcValue.textContent = sjcValueStr;
  if (elements.sjcChange.textContent !== sjcChangeStr) {
    elements.sjcChange.textContent = sjcChangeStr;
    elements.sjcChange.classList.remove('change-up', 'change-down');
    elements.sjcChange.classList.add(isUp ? 'change-up' : 'change-down');
  }

  // Cập nhật dòng trạng thái cuối cùng
  const timeStr = d.timeStr || new Date().toLocaleTimeString('vi-VN');
  const newStatusText = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
  if (elements.lastTime.textContent !== newStatusText) elements.lastTime.textContent = newStatusText;
}

// ============================================================================
// PHẦN 5: XỬ LÝ LỊCH SỬ (BẢNG, PHÂN TRANG VÀ BỘ LỌC)
// ============================================================================
async function fetchHistory() {
  try {
    const limit = isExpanded ? 1000 : 50; 
    const res = await fetch(`${HIST_API}?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    historyData = await res.json();

    for (const r of historyData) {
      if (!r.filterDateStr && r.createdAt) {
        const d = new Date(r.createdAt);
        if (!isNaN(d)) {
          r.filterDateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        }
      }
    }

    try { localStorage.setItem('xau_hist_cache', JSON.stringify(historyData)); } catch (e) { }
    currentData = historyData;

    if (elements.startDate.value || elements.endDate.value) {
      applyFilter();
    } else {
      renderTable();
      updateChart(currentData);
    }
  } catch (e) {
    console.error('[fetchHistory] Lỗi:', e);
  }
}

// Render dữ liệu ra bảng HTML (Có phân trang)
function renderTable() {
  const pageSize = isExpanded ? 50 : 10;
  const startIdx = isExpanded ? (currentPage - 1) * pageSize : 0;
  const endIdx = startIdx + pageSize;
  const displayData = currentData.slice(startIdx, endIdx);

  document.getElementById('selectAll').checked = false;

  const fragment = document.createDocumentFragment();

  displayData.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-time">
        <span>${r.timeStr || '--'}</span>
        <input type="checkbox" class="log-checkbox check-action" value="${r._id}">
      </td> 
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${(r.percent || '').includes('-') ? 'badge-down' : 'badge-up'}"></span></td>
    `;
    tr.querySelector('td:last-child span').textContent = r.percent || '--';
    fragment.appendChild(tr);
  });

  if (elements.historyTable.replaceChildren) {
    elements.historyTable.replaceChildren(fragment);
  } else {
    elements.historyTable.innerHTML = "";
    elements.historyTable.appendChild(fragment);
  }

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

  if (isExpanded) { elements.filterBox.classList.add('show'); }
  else { elements.filterBox.classList.remove('show'); }

  elements.toggleBtn.innerText = isExpanded ? "−" : "+";

  const wrapper = document.querySelector('.table-wrapper');
  if (isExpanded) wrapper.classList.add('is-expanded');
  else wrapper.classList.remove('is-expanded');

  currentPage = 1;
  if (isExpanded) { fetchHistory(); } else { renderTable(); }
}

async function applyFilter() {
  const startStr = elements.startDate.value;
  const endStr = elements.endDate.value;

  if ((startStr || endStr) && historyData.length < 1000) {
    elements.historyTable.innerHTML = "<tr><td colspan='5' style='text-align:center;'>Đang truy xuất dữ liệu...</td></tr>";
    try {
      const res = await fetch(`${HIST_API}?limit=1000`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      historyData = await res.json();
      for (const r of historyData) {
        if (!r.filterDateStr && r.createdAt) {
          const d = new Date(r.createdAt);
          if (!isNaN(d)) r.filterDateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        }
      }
      try { localStorage.setItem('xau_hist_cache', JSON.stringify(historyData)); } catch (e) { }
    } catch (e) { }
  }

  currentData = (!startStr && !endStr) ? historyData : historyData.filter(r => {
    if (!r.filterDateStr) return false;
    if (startStr && r.filterDateStr < startStr) return false;
    if (endStr && r.filterDateStr > endStr) return false;
    return true;
  });

  currentPage = 1;
  renderTable();
  updateChart(currentData);
}

function resetFilter() {
  elements.startDate.value = ""; elements.endDate.value = "";
  currentData = historyData;
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

  const secret = prompt("Nhập mật khẩu để xác nhận xóa:");
  if (secret === null) return;

  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  try {
    const res = await fetch('/api/history/bulk-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids, secret: secret })
    });

    if (res.ok) {
      currentPage = 1;
      const selectAllBtn = document.getElementById('selectAll');
      if (selectAllBtn) selectAllBtn.checked = false;
      await fetchHistory();
    } else {
      const data = await res.json();
      alert(data.error || "Lỗi khi xóa dữ liệu!");
    }
  } catch (e) { alert("Lỗi mạng!"); }
}

// ============================================================================
// PHẦN 6: VẼ BIỂU ĐỒ (CHART.JS)
// ============================================================================
function updateChart(fullData) {
  if (!fullData || fullData.length < 2) {
    lastChartSignature = "";
    if (myChart) {
      myChart.data.labels = []; myChart.data.datasets[0].data = [];
      myChart.update('none');
    }
    return;
  }

  const MAX_POINTS = 100;
  const data = fullData.slice(0, MAX_POINTS);

  const currentSignature = `${data.length}_${data[0].createdAt}_${data[data.length - 1].createdAt}`;
  if (currentSignature === lastChartSignature) return;
  lastChartSignature = currentSignature;

  const chartCanvas = document.getElementById('gapChart');
  const ctx = chartCanvas.getContext('2d');
  const totalPoints = data.length;
  const labels = []; const gaps = [];

  let lastDateLabel = null;
  for (let i = totalPoints - 1; i >= 0; i--) {
    const r = data[i];
    let dateLabel = null;
    if (r.filterDateStr) {
      const parts = r.filterDateStr.split('-');
      if (parts.length === 3) dateLabel = `${parts[2]}/${parts[1]}`;
    }
    if (dateLabel && dateLabel !== lastDateLabel) {
      labels.push(dateLabel); lastDateLabel = dateLabel;
    } else {
      labels.push('');
    }
    gaps.push(r.diff / 1000000); 
  }

  const wrapper = chartCanvas.parentElement;
  const scrollContainer = document.querySelector('.chart-scroll-container');
  const containerWidth = scrollContainer.clientWidth || window.innerWidth;

  const maxSpacing = 110; let minSpacing = 75;
  if (totalPoints * minSpacing > 30000) minSpacing = Math.floor(30000 / totalPoints);

  const minPointsToFill = Math.ceil(containerWidth / maxSpacing);
  if (totalPoints > 0 && totalPoints < minPointsToFill) {
    const padCount = minPointsToFill - totalPoints;
    for (let i = 0; i < padCount; i++) {
      labels.push(' '.repeat(i + 1)); gaps.push(null);
    }
  }

  const validGaps = gaps.filter(g => g !== null);
  let yMin = 0; let yMax = 0;
  if (validGaps.length === 0) return;
  const minVal = Math.min(...validGaps); const maxVal = Math.max(...validGaps);
  const padding = Math.max((maxVal - minVal) * 0.2, 0.5);
  yMin = minVal - padding; yMax = maxVal + padding;

  const calculatedWidth = totalPoints * minSpacing;

  if (wrapper._lastWidth !== calculatedWidth) {
    wrapper._lastWidth = calculatedWidth;
    if (calculatedWidth > containerWidth) {
      wrapper.style.setProperty('width', calculatedWidth + 'px', 'important');
      wrapper.style.setProperty('min-width', calculatedWidth + 'px', 'important');
    } else {
      wrapper.style.setProperty('width', '100%', 'important');
      wrapper.style.setProperty('min-width', '100%', 'important');
    }
  }

  if (myChart) {
    myChart.data.labels = labels; myChart.data.datasets[0].data = gaps;
    myChart.options.scales.y.suggestedMin = yMin; myChart.options.scales.y.suggestedMax = yMax;
    if (isChartVisible) myChart.update('none'); 
  } else {
    myChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: gaps, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3
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
          x: { offset: true, ticks: { autoSkip: true, maxRotation: 0, color: '#64748b', font: { size: 10 } }, grid: { display: false } }
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

// ============================================================================
// PHẦN 7: EVENT LISTENER VÀ PULL-TO-REFRESH
// ============================================================================

async function forceSync() {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot loading';

  try {
    const res = await fetch('/api/force-sync', { method: 'POST' });
    if (res.ok) { dot.className = 'sync-dot success'; }
    else { dot.className = 'sync-dot'; }
  } catch (e) { dot.className = 'sync-dot'; }

  setTimeout(() => {
    if (dot.className.includes('success')) { dot.className = 'sync-dot'; }
  }, 3000);
}

try {
  const cachedMain = localStorage.getItem('xau_main_cache');
  if (cachedMain) {
    const parsedMain = JSON.parse(cachedMain);
    renderMain(parsedMain);
    lastSJCValue = parsedMain.sjc;
  }

  const histCache = localStorage.getItem('xau_hist_cache');
  if (histCache) {
    historyData = JSON.parse(histCache); currentData = historyData;
    renderTable(); updateChart(currentData);
  } else {
    safeFetchHistory(true);
  }
} catch (e) { }

load();
initSSE();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (evtSource) { evtSource.close(); evtSource = null; }
  } else {
    setTimeout(() => { if (!document.hidden) { load(); initSSE(); } }, 500);
  }
});

// LOGIC: Kéo thả màn hình (The Gold Digger Theme)
let startY = 0;
let isPulling = false;
let isRefreshing = false;
const pullThreshold = 130; 
const pullContainer = document.getElementById("minerPull");
const rope = document.getElementById("rope");
const miner = document.getElementById("miner");
const rock = document.getElementById("rock");
const tnt = document.getElementById("tnt");
const explosion = document.getElementById("explosion");
const goldLoot = document.getElementById("gold-loot");
const textEl = document.getElementById("pullText");

window.addEventListener("touchstart", (e) => {
  if (window.scrollY <= 0 && !isRefreshing) {
    if (e.touches[0].clientY < 0) return; 
    startY = e.touches[0].clientY;
    isPulling = true;
    
    // Reset rạp xiếc về trạng thái ban đầu
    rock.style.display = "block";
    tnt.style.display = "none";
    explosion.style.display = "none";
    goldLoot.style.display = "none";
    miner.style.display = "flex";
    explosion.classList.remove('boom');
    goldLoot.classList.remove('show');
    
    pullContainer.style.transition = 'none';
    miner.style.transform = `translateY(0px)`;
    rope.style.height = "0px";
  }
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  if (!isPulling || isRefreshing) return;

  if (window.scrollY <= 0 && e.touches[0].clientY > startY) {
    if (e.cancelable) e.preventDefault();
  }

  const currentY = e.touches[0].clientY;
  const diff = currentY - startY;

  if (diff > 0 && window.scrollY <= 0) {
    const slideDown = Math.min(diff * 0.5, 180); 
    pullContainer.style.transform = `translateY(${slideDown - 180}px)`;

    const drop = Math.min(diff * 0.45, 80);
    miner.style.transform = `translateY(${drop}px)`;
    rope.style.height = `${drop + 40}px`;

    if (diff > pullThreshold) {
      miner.classList.add('digging');
      textEl.innerText = "Thả tay để châm mìn!";
      textEl.style.color = "#fbbf24"; 
    } else {
      miner.classList.remove('digging');
      textEl.innerText = "Kéo xuống để gọi thợ mỏ...";
      textEl.style.color = "#94a3b8";
    }
  }
}, { passive: false });

window.addEventListener("touchend", (e) => {
  if (!isPulling || isRefreshing) return;
  isPulling = false;
  const diff = e.changedTouches[0].clientY - startY;

  pullContainer.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

  if (diff > pullThreshold) {
    isRefreshing = true;
    pullContainer.style.transform = `translateY(0px)`; 
    
    miner.classList.remove('digging');
    miner.style.display = "none"; 
    rope.style.height = "0px";    
    tnt.style.display = "block";  
    textEl.innerText = "Đang châm ngòi...";
    textEl.style.color = "#ef4444"; 

    load().then(() => {
      // 🧨 BOOM!
      tnt.style.display = "none";
      rock.style.display = "none";
      explosion.style.display = "block";
      goldLoot.style.display = "block";
      
      explosion.classList.add('boom');
      goldLoot.classList.add('show');
      
      textEl.innerText = "BÙM! VÀNG RƠI!!!";
      textEl.style.color = "#10b981"; 

      document.body.classList.add("shake-active");
      if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);

      const cards = document.querySelectorAll('.card');
      cards.forEach(card => {
        card.classList.remove('flash-update');
        void card.offsetWidth;
        card.classList.add('flash-update');
      });

      setTimeout(() => {
        document.body.classList.remove("shake-active");
        pullContainer.style.transform = `translateY(-100%)`; 
        
        setTimeout(() => {
          isRefreshing = false;
          cards.forEach(card => card.classList.remove('flash-update'));
        }, 300);
      }, 1500); 
    });
  } else {
    pullContainer.style.transform = `translateY(-100%)`;
  }
});