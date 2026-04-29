const API = "/api/gold";
const HIST_API = "/api/history"; 
const elements = {
  usd: document.getElementById("usd"), xau: document.getElementById("xau"),
  sjc: document.getElementById("sjc"), diff: document.getElementById("diff"),
  percent: document.getElementById("percent"), lastTime: document.getElementById("lastTime"),
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
let isExpanded = false; 
let currentPage = 1;

/* ===== NHẬN REALTIME DỮ LIỆU TỪ SERVER MÀ KHÔNG CẦN RELOAD ===== */
const evtSource = new EventSource("/api/stream");
evtSource.onmessage = (event) => {
  const d = JSON.parse(event.data);
  if (!d || Object.keys(d).length === 0) return;
  
  // Hiệu ứng nháy màu báo có data mới
  elements.lastTime.style.color = "#10b981";
  setTimeout(() => elements.lastTime.style.color = "#64748b", 2000);
  
  renderMain(d);
  if (lastSJCValue === null || d.sjc !== lastSJCValue) {
    lastSJCValue = d.sjc;
    fetchHistory();
  }
};

/* ===== TẢI DỮ LIỆU (CÓ THỂ ÉP BUỘC SERVER CÀO LIỀN) ===== */
async function load(isForce = false) {
  try {
    const forceParam = isForce ? "&force=true" : "";
    const res = await fetch(`${API}?t=${Date.now()}${forceParam}`);
    const d = await res.json();
    if (!d || Object.keys(d).length === 0) return;
    renderMain(d);
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      lastSJCValue = d.sjc;
      await fetchHistory();
    }
  } catch(e) { console.error(e); }
}

function renderMain(d) {
  elements.usd.innerText = fmtVND.format(d.usd);
  elements.xau.innerText = fmtXAU.format(d.xau);
  elements.diff.innerText = fmtVND.format(d.diff);
  elements.percent.innerText = d.percent;
  const key = "sjcMorning_" + new Date().toISOString().slice(0,10);
  let morning = localStorage.getItem(key) || localStorage.setItem(key, d.sjc) || d.sjc;
  const change = d.sjc - parseFloat(morning);
  const isUp = change >= 0;
  elements.sjc.innerHTML = `<div>${fmtVND.format(d.sjc)}</div><div class="sjc-sub ${isUp ? 'change-up' : 'change-down'}">${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}</div>`;
  const updateTime = new Date(d.updatedAt);
  const timeStr = isNaN(updateTime) ? new Date().toLocaleTimeString('vi-VN') : updateTime.toLocaleTimeString('vi-VN');
  elements.lastTime.innerHTML = `${d.status === "Delayed" ? "🟡 Tạm thời (Fallback)" : "🟢 Live"} - Cập nhật: ${timeStr}`;
}

async function fetchHistory() {
  try {
    const res = await fetch(HIST_API);
    historyData = await res.json(); 
    currentData = [...historyData]; 
    renderTable(); 
    updateChart(currentData);
  } catch(e) { console.error(e); }
}

function formatVNDateTime(isoString) {
  const d = new Date(isoString);
  if (isNaN(d)) return "--";
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute:'2-digit' });
}

function renderTable() {
  const pageSize = isExpanded ? 20 : 10;
  const startIdx = isExpanded ? (currentPage - 1) * pageSize : 0;
  const endIdx = startIdx + pageSize;
  const displayData = currentData.slice(startIdx, endIdx);
  const displayStyle = isExpanded ? "table-cell" : "none";
  document.getElementById('selectAll').checked = false;

  // 1. Tạo một biến chuỗi rỗng để gom mã HTML
  let htmlString = "";

  // 2. Chạy vòng lặp để nối các dòng thành 1 cục chuỗi duy nhất
  displayData.forEach(r => {
    htmlString += `
      <tr>
        <td>${formatVNDateTime(r.createdAt)}</td>
        <td>${fmtXAU.format(r.xau)}</td>
        <td>${fmtVND.format(r.sjc)}</td>
        <td>${fmtVND.format(r.diff)}</td>
        <td><span class="badge ${r.percent.includes('-') ? 'badge-down' : 'badge-up'}">${r.percent}</span></td>
        <td class="col-action" style="display: ${displayStyle}; text-align: center;">
          <input type="checkbox" class="log-checkbox" value="${r._id}">
        </td>
      </tr>
    `;
  });

  // 3. Chèn 1 lần duy nhất vào bảng
  elements.historyTable.innerHTML = htmlString;
  
  renderPagination();
}

function renderPagination() {
  const pag = elements.pagination;
  if (!isExpanded || currentData.length <= 20) { pag.style.display = "none"; return; }
  pag.style.display = "flex"; pag.innerHTML = "";
  const totalPages = Math.ceil(currentData.length / 20);
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
  renderTable();
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

function updateChart(data) {
  const chartCanvas = document.getElementById('gapChart');
  const ctx = chartCanvas.getContext('2d');
  const reversedData = [...data].reverse();
  const totalPoints = reversedData.length;

  // Cấu hình: Hiển thị đúng 10 điểm trên một chiều rộng màn hình
  const pointsOnScreen = 10;
  const dynamicWidth = Math.max(100, (totalPoints / pointsOnScreen) * 100);
  
  // Ép chiều rộng wrapper để tạo thanh cuộn ngang
  const wrapper = chartCanvas.parentElement;
  wrapper.style.setProperty('width', dynamicWidth + '%', 'important');
  wrapper.style.setProperty('min-width', dynamicWidth + '%', 'important');

  const labels = reversedData.map(r => {
    const d = new Date(r.createdAt);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  });
  const gaps = reversedData.map(r => r.diff / 1000000);

  if (myChart) {
    myChart.data.labels = labels;
    myChart.data.datasets[0].data = gaps;
    myChart.update();
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
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            // Tự động điều chỉnh khoảng giá trị dựa trên dữ liệu (Tối giản)
            beginAtZero: false,
            ticks: {
              maxTicksLimit: 6, // Chỉ hiển thị tối đa 6 mốc giá trị để cột Y không bị dày
              callback: (val) => val.toFixed(1) + 'M',
              color: '#64748b',
              font: { size: 11 }
            },
            grid: { color: 'rgba(226, 232, 240, 0.6)' }
          },
          x: {
            ticks: { autoSkip: false, color: '#64748b', font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });
  }
  // Cuộn về phía dữ liệu mới nhất (bên phải cùng)
  const container = document.querySelector('.chart-scroll-container');
  setTimeout(() => { container.scrollLeft = container.scrollWidth; }, 200);
}

/* KHỞI CHẠY LẦN ĐẦU (F5) SẼ YÊU CẦU SERVER ÉP CÀO LẠI (FORCE = TRUE) */
load(true);

/* Đổi nút button Update chạy thành Force Mode: onclick="load(true)" (Hãy cập nhật html phía trên) */
document.getElementById("updateBtn").onclick = () => load(true);


/* ===== HIỆU ỨNG PULL TO REFRESH ===== */
const style = document.createElement('style');
style.innerHTML = `
  .cyber-pull-container {
    position: fixed; top: -80px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 15px;
    background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(10px);
    padding: 12px 24px; border-radius: 40px;
    border: 1px solid rgba(59, 130, 246, 0.3);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 9999;
    transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.3s, box-shadow 0.3s;
    pointer-events: none;
  }
  .cyber-pull-container.ready {
    border-color: rgba(16, 185, 129, 0.8); box-shadow: 0 0 25px rgba(16, 185, 129, 0.2);
  }
  .pulse-bars { display: flex; gap: 4px; align-items: flex-end; height: 24px; }
  .pulse-bar {
    width: 5px; height: 4px; border-radius: 2px;
    background: #3b82f6; transition: background 0.3s;
  }
  .cyber-pull-container.ready .pulse-bar { background: #10b981; }
  .cyber-pull-container.refreshing .pulse-bar {
    background: #10b981; animation: pulseWave 0.5s ease-in-out infinite alternate;
  }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(1) { animation-delay: 0.0s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(2) { animation-delay: 0.1s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(3) { animation-delay: 0.2s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(4) { animation-delay: 0.3s; }

  @keyframes pulseWave {
    0% { height: 4px; box-shadow: none; }
    100% { height: 24px; box-shadow: 0 0 10px #10b981; }
  }

  .cyber-text {
    color: #94a3b8; font-size: 14px; font-weight: 600; font-family: 'Inter', sans-serif;
    transition: color 0.3s;
  }
  .cyber-pull-container.ready .cyber-text { color: #10b981; text-shadow: 0 0 8px rgba(16,185,129,0.4); }
`;
document.head.appendChild(style);

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

let startY = 0; 
let isPulling = false;
let isRefreshing = false;
const pullThreshold = 120; 
const textEl = pullContainer.querySelector('.cyber-text');
const bars = [
  document.getElementById('bar1'), document.getElementById('bar2'),
  document.getElementById('bar3'), document.getElementById('bar4')
];
const targetHeights = [12, 24, 16, 20]; 

window.addEventListener("touchstart", (e) => { 
  if (window.scrollY <= 0 && !isRefreshing) { startY = e.touches[0].clientY; isPulling = true; } 
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  if (!isPulling || isRefreshing) return;
  const diff = e.touches[0].clientY - startY;
  
  if (diff > 0 && window.scrollY <= 0) {
    if (e.cancelable) e.preventDefault();
    const moveY = Math.min(diff * 0.4, 90); 
    pullContainer.style.top = `${-80 + moveY}px`;
    const pullRatio = Math.min(diff / pullThreshold, 1);
    
    bars.forEach((bar, index) => {
      bar.style.height = `${4 + (targetHeights[index] - 4) * pullRatio}px`;
    });
    
    if (diff > pullThreshold) {
      pullContainer.classList.add('ready'); textEl.innerText = "Thả tay để tải mới!";
    } else {
      pullContainer.classList.remove('ready'); textEl.innerText = "Kéo thêm chút nữa...";
    }
  }
}, { passive: false });

window.addEventListener("touchend", (e) => {
  if (!isPulling || isRefreshing) return;
  isPulling = false;
  const diff = e.changedTouches[0].clientY - startY;
  
  bars.forEach(bar => bar.style.height = '');
  
  if (diff > pullThreshold) {
    isRefreshing = true;
    pullContainer.classList.remove('ready');
    pullContainer.classList.add('refreshing');
    pullContainer.style.top = "20px"; 
    textEl.innerText = "Updating...";
    
    // Yêu cầu tải dữ liệu dạng FORCE (ép gọi updateData)
    load(true).then(() => {
      textEl.innerText = "Success!";
      pullContainer.classList.remove('refreshing');
      pullContainer.classList.add('ready');
      bars.forEach((bar, idx) => bar.style.height = `${targetHeights[idx]}px`);
      
      setTimeout(() => { 
        pullContainer.style.top = "-80px"; 
        setTimeout(() => { 
          isRefreshing = false; pullContainer.classList.remove('ready');
        }, 300);
      }, 1200);
    });
  } else {
    pullContainer.style.top = "-80px";
  }
});
// ... (code cũ) ...
  } else {
    pullContainer.style.top = "-80px";
  }
});

/* ===== ĐĂNG KÝ PWA (SERVICE WORKER) ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        console.log('PWA Service Worker đăng ký thành công:', registration.scope);
      })
      .catch((error) => {
        console.log('Lỗi đăng ký Service Worker:', error);
      });
  });
}