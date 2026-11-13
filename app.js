import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
    getDatabase,
    ref,
    onValue,
    query,
    orderByChild,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

// ====================================================
// 1. KONFIGURASI FIREBASE REALTIME DATABASE
// ====================================================
const firebaseConfig = {
    apiKey: "AIzaSyC8FvsNe7No_vmDGfBQ1rLFEv5JhQ8B4Yc",
    authDomain: "smart-compost-3b1a9.firebaseapp.com",
    databaseURL: "https://smart-compost-3b1a9-default-rtdb.firebaseio.com",
    projectId: "smart-compost-3b1a9",
    storageBucket: "smart-compost-3b1a9.firebasestorage.app",
    messagingSenderId: "167560189302",
    appId: "1:167560189302:web:e04f27397d21e3d76a1657"
};

// ====================================================
// 2. INISIALISASI FIREBASE
// ====================================================
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// ====================================================
// 3. REFERENSI DATABASE REALTIME
// Mendukung format langsung dari ESP32 ('smartcompost')
// maupun format terstruktur ('smart_compost/latest')
// ====================================================
const espLiveRef = ref(database, "smartcompost");
const structuredLatestRef = ref(database, "smart_compost/latest");

const settingsRef = ref(database, "smart_compost/settings");
const structuredHistoryRef = query(
    ref(database, "smart_compost/history"),
    orderByChild("timestamp"),
    limitToLast(25)
);

const connectionRef = ref(database, ".info/connected");

// Batas ambang default jika settings di database belum tersedia
let settings = {
    minMoisture: 40,
    maxMoisture: 70
};

// Flag jika database menyediakan node history tersendiri
let hasDatabaseHistory = false;

// Buffer histori live lokal (agar grafik dan tabel langsung bergerak meskipun ESP32 belum membuat node history)
let liveHistoryBuffer = [];
try {
    const saved = localStorage.getItem("composense_live_history");
    if (saved) liveHistoryBuffer = JSON.parse(saved);
} catch (e) {
    liveHistoryBuffer = [];
}

// ====================================================
// 4. ELEMEN DASHBOARD DOM
// ====================================================
const temperatureElement = document.getElementById("temperature");
const airHumidityElement = document.getElementById("airHumidity");
const compostMoistureElement = document.getElementById("compostMoisture");

const statusElement = document.getElementById("compostStatus");
const recommendationElement = document.getElementById("recommendation");
const lastUpdateElement = document.getElementById("lastUpdate");

const historyTable = document.getElementById("historyTable");

const connectionDot = document.getElementById("connectionDot");
const connectionText = document.getElementById("connectionText");

// ====================================================
// 5. HELPER: VALIDASI ANGKA SENSOR
// ====================================================
function isValidNumber(val) {
    if (val === null || val === undefined || val === "") return false;
    const num = Number(val);
    return Number.isFinite(num) && !Number.isNaN(num);
}

// ====================================================
// 6. HELPER: FORMAT WAKTU KRONOLOGIS
// ====================================================
function formatTime(timestamp) {
    if (!timestamp) return "--";

    const num = Number(timestamp);
    if (Number.isNaN(num) || num <= 0) return "--";

    const date = new Date(num > 1e11 ? num : num * 1000);

    if (Number.isNaN(date.getTime())) return "--";

    return date.toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

// ====================================================
// 7. NORMALISASI DATA (ESP32 VS TERSTRUKTUR)
// Memetakan 'suhu', 'kelembapan_udara', 'nilai_soil'
// serta konversi otomatis ADC ESP32 (0-4095) -> Persen (0-100%)
// ====================================================
function normalizeSensorPayload(raw) {
    if (!raw || typeof raw !== "object") return null;

    // Suhu: dukung 'suhu' (dari ESP32) atau 'airTemperature' / 'temp'
    const tempRaw = raw.suhu ?? raw.airTemperature ?? raw.temp ?? raw.temperature;
    const airTemperature = isValidNumber(tempRaw) ? Number(tempRaw) : null;

    // Kelembapan Udara: dukung 'kelembapan_udara' (dari ESP32) atau 'airHumidity' / 'humidity'
    const humRaw = raw.kelembapan_udara ?? raw.airHumidity ?? raw.humidity;
    const airHumidity = isValidNumber(humRaw) ? Number(humRaw) : null;

    // Kelembapan Kompos: dukung 'nilai_soil' (dari ESP32) atau 'compostMoisture' / 'soil'
    const soilRaw = raw.nilai_soil ?? raw.compostMoisture ?? raw.soilMoisture ?? raw.soil;
    let compostMoisture = null;
    let rawSoilADC = null;

    if (isValidNumber(soilRaw)) {
        const num = Number(soilRaw);
        if (num <= 100) {
            // Nilai sudah berupa persentase (0 - 100%)
            compostMoisture = Math.max(0, Math.min(100, Math.round(num)));
        } else {
            // Nilai raw ADC ESP32 12-bit (0 - 4095)
            rawSoilADC = num;
            // Kalibrasi standar sensor tanah kapasitif/resistif ESP32:
            // ADC >= 4090: Sensor di udara kering / belum ditancapkan ke media kompos (0%)
            // ADC <= 1400: Terbenam di air basah maksimal (100%)
            const percent = Math.max(0, Math.min(100, Math.round(((4095 - num) / (4095 - 1400)) * 100)));
            compostMoisture = percent;
        }
    }

    const timestamp = raw.timestamp ?? Math.floor(Date.now() / 1000);
    const status = raw.status ?? null;
    const recommendation = raw.recommendation ?? null;

    return {
        airTemperature,
        airHumidity,
        compostMoisture,
        rawSoilADC,
        timestamp,
        status,
        recommendation
    };
}

// ====================================================
// 8. LOGIKA STATUS & REKOMENDASI ADAPTIF (SENSOR PARSIAL)
// ====================================================
function evaluateAdaptiveCondition(data) {
    const hasMoisture = isValidNumber(data.compostMoisture);
    const hasTemp = isValidNumber(data.airTemperature);
    const hasAirHum = isValidNumber(data.airHumidity);

    // KONDISI 1: Sensor kelembapan kompos aktif & valid
    if (hasMoisture) {
        const moisture = Number(data.compostMoisture);

        if (moisture < settings.minMoisture) {
            let note = `Kelembapan kompos (${Math.round(moisture)}%) berada di bawah target (${settings.minMoisture}%). Tambahkan air secara bertahap atau bahan organik basah.`;
            if (data.rawSoilADC && data.rawSoilADC >= 4090) {
                note += " (ADC 4095: Sensor membaca kondisi kering atau probe belum ditancapkan ke kompos).";
            }
            return {
                status: "Terlalu Kering",
                recommendation: note
            };
        }

        if (moisture > settings.maxMoisture) {
            return {
                status: "Terlalu Basah",
                recommendation: `Kelembapan kompos (${Math.round(moisture)}%) berada di atas target (${settings.maxMoisture}%). Lakukan pembalikan/aerasi atau campurkan bahan kering (daun/sekam).`
            };
        }

        // Dalam rentang target
        if (hasTemp && Number(data.airTemperature) >= 45) {
            return {
                status: "Fase Termofilik Optimal",
                recommendation: `Kondisi kompos prima! Suhu aktif (${Number(data.airTemperature).toFixed(1)}°C) dan kelembapan ideal (${Math.round(moisture)}%). Dekomposisi bakteri berlangsung pesat.`
            };
        }

        return {
            status: "Dalam Rentang Target",
            recommendation: `Kelembapan kompos optimal (${Math.round(moisture)}%). Sistem pengomposan berada dalam kondisi ideal, lanjutkan pemantauan berkala.`
        };
    }

    // KONDISI 2: Sensor kelembapan kompos belum terpasang, namun sensor lingkungan (DHT22) aktif
    if (hasTemp || hasAirHum) {
        const parts = [];
        if (hasTemp) parts.push(`Suhu Udara: ${Number(data.airTemperature).toFixed(1)}°C`);
        if (hasAirHum) parts.push(`Kelembapan Udara: ${Math.round(Number(data.airHumidity))}%`);

        return {
            status: "Data Parsial",
            recommendation: `Sensor lingkungan aktif (${parts.join(", ")}). Menunggu sensor kelembapan kompos (soil probe) terhubung untuk diagnosis kondisi kompos lengkap.`
        };
    }

    // KONDISI 3: Belum ada data sensor dari modul ESP32
    return {
        status: "Menunggu Sensor",
        recommendation: "Belum ada data sensor dari modul ESP32. Hubungkan perangkat keras IoT Anda untuk memulai pemantauan."
    };
}

// ====================================================
// 9. RENDER DATA REAL-TIME KE DASHBOARD
// ====================================================
function renderDashboard(normalized) {
    if (!normalized) return;

    // Render Suhu Udara
    if (temperatureElement) {
        temperatureElement.textContent = isValidNumber(normalized.airTemperature)
            ? Number(normalized.airTemperature).toFixed(1)
            : "--";
    }

    // Render Kelembapan Udara
    if (airHumidityElement) {
        airHumidityElement.textContent = isValidNumber(normalized.airHumidity)
            ? Math.round(Number(normalized.airHumidity)).toString()
            : "--";
    }

    // Render Kelembapan Kompos
    if (compostMoistureElement) {
        compostMoistureElement.textContent = isValidNumber(normalized.compostMoisture)
            ? Math.round(Number(normalized.compostMoisture)).toString()
            : "--";
    }

    // Evaluasi status & rekomendasi
    const condition = evaluateAdaptiveCondition(normalized);
    const hasMoisture = isValidNumber(normalized.compostMoisture);

    if (statusElement) {
        statusElement.textContent = (hasMoisture && normalized.status) ? normalized.status : condition.status;
    }

    if (recommendationElement) {
        recommendationElement.textContent = (hasMoisture && normalized.recommendation) ? normalized.recommendation : condition.recommendation;
    }

    if (lastUpdateElement) {
        lastUpdateElement.textContent = formatTime(normalized.timestamp);
    }

    // Perbarui indikator kartu sensor (aktif vs belum terpasang)
    if (typeof window.updateSensorCardPills === "function") {
        window.updateSensorCardPills();
    }

    // Rekam ke buffer histori live jika database belum memiliki riwayat
    appendLiveHistory(normalized);
}

// ====================================================
// 10. BUFFER HISTORI LIVE OTOMATIS
// ====================================================
function appendLiveHistory(normalized) {
    if (hasDatabaseHistory) return;

    const hasAny = isValidNumber(normalized.airTemperature) || 
                   isValidNumber(normalized.airHumidity) || 
                   isValidNumber(normalized.compostMoisture);
    if (!hasAny) return;

    const now = normalized.timestamp || Math.floor(Date.now() / 1000);
    const last = liveHistoryBuffer[liveHistoryBuffer.length - 1];

    // Simpan titik baru jika selang waktu minimal 5 detik atau nilai berubah
    if (!last || (now - last.timestamp >= 5) ||
        last.airTemperature !== normalized.airTemperature ||
        last.airHumidity !== normalized.airHumidity ||
        last.compostMoisture !== normalized.compostMoisture) {

        liveHistoryBuffer.push({
            timestamp: now,
            airTemperature: normalized.airTemperature,
            airHumidity: normalized.airHumidity,
            compostMoisture: normalized.compostMoisture
        });

        if (liveHistoryBuffer.length > 25) {
            liveHistoryBuffer.shift();
        }

        try {
            localStorage.setItem("composense_live_history", JSON.stringify(liveHistoryBuffer));
        } catch (e) {}
    }

    // Kirim data ke grafik interaktif Chart.js dan tabel
    if (typeof window.updateHistoryChart === "function") {
        window.updateHistoryChart(liveHistoryBuffer);
    }
    renderTable(liveHistoryBuffer);
}

function renderTable(records) {
    if (!historyTable) return;
    historyTable.replaceChildren();

    if (!records || records.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 4;
        cell.textContent = "Belum ada riwayat monitoring.";
        row.appendChild(cell);
        historyTable.appendChild(row);
        return;
    }

    const tableRecords = [...records].reverse();
    tableRecords.forEach((data) => {
        const row = document.createElement("tr");

        const tempDisplay = isValidNumber(data.airTemperature)
            ? `${Number(data.airTemperature).toFixed(1)}°C`
            : "--";

        const humDisplay = isValidNumber(data.airHumidity)
            ? `${Math.round(Number(data.airHumidity))}%`
            : "--";

        const compostDisplay = isValidNumber(data.compostMoisture)
            ? `${Math.round(Number(data.compostMoisture))}%`
            : "--";

        const values = [
            formatTime(data.timestamp),
            tempDisplay,
            humDisplay,
            compostDisplay
        ];

        values.forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
        });

        historyTable.appendChild(row);
    });
}

// ====================================================
// 11. LISTENER FIREBASE
// ====================================================

// A. Membaca pengaturan (settings)
onValue(settingsRef, (snapshot) => {
    if (snapshot.exists()) {
        const data = snapshot.val();
        if (isValidNumber(data.minMoisture)) settings.minMoisture = Number(data.minMoisture);
        if (isValidNumber(data.maxMoisture)) settings.maxMoisture = Number(data.maxMoisture);
    }
}, (error) => {
    console.warn("Settings belum tersedia:", error.message);
});

// B. Membaca data realtime dari ESP32 ('smartcompost')
onValue(espLiveRef, (snapshot) => {
    if (snapshot.exists()) {
        const raw = snapshot.val();
        const normalized = normalizeSensorPayload(raw);
        renderDashboard(normalized);
    }
}, (error) => {
    console.error("Gagal membaca node 'smartcompost':", error);
    if (statusElement) statusElement.textContent = "Akses Ditolak (Rules)";
    if (recommendationElement) {
        recommendationElement.textContent = "Firebase menolak izin baca (Permission Denied). Harap ubah aturan '.read': true di Firebase Console.";
    }
});

// C. Fallback: Membaca format alternatif ('smart_compost/latest')
onValue(structuredLatestRef, (snapshot) => {
    if (snapshot.exists()) {
        const raw = snapshot.val();
        const normalized = normalizeSensorPayload(raw);
        renderDashboard(normalized);
    }
}, (error) => {
    console.warn("Fallback structuredLatestRef:", error.message);
});

// D. Membaca riwayat sensor dari database ('smart_compost/history')
onValue(structuredHistoryRef, (snapshot) => {
    if (snapshot.exists()) {
        hasDatabaseHistory = true;
        const records = [];
        snapshot.forEach((childSnapshot) => {
            records.push(childSnapshot.val());
        });

        if (typeof window.updateHistoryChart === "function") {
            window.updateHistoryChart(records);
        }
        renderTable(records);
    }
}, (error) => {
    console.warn("Database history belum tersedia:", error.message);
});

// E. Status koneksi Firebase (Wi-Fi Icon Navbar)
onValue(connectionRef, (snapshot) => {
    const connected = snapshot.exists() && snapshot.val() === true;

    if (connectionDot) {
        connectionDot.style.background = connected ? "#28a745" : "#9ca3af";
    }

    if (connectionText) {
        connectionText.textContent = connected ? "Terhubung ke Firebase" : "Tidak terhubung";
    }

    if (typeof window.updateConnectionUI === "function") {
        window.updateConnectionUI(connected);
    }
});
