/* ================= GLOBAL STATE ================= */
// Load data from LocalStorage or initialize default values for a student
let state = JSON.parse(localStorage.getItem('cyberData')) || {
    income: 0,
    expenses: [],
    goal: { name: "New Laptop", target: 10000 },
    user: null
};

// Chart instances (stored globally to be destroyed/re-created on update)
let pieChart = null;
let lineChart = null;

/* ================= 1. AUTH & NAVIGATION ================= */
function login() {
    const user = document.getElementById("user").value;
    if (!user) return alert("Access Denied: Enter Student ID");

    state.user = user;
    saveState();
    
    document.getElementById("login-page").style.display = "none";
    const dash = document.getElementById("dashboard");
    dash.style.display = "flex";
    setTimeout(() => dash.style.opacity = "1", 10);
    
    renderAll();
}

function show(sectionId) {
    const sections = ['dash', 'goal', 'trans'];
    sections.forEach(s => document.getElementById(s).style.display = "none");
    document.getElementById(sectionId).style.display = "block";
    
    // Update sidebar active state
    document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
    event.currentTarget.classList.add('active');
}

/* ================= 2. CORE FINANCIAL LOGIC ================= */
function setIncome() {
    const amount = Number(document.getElementById("incomeInput").value);
    if (amount <= 0) return alert("Enter a valid amount");

    state.income += amount;
    document.getElementById("incomeInput").value = "";
    saveState();
    renderAll();
}

function addExpense() {
    const cat = document.getElementById("category").value;
    const amt = Number(document.getElementById("amount").value);

    if (amt <= 0) return alert("Amount must be positive");

    const newExpense = {
        id: Date.now(),
        category: cat,
        amount: amt,
        date: new Date().toLocaleDateString()
    };

    state.expenses.push(newExpense);
    document.getElementById("amount").value = "";
    saveState();
    renderAll();
}

function setGoal() {
    state.goal.name = document.getElementById("goalName").value || "Savings";
    state.goal.target = Number(document.getElementById("goalTarget").value) || 1000;
    saveState();
    renderAll();
}

/* ================= 3. THE "BRAIN" (SYNC & RENDER) ================= */
function saveState() {
    localStorage.setItem('cyberData', JSON.stringify(state));
}

function renderAll() {
    const totalExpenses = state.expenses.reduce((sum, e) => sum + e.amount, 0);
    const balance = state.income - totalExpenses;

    // Update Stats
    document.getElementById("balance").innerText = balance.toLocaleString();
    document.getElementById("saved").innerText = Math.max(0, balance).toLocaleString();
    document.getElementById("targetVal").innerText = state.goal.target.toLocaleString();
    document.getElementById("displayGoalName").innerText = state.goal.name;

    // Update Progress Bar
    let progress = (balance / state.goal.target) * 100;
    progress = Math.min(100, Math.max(0, progress));
    document.getElementById("goalBar").style.width = `${progress}%`;

    // Render Lists & AI
    renderTransactions();
    generateAITip(balance, totalExpenses);
    updateCharts(state.expenses);
}

/* ================= 4. STUDENT-CENTRIC AI LOGIC ================= */
function generateAITip(balance, total) {
    const tipEl = document.getElementById("ai-tip");
    const ratio = total / state.income;

    if (state.expenses.length === 0) {
        tipEl.innerText = "System Idle. Waiting for financial input...";
    } else if (balance < 200) {
        tipEl.innerText = "CRITICAL: Low funds. Suggested action: Skip Canteen food today.";
    } else if (ratio > 0.8) {
        tipEl.innerText = "WARNING: You've spent 80% of your allowance. Switch to economy mode.";
    } else {
        tipEl.innerText = "OPTIMAL: Financial health stable. You are on track for your goal.";
    }
}

/* ================= 5. VISUALIZATION (CHARTS) ================= */
function updateCharts(expenses) {
    const ctxPie = document.getElementById("pieChart");
    const ctxLine = document.getElementById("lineChart");
    if (!ctxPie) return;

    // Grouping expenses for Pie Chart
    const groups = expenses.reduce((acc, e) => {
        acc[e.category] = (acc[e.category] || 0) + e.amount;
        return acc;
    }, {});

    if (pieChart) pieChart.destroy();
    if (lineChart) lineChart.destroy();

    pieChart = new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: Object.keys(groups),
            datasets: [{
                data: Object.values(groups),
                backgroundColor: ['#8a2be2', '#00f5ff', '#ff00ff', '#facc15'],
                hoverOffset: 15
            }]
        },
        options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: '#fff' } } } }
    });

    lineChart = new Chart(ctxLine, {
        type: 'line',
        data: {
            labels: expenses.map(e => e.date),
            datasets: [{
                label: 'Spending Trend',
                data: expenses.map(e => e.amount),
                borderColor: '#00f5ff',
                tension: 0.4,
                fill: true,
                backgroundColor: 'rgba(0, 245, 255, 0.1)'
            }]
        },
        options: { maintainAspectRatio: false, scales: { y: { ticks: { color: '#aaa' } } } }
    });
}

function renderTransactions() {
    const list = document.getElementById("transactions");
    list.innerHTML = state.expenses.slice().reverse().map(e => `
        <div class="t-item">
            <span>${e.category} <small>(${e.date})</small></span>
            <span>- ₹${e.amount}</span>
        </div>
    `).join('');
}

/* ================= INITIALIZATION ================= */
// If data already exists (returning user), update UI immediately
if (state.user) {
    renderAll();
}