"use strict";

const MESSAGE_TARGET_ORIGIN = "*";
const ENDPOINT_1 = "/api/v1/estore/onboarding-step1";
const ENDPOINT_2 = "/api/v1/estore/onboarding-step2";
const ZKX_DB_NAME = "zkx_qx7_db";

const handleRequest = async (endpoint, headers) => {
  const rockmanId = "1234567890"; //pac_analytics?.visitor?.rockmanId;

  return await fetch(`${endpoint}?rockmanId=${rockmanId}`, {
    headers,
  });
};

const Qx7Storage = {
  QX7_ID_KEY: "zkx_qx7_id",
  BACKUP_KEYS: ["qx7_id_backup", "session_data"],
  STORAGE_PRIORITIES: [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "cookies",
    "serviceWorker",
  ],

  async getQx7Id() {
    for (const method of this.STORAGE_PRIORITIES) {
      try {
        const id = await this[
          `getFrom${method.charAt(0).toUpperCase() + method.slice(1)}`
        ]();
        if (id && this.isValidQx7Id(id)) {
          return id;
        }
      } catch (e) {
        if (method === "indexedDB") {
          this.STORAGE_PRIORITIES = this.STORAGE_PRIORITIES.filter(
            (m) => m !== "indexedDB"
          );
        }
      }
    }
    return null;
  },

  async setQx7Id(qx7Id, options = {}) {
    if (!this.isValidQx7Id(qx7Id)) {
      return false;
    }

    const { priority = "all", ttl = 365 * 24 * 60 * 60 * 1000 } = options;
    const timestamp = Date.now();
    const metadata = { timestamp, ttl, version: "2.0" };

    const storagePromises = [];

    if (priority === "all" || priority === "localStorage") {
      storagePromises.push(this.storeInLocalStorage(qx7Id, metadata));
    }

    if (priority === "all" || priority === "sessionStorage") {
      storagePromises.push(this.storeInSessionStorage(qx7Id, metadata));
    }

    if (
      (priority === "all" || priority === "indexedDB") &&
      this.STORAGE_PRIORITIES.includes("indexedDB")
    ) {
      storagePromises.push(this.storeInIndexedDB(qx7Id, metadata));
    }

    if (priority === "all" || priority === "cookies") {
      storagePromises.push(this.storeInCookies(qx7Id, metadata));
    }

    if (priority === "all" || priority === "serviceWorker") {
      storagePromises.push(this.storeInServiceWorker(qx7Id, metadata));
    }

    try {
      const results = await Promise.allSettled(storagePromises);
      const successful = results.filter(
        (result) => result.status === "fulfilled" && result.value === true
      ).length;
      return successful > 0;
    } catch (e) {
      return false;
    }
  },

  async storeInLocalStorage(qx7Id, metadata) {
    try {
      localStorage.setItem(this.QX7_ID_KEY, qx7Id);

      for (const key of this.BACKUP_KEYS) {
        localStorage.setItem(key, qx7Id);
      }

      localStorage.setItem(`${this.QX7_ID_KEY}_meta`, JSON.stringify(metadata));

      const expires = Date.now() + metadata.ttl;
      localStorage.setItem(`${this.QX7_ID_KEY}_expires`, expires.toString());

      return true;
    } catch (e) {
      return false;
    }
  },

  getFromLocalStorage() {
    try {
      const id = localStorage.getItem(this.QX7_ID_KEY);
      if (!id) return null;

      const expires = localStorage.getItem(`${this.QX7_ID_KEY}_expires`);
      if (expires && Date.now() > parseInt(expires)) {
        this.cleanupExpiredStorage();
        return null;
      }

      return id;
    } catch (e) {
      return null;
    }
  },

  async storeInSessionStorage(qx7Id, metadata) {
    try {
      sessionStorage.setItem(this.QX7_ID_KEY, qx7Id);
      sessionStorage.setItem(
        `${this.QX7_ID_KEY}_meta`,
        JSON.stringify(metadata)
      );
      return true;
    } catch (e) {
      return false;
    }
  },

  getFromSessionStorage() {
    try {
      return sessionStorage.getItem(this.QX7_ID_KEY);
    } catch (e) {
      return null;
    }
  },

  async storeInIndexedDB(qx7Id, metadata) {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(ZKX_DB_NAME, 2);

        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;

          if (!db.objectStoreNames.contains("qx7data")) {
            const qx7Store = db.createObjectStore("qx7data", {
              keyPath: "id",
            });
            qx7Store.createIndex("timestamp", "timestamp", {
              unique: false,
            });
            qx7Store.createIndex("version", "version", { unique: false });
          }

          if (!db.objectStoreNames.contains("metadata")) {
            db.createObjectStore("metadata", { keyPath: "key" });
          }
        };

        request.onsuccess = (e) => {
          const db = e.target.result;

          if (db.version < 2) {
            reject(new Error("Database version mismatch"));
            return;
          }

          try {
            const transaction = db.transaction(
              ["qx7data", "metadata"],
              "readwrite"
            );

            const qx7Store = transaction.objectStore("qx7data");
            const metadataStore = transaction.objectStore("metadata");

            qx7Store.put({
              id: qx7Id,
              timestamp: metadata.timestamp,
              version: metadata.version,
            });

            metadataStore.put({
              key: "current_qx7",
              ...metadata,
            });

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
          } catch (error) {
            reject(error);
          }
        };
      });
    } catch (e) {
      return false;
    }
  },

  async getFromIndexedDB() {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(ZKX_DB_NAME, 2);

        request.onerror = () => reject(request.error);
        request.onsuccess = (e) => {
          const db = e.target.result;

          if (db.version < 2) {
            resolve(null);
            return;
          }

          try {
            if (!db.objectStoreNames.contains("qx7data")) {
              resolve(null);
              return;
            }

            const transaction = db.transaction(["qx7data"], "readonly");
            const store = transaction.objectStore("qx7data");

            const getAllRequest = store.getAll();

            getAllRequest.onsuccess = () => {
              if (getAllRequest.result && getAllRequest.result.length > 0) {
                const sortedResults = getAllRequest.result.sort(
                  (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
                );
                resolve(sortedResults[0].id);
              } else {
                resolve(null);
              }
            };

            getAllRequest.onerror = () => {
              resolve(null);
            };

            transaction.onerror = () => {
              resolve(null);
            };
          } catch (error) {
            resolve(null);
          }
        };
      });
    } catch (e) {
      return null;
    }
  },

  async storeInCookies(qx7Id, metadata) {
    try {
      const expires = new Date(Date.now() + metadata.ttl);
      const cookieValue = `${qx7Id}|${metadata.timestamp}|${metadata.version}`;
      document.cookie = `${this.QX7_ID_KEY}=${encodeURIComponent(
        cookieValue
      )}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
      return true;
    } catch (e) {
      return false;
    }
  },

  getFromCookies() {
    try {
      const cookies = document.cookie.split(";");
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split("=");
        if (name === this.QX7_ID_KEY && value) {
          const [id, timestamp, version] = decodeURIComponent(value).split("|");
          if (id && this.isValidQx7Id(id)) {
            return id;
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  async storeInServiceWorker(qx7Id, metadata) {
    try {
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "STORE_QX7_ID",
          qx7Id,
          metadata,
        });
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  getFromServiceWorker() {
    return null;
  },

  isValidQx7Id(id) {
    return (
      id && typeof id === "string" && id.length >= 16 && /^[a-f0-9]+$/i.test(id)
    );
  },

  cleanupExpiredStorage() {
    try {
      for (const key of [this.QX7_ID_KEY, ...this.BACKUP_KEYS]) {
        const expires = localStorage.getItem(`${key}_expires`);
        if (expires && Date.now() > parseInt(expires)) {
          localStorage.removeItem(key);
          localStorage.removeItem(`${key}_meta`);
          localStorage.removeItem(`${key}_expires`);
        }
      }
    } catch (e) {}
  },

  async syncWithOtherDomains(qx7Id) {
    try {
      if (window.parent !== window) {
        window.parent.postMessage(
          {
            type: "SYNC_QX7_ID",
            qx7Id,
            timestamp: Date.now(),
            source: window.location.origin,
          },
          MESSAGE_TARGET_ORIGIN
        );
      }

      const iframes = document.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          iframe.contentWindow.postMessage(
            {
              type: "SYNC_QX7_ID",
              qx7Id,
              timestamp: Date.now(),
              source: window.location.origin,
            },
            MESSAGE_TARGET_ORIGIN
          );
        } catch (e) {
          // Cross-origin iframe, skip
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  },
};

async function generateBxp7() {
  // Fingerprint generation removed - IDs should only come from server
  // This function kept for backwards compatibility but returns null
  return null;
}

async function checkCacheStatus() {
  // Cache status check - returns false if cache is intact
  try {
    return await caches.keys().then((keys) => keys.length === 0);
  } catch (e) {
    return true;
  }
}

async function detectQx7DataClearing() {
  const checks = [];

  try {
    const qx7Id = await Qx7Storage.getQx7Id();
    checks.push(!qx7Id);
  } catch (e) {
    checks.push(true);
  }

  try {
    checks.push(!sessionStorage.getItem("active-session"));
  } catch (e) {
    checks.push(true);
  }

  try {
    checks.push(!localStorage.getItem("session-start-time"));
  } catch (e) {
    checks.push(true);
  }

  try {
    const cacheCleared = await checkCacheStatus();
    checks.push(cacheCleared);
  } catch (e) {
    checks.push(true);
  }

  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const swCleared = !(await registration.active?.postMessage({
          type: "CHECK_DATA",
        }));
        checks.push(swCleared);
      }
    }
  } catch (e) {
    checks.push(true);
  }

  try {
    sessionStorage.setItem("active-session", "active");
  } catch (e) {}

  try {
    if (!localStorage.getItem("session-start-time")) {
      localStorage.setItem("session-start-time", Date.now().toString());
    }
  } catch (e) {}

  const clearedCount = checks.filter(Boolean).length;
  const confidence = clearedCount / checks.length;

  return {
    dataCleared: clearedCount >= 2,
    confidence,
    checks,
    clearedCount,
    totalChecks: checks.length,
  };
}

async function fetchEnhancedZkx() {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const incognitoResults = window.incognitoDetector
        ? window.incognitoDetector.getResults()
        : null;
      const [storedQx7Id, dataClearingResult] = await Promise.all([
        Qx7Storage.getQx7Id(),
        detectQx7DataClearing(),
      ]);

      console.log("storedQx7Id", storedQx7Id);
      console.log("dataClearingResult", dataClearingResult);

      const headers = { "Content-Type": "application/json" };
      if (storedQx7Id) headers["X-Qx7-id"] = storedQx7Id;
      headers["X-Data-Cleared"] = String(dataClearingResult.dataCleared);
      headers["X-Data-Clearing-Confidence"] = String(
        dataClearingResult.confidence
      );

      if (incognitoResults) {
        headers["X-Incognito-Mode"] = String(incognitoResults.isIncognito);
        headers["X-Limited-Storage"] = String(
          incognitoResults.hasLimitedStorage
        );
        headers["X-Session-Only"] = String(incognitoResults.sessionOnly);
      }

      const response = await handleRequest(ENDPOINT_1, headers);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!incognitoResults?.isIncognito) {
        await Qx7Storage.setQx7Id(data.qx7Id, {
          priority: "all",
          ttl: 365 * 24 * 60 * 60 * 1000,
        });

        await Qx7Storage.syncWithOtherDomains(data.qx7Id);
      }

      window.qx7Id = data.qx7Id;
      await updateQx7IdImage();

      return {
        dataCleared: dataClearingResult.dataCleared,
        data,
        confidence: dataClearingResult.confidence,
        storageHealth: await getStorageHealthStatus(),
      };
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        // Don't use fingerprint fallback - let server generate ID on next request
        return {
          dataCleared: true,
          data: null,
          confidence: 0,
          storageHealth: "degraded",
        };
      }

      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
}

async function updateQx7IdImage() {
  try {
    const storedQx7Id = await Qx7Storage.getQx7Id();

    const headers = {
      "X-Qx7-id": storedQx7Id || "",
    };

    const response = await handleRequest(ENDPOINT_2, headers);

    const returnedQx7Id = response.headers.get("X-Qx7-id");
    if (returnedQx7Id) {
      await Qx7Storage.setQx7Id(returnedQx7Id);
      window.qx7Id = returnedQx7Id;
    }
  } catch (error) {}
}

async function getStorageHealthStatus() {
  const healthChecks = [];

  try {
    const localStorageTest = !!localStorage.setItem("storage-test", "test");
    if (localStorageTest) localStorage.removeItem("storage-test");
    healthChecks.push(localStorageTest ? "✅ LocalStorage" : "❌ LocalStorage");
  } catch (e) {
    healthChecks.push("❌ LocalStorage");
  }

  try {
    const sessionStorageTest = !!sessionStorage.setItem("storage-test", "test");
    if (sessionStorageTest) sessionStorage.removeItem("storage-test");
    healthChecks.push(
      sessionStorageTest ? "✅ SessionStorage" : "❌ SessionStorage"
    );
  } catch (e) {
    healthChecks.push("❌ SessionStorage");
  }

  try {
    const indexedDBTest = await Qx7Storage.getFromIndexedDB();
    healthChecks.push(indexedDBTest ? "✅ IndexedDB" : "❌ IndexedDB");
  } catch (e) {
    healthChecks.push("❌ IndexedDB");
  }

  const healthyCount = healthChecks.filter((check) =>
    check.includes("✅")
  ).length;
  const totalCount = healthChecks.length;

  if (healthyCount === totalCount) return "🟢 Excellent";
  if (healthyCount >= totalCount * 0.7) return "🟡 Good";
  if (healthyCount >= totalCount * 0.4) return "🟠 Fair";
  return "🔴 Poor";
}

function setupQx7MsgBridge(context) {
  window.addEventListener("message", async (event) => {
    const type = event?.data?.type;
    if (!type) return;

    try {
      switch (type) {
        case "request-qx7-id": {
          const qx7Id = window.qx7Id || (await Qx7Storage.getQx7Id()) || "";

          event.source.postMessage(
            {
              type: "qx7-id",
              qx7Id,
              timestamp: Date.now(),
              source: window.location.origin,
            },
            event.origin || MESSAGE_TARGET_ORIGIN
          );
          break;
        }

        case "sync-qx7-id": {
          const incoming = event.data.qx7Id;
          if (incoming && Qx7Storage.isValidQx7Id(incoming)) {
            await Qx7Storage.setQx7Id(incoming, {
              priority: "all",
            });
            try {
              localStorage.setItem("qx7-sync-timestamp", Date.now().toString());
            } catch (e) {}
            window.qx7Id = incoming;
          }
          break;
        }

        case "check-data-cleared": {
          const cleared = await detectQx7DataClearing();

          event.source.postMessage(
            {
              type: "data-cleared-status",
              dataCleared: cleared.dataCleared,
              confidence: cleared.confidence,
              timestamp: Date.now(),
            },
            event.origin || MESSAGE_TARGET_ORIGIN
          );
          break;
        }

        case "SYNC_QX7_ID": {
          const incoming = event.data.qx7Id;
          if (incoming && Qx7Storage.isValidQx7Id(incoming)) {
            await Qx7Storage.setQx7Id(incoming, {
              priority: "all",
            });
            window.qx7Id = incoming;
          }
          break;
        }
      }
    } catch (error) {}
  });

  if (window.parent !== window) {
    try {
      window.parent.postMessage(
        {
          type: "qx7-id",
          qx7Id: window.qx7Id || "",
          isNewSession: !!context?.dataCleared,
          persistenceMethod: context?.data?.persistenceMethod || "",
          enhanced: true,
          version: "2.0",
          timestamp: Date.now(),
        },
        MESSAGE_TARGET_ORIGIN
      );
    } catch (e) {}
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("DOMContentLoaded");
    const context = await fetchEnhancedZkx();
    document.getElementById("qx7-id").textContent = window.qx7Id;
    setupQx7MsgBridge(context);
  } catch (error) {}
});

window.Qx7 = {
  PersistentStorage: Qx7Storage,
  detectDataClearing: detectQx7DataClearing,
  getStorageHealth: getStorageHealthStatus,
};
