
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
    getDatabase,
    ref,
    onValue,
    query,
    orderByChild,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

// 1. KONFIGURASI FIREBASE

const firebaseConfig = {
    apiKey: "AIzaSyC8FvsNe7No_vmDGfBQ1rLFEv5JhQ8B4Yc",
    authDomain: "smart-compost-3b1a9.firebaseapp.com",
    databaseURL: "https://smart-compost-3b1a9-default-rtdb.firebaseio.com",
    projectId: "smart-compost-3b1a9",
    storageBucket: "smart-compost-3b1a9.firebasestorage.app",
    messagingSenderId: "167560189302",
    appId: "1:167560189302:web:e04f27397d21e3d76a1657"
};


// 2. INISIALISASI FIREBASE
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// 3. REFERENSI DATABASE
const latestRef = ref(database, "smart_compost/latest");
const settingsRef = ref(database, "smart_compost/settings");
const historyRef = query(
    ref(database, "smart_compost/history"),
    orderByChild("timestamp"),
    limitToLast(20)
);

const connectionRef = ref(database, ".info/connected");

// Nilai batas default jika settings belum tersedia
let settings = {
    minMoisture: 40,
    maxMoisture: 70
};

// 4. ELEMEN DASHBOARD
const temperatureElement = document.getElementById("temperature");
const airHumidityElement = document.getElementById("airHumidity");
const compostMoistureElement = document.getElementById("compostMoisture");

const statusElement = document.getElementById("compostStatus");
const recommendationElement = document.getElementById("recommendation");
const lastUpdateElement = document.getElementById("lastUpdate");

const historyTable = document.getElementById("historyTable");

const connectionDot = document.getElementById("connectionDot");
const connectionText = document.getElementById("connectionText");

// 5. FORMAT WAKTU
function formatTime(timestamp) {
    if (!timestamp) return "--";

    const num = Number(timestamp);
    if (Number.isNaN(num) || num <= 0) return "--";

    // Deteksi otomatis: Unix detik (10 digit ~ 1e9) vs milidetik (13 digit ~ 1e12)
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

// 6. STATUS DAN REKOMENDASI
function getCondition(moisture) {
    if (moisture === null || moisture === undefined ||
        !Number.isFinite(Number(moisture))) {
        return {
            status: "Data Tidak Valid",
            recommendation: "Periksa sensor kelembapan kompos."
        };
    }

    const value = Number(moisture);

    if (value < settings.minMoisture) {
        return {
            status: "Terlalu Kering",
            recommendation:
                "Kelembapan berada di bawah batas yang ditentukan. Periksa material kompos dan pertimbangkan penambahan air secara bertahap."
        };
    }

    if (value > settings.maxMoisture) {
        return {
            status: "Terlalu Basah",
            recommendation:
                "Kelembapan berada di atas batas yang ditentukan. Periksa kondisi kompos dan pastikan sirkulasi udara cukup."
        };
    }

    return {
        status: "Dalam Rentang Target",
        recommendation:
            "Kelembapan berada dalam rentang target yang telah ditentukan. Lanjutkan pemantauan secara berkala."
    };
}

// 7. MEMBACA PENGATURAN
onValue(settingsRef, (snapshot) => {
    if (snapshot.exists()) {
        const data = snapshot.val();

        settings.minMoisture =
            Number(data.minMoisture ?? 40);

        settings.maxMoisture =
            Number(data.maxMoisture ?? 70);
    }
});

// 8. MEMBACA DATA SENSOR TERBARU
onValue(latestRef, (snapshot) => {
    if (!snapshot.exists()) {
        recommendationElement.textContent =
            "Belum ada data sensor dari ESP32.";
        return;
    }

    const data = snapshot.val();

    // Tampilkan data sensor
    temperatureElement.textContent =
        data.airTemperature ?? "--";

    airHumidityElement.textContent =
        data.airHumidity ?? "--";

    compostMoistureElement.textContent =
        data.compostMoisture ?? "--";

    // Status dari Firebase atau hasil perhitungan lokal
    const condition = getCondition(data.compostMoisture);

    statusElement.textContent =
        data.status || condition.status;

    recommendationElement.textContent =
        data.recommendation || condition.recommendation;

    lastUpdateElement.textContent =
        formatTime(data.timestamp);
});

// 9. MEMBACA RIWAYAT SENSOR
onValue(historyRef, (snapshot) => {
    historyTable.replaceChildren();

    if (!snapshot.exists()) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 4;
        cell.textContent = "Belum ada riwayat monitoring.";

        row.appendChild(cell);
        historyTable.appendChild(row);

        if (typeof window.updateHistoryChart === "function") {
            window.updateHistoryChart([]);
        }
        return;
    }

    const records = [];

    snapshot.forEach((childSnapshot) => {
        records.push(childSnapshot.val());
    });

    // Kirim data kronologis ke grafik interaktif
    if (typeof window.updateHistoryChart === "function") {
        window.updateHistoryChart(records);
    }

    // Tampilkan data terbaru di urutan paling atas untuk tabel
    const tableRecords = [...records].reverse();

    tableRecords.forEach((data) => {
        const row = document.createElement("tr");

        const values = [
            formatTime(data.timestamp),
            data.airTemperature ?? "--",
            data.airHumidity ?? "--",
            data.compostMoisture ?? "--"
        ];

        values.forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
        });

        historyTable.appendChild(row);
    });
});

// 10. STATUS KONEKSI FIREBASE
onValue(connectionRef, (snapshot) => {
    const connected = snapshot.val() === true;

    if (connectionDot) {
        connectionDot.style.background =
            connected ? "#28a745" : "#9ca3af";
    }

    if (connectionText) {
        connectionText.textContent =
            connected ? "Terhubung ke Firebase" : "Tidak terhubung";
    }

    // Sinkronisasi status icon navbar (terhubung / tercoret abu-abu)
    if (typeof window.updateConnectionUI === "function") {
        window.updateConnectionUI(connected);
    }
});
