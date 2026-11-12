// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  Ozon BlackBox: Forensics, Anti-Fraud Client Badges & Visual Timeline (Stealth Edition)
// @author       desslow
// @match        https://*.ozon.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = '_o3_telemetry_cache';
    const DB_VERSION = 2;
    const TTL_DAYS = 180;
    const ENABLE_DEV_PURGE = true;

    let db = null;
    let scanBuffer = '';
    let lastScanTime = Date.now();
    let currentOperator = '';
    let activeSession = null;
    let currentPostingsList = [];
    let externalDumpData = null;
    window._ozonAuthHeaders = null;

    const pendingGiveoutTasks = new Map();
    const sessionGiveoutPayloads = new Map();
    const TAB_ID = Math.random().toString(36).slice(2, 9);

    const RUS_TO_ENG = {
        'й':'q','ц':'w','у':'e','к':'r','е':'t','н':'y','г':'u','ш':'i','щ':'o','з':'p',
        'х':'[','ъ':']','ф':'a','ы':'s','в':'d','а':'f','п':'g','р':'h','о':'j','л':'k',
        'д':'l','ж':';','э':"'",'я':'z','ч':'x','с':'c','м':'v','и':'b','т':'n','ь':'m',
        'б':',','ю':'.','.':'/','ё':'`','?':',','/':'.'
    };

    function translit(str) {
        return str.split('').map(ch => RUS_TO_ENG[ch.toLowerCase()] || ch).join('');
    }

    /* =========================================================================
       1. DATABASE ARCHITECTURE (IndexedDB v2)
       ========================================================================= */

    function initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('sessions')) {
                    const sStore = d.createObjectStore('sessions', { keyPath: 'sessionId' });
                    sStore.createIndex('by_closedAt', 'closedAt', { unique: false });
                    sStore.createIndex('by_clientId', 'clientId', { unique: false });
                }
                if (!d.objectStoreNames.contains('scans_history')) {
                    const scStore = d.createObjectStore('scans_history', { keyPath: 'id', autoIncrement: true });
                    scStore.createIndex('by_barcode', 'barcode', { unique: false });
                    scStore.createIndex('by_time', 'time', { unique: false });
                }
                if (!d.objectStoreNames.contains('client_badges')) {
                    d.createObjectStore('client_badges', { keyPath: 'clientId' });
                }
            };
            req.onsuccess = (e) => {
                db = e.target.result;
                if (navigator.storage && navigator.storage.persist) {
                    navigator.storage.persist();
                }
                purgeExpiredData();
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
    }

    function purgeExpiredData() {
        if (!db) return;
        const expireTs = Date.now() - (TTL_DAYS * 24 * 3600 * 1000);
        try {
            const tx = db.transaction(['sessions', 'scans_history'], 'readwrite');
            const sStore = tx.objectStore('sessions');
            const scStore = tx.objectStore('scans_history');

            const sIndex = sStore.index('by_closedAt');
            sIndex.openCursor(IDBKeyRange.upperBound(expireTs)).onsuccess = (e) => {
                const c = e.target.result;
                if (c) { sStore.delete(c.primaryKey); c.continue(); }
            };

            const scIndex = scStore.index('by_time');
            scIndex.openCursor(IDBKeyRange.upperBound(expireTs)).onsuccess = (e) => {
                const c = e.target.result;
                if (c) { scStore.delete(c.primaryKey); c.continue(); }
            };
        } catch (e) {}
    }

    function dbPut(storeName, data) {
        if (!db) return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).put(data);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    function dbGet(storeName, key) {
        if (!db) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const req = tx.objectStore(storeName).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    function dbGetAll(storeName) {
        if (!db) return Promise.resolve([]);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const req = tx.objectStore(storeName).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } catch (e) { resolve([]); }
        });
    }

    function dbDelete(storeName, key) {
        if (!db) return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).delete(key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    function clearEntireDB() {
        if (!db) return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(['sessions', 'scans_history', 'client_badges'], 'readwrite');
                tx.objectStore('sessions').clear();
                tx.objectStore('scans_history').clear();
                tx.objectStore('client_badges').clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /* =========================================================================
       2. UNIFIED STYLES (Fixed Stacking Context & Opaque Tooltip)
       ========================================================================= */

    const unifiedStyle = document.createElement('style');
    unifiedStyle.innerHTML = `
        /* ---------------- НА ТЕМЕ OZON (СВЕТЛЫЙ НАЦИОНАЛЬНЫЙ ДИЗАЙН OZI) ---------------- */
        
        /* Поднимаем контейнер заголовка над табами Ozon, чтобы тултип не пробивался */
        [class*="_client_"], [class*="_clientName_"] {
            position: relative !important;
            z-index: 99999 !important;
        }

        #bb-ozon-injected-badges {
            position: relative !important;
            z-index: 100000 !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            margin-left: 12px !important;
            vertical-align: middle !important;
            flex-wrap: wrap !important;
        }

        .bb-ozon-add-btn {
            background: #f2f5f9 !important;
            color: #005bff !important;
            border: 1px solid #dbe2ea !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            padding: 3px 10px !important;
            border-radius: 8px !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            vertical-align: middle !important;
            transition: all 0.15s ease !important;
            font-family: inherit !important;
            line-height: 16px !important;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04) !important;
        }
        .bb-ozon-add-btn:hover {
            background: #e8f2ff !important;
            border-color: #b8d5ff !important;
        }

        .bb-ozon-pill {
            position: relative !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            padding: 2px 8px !important;
            border-radius: 6px !important;
            cursor: pointer !important;
            user-select: none !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            line-height: 18px !important;
            vertical-align: middle !important;
            font-family: inherit !important;
            transition: transform 0.1s ease !important;
        }
        .bb-ozon-pill:hover { transform: translateY(-1px); }

        .bb-pill-red { background: #feecee !important; color: #f91155 !important; border: 1px solid #fcced3 !important; }
        .bb-pill-yellow { background: #fef3c7 !important; color: #b45309 !important; border: 1px solid #fde68a !important; }
        .bb-pill-blue { background: #e8f2ff !important; color: #005bff !important; border: 1px solid #cce2ff !important; }
        .bb-pill-green { background: #e6f9ed !important; color: #00873e !important; border: 1px solid #b3f0cc !important; }

        /* ИСПРАВЛЕННЫЙ ТУЛТИП: Полная непрозрачность, высокий слой, выпадает вниз */
        .bb-ozon-tooltip {
            visibility: hidden;
            opacity: 0;
            position: absolute;
            top: calc(100% + 6px) !important;
            left: 0 !important;
            bottom: auto !important;
            transform: translateY(-4px) !important;
            width: 270px !important;
            background: #ffffff !important;
            background-color: #ffffff !important;
            border: 1px solid #d0d7de !important;
            color: #001a34 !important;
            padding: 12px 14px !important;
            border-radius: 10px !important;
            font-size: 12px !important;
            z-index: 1000000 !important;
            box-shadow: 0 12px 28px rgba(0, 26, 52, 0.25), 0 0 0 1px rgba(0, 26, 52, 0.08) !important;
            transition: opacity 0.15s ease, transform 0.15s ease !important;
            pointer-events: none !important;
            text-align: left !important;
            line-height: 16px !important;
            font-weight: normal !important;
            white-space: normal !important;
        }
        .bb-ozon-pill:hover .bb-ozon-tooltip {
            visibility: visible !important;
            opacity: 1 !important;
            transform: translateY(0) !important;
        }

        #bb-dialog-overlay {
            position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(0, 26, 52, 0.45) !important; backdrop-filter: blur(4px) !important;
            z-index: 20000000 !important; display: flex !important; align-items: center !important; justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        }
        .bb-ozon-dialog {
            background: #ffffff !important; border-radius: 16px !important; width: 440px !important;
            padding: 24px !important; box-shadow: 0 20px 40px rgba(0, 26, 52, 0.18) !important;
            display: flex !important; flex-direction: column !important; gap: 14px !important; color: #001a34 !important;
        }
        .bb-dialog-title { font-size: 18px !important; font-weight: 700 !important; color: #001a34 !important; margin: 0 !important; }
        .bb-dialog-sub { font-size: 13px !important; color: #707f8d !important; margin-top: -8px !important; }

        .bb-ozon-input {
            width: 100% !important; box-sizing: border-box !important; background: #ffffff !important;
            border: 1px solid #d0d7de !important; border-radius: 8px !important; padding: 10px 12px !important;
            font-size: 14px !important; color: #001a34 !important; outline: none !important; transition: border-color 0.15s, box-shadow 0.15s !important;
        }
        .bb-ozon-input:focus {
            border-color: #005bff !important; box-shadow: 0 0 0 3px rgba(0, 91, 255, 0.15) !important;
        }

        .bb-color-chips { display: flex !important; gap: 8px !important; }
        .bb-color-chip {
            flex: 1 !important; padding: 7px 4px !important; border-radius: 8px !important; font-size: 12px !important;
            font-weight: 600 !important; text-align: center !important; cursor: pointer !important; border: 2px solid transparent !important;
            user-select: none !important; transition: all 0.15s ease !important;
        }
        .bb-color-chip.active { border-color: #001a34 !important; transform: scale(1.02); }

        .bb-dialog-actions { display: flex !important; justify-content: flex-end !important; gap: 10px !important; margin-top: 6px !important; }
        .bb-btn-ozon-secondary {
            background: #f2f5f9 !important; color: #001a34 !important; border: none !important; padding: 9px 16px !important;
            border-radius: 8px !important; font-weight: 600 !important; font-size: 13px !important; cursor: pointer !important;
        }
        .bb-btn-ozon-secondary:hover { background: #e4e8ee !important; }
        .bb-btn-ozon-primary {
            background: #005bff !important; color: #ffffff !important; border: none !important; padding: 9px 18px !important;
            border-radius: 8px !important; font-weight: 600 !important; font-size: 13px !important; cursor: pointer !important;
            transition: background 0.15s !important;
        }
        .bb-btn-ozon-primary:hover { background: #004ed6 !important; }

        /* ---------------- МОДАЛКА ИНСПЕКТОРА (BLACKBOX DARK) ---------------- */
        #blackbox-modal-root {
            position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.85) !important; backdrop-filter: blur(25px) saturate(180%) !important;
            z-index: 10000000 !important; display: flex !important; align-items: center !important; justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; color: #f8fafc !important;
        }
        .bb-window {
            width: 1140px !important; max-width: 96vw !important; height: 820px !important; max-height: 94vh !important;
            background: #0b1120 !important; border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 20px !important; box-shadow: 0 30px 80px rgba(0,0,0,0.8) !important;
            display: flex !important; flex-direction: column !important; overflow: hidden !important;
        }
        .bb-header {
            display: flex !important; align-items: center !important; justify-content: space-between !important;
            padding: 16px 24px !important; border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
            background: rgba(255, 255, 255, 0.02) !important;
        }
        .bb-title { font-size: 16px !important; font-weight: 800 !important; letter-spacing: 0.5px !important; }
        .bb-title span { color: #38bdf8 !important; }
        .bb-tabs { display: flex !important; gap: 8px !important; }
        .bb-tab-btn {
            background: transparent !important; border: 1px solid transparent !important; color: #94a3b8 !important;
            padding: 6px 14px !important; border-radius: 8px !important; font-size: 12px !important; font-weight: 600 !important;
            cursor: pointer !important; transition: all 0.2s !important;
        }
        .bb-tab-btn:hover { color: #fff !important; background: rgba(255, 255, 255, 0.05) !important; }
        .bb-tab-btn.active { color: #38bdf8 !important; background: rgba(56, 189, 248, 0.12) !important; border-color: rgba(56, 189, 248, 0.3) !important; }
        .bb-close { color: #64748b !important; cursor: pointer !important; font-size: 20px !important; }
        .bb-close:hover { color: #fff !important; }

        .bb-body { flex: 1 1 auto !important; display: flex !important; overflow: hidden !important; }
        .bb-main-view { flex: 1 1 auto !important; padding: 20px !important; overflow-y: auto !important; display: flex !important; flex-direction: column !important; gap: 12px !important; }
        .bb-replay-view { width: 440px !important; min-width: 440px !important; border-left: 1px solid rgba(255, 255, 255, 0.08) !important; background: #070a12 !important; padding: 18px !important; display: flex !important; flex-direction: column !important; gap: 10px !important; overflow-y: auto !important; }

        .bb-input {
            background: rgba(255, 255, 255, 0.05) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important;
            color: #fff !important; padding: 8px 12px !important; border-radius: 8px !important; font-size: 13px !important; outline: none !important;
        }
        .bb-input:focus { border-color: #38bdf8 !important; }
        .bb-btn {
            background: #1e293b; color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 8px 14px;
            border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        }
        .bb-btn:hover { background: #0284c7; color: #fff; }
        .bb-btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }
        .bb-btn-danger:hover { background: #ef4444; color: #fff; }

        .bb-gantt-day-block { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }
        .bb-gantt-day-title { font-size: 13px; font-weight: 700; color: #38bdf8; display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
        .bb-swimlane-row { display: flex; gap: 8px; align-items: stretch; margin-top: 4px; }
        .bb-swimlane-track { flex: 1; display: flex; flex-direction: column; gap: 6px; background: rgba(255,255,255,0.015); border-radius: 8px; padding: 6px; border: 1px dashed rgba(255,255,255,0.05); }

        .bb-session-bar {
            background: #131d31; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px 12px;
            cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; gap: 4px; position: relative;
        }
        .bb-session-bar:hover { background: #1c2b46; border-color: #38bdf8; transform: translateY(-1px); }
        .bb-session-bar.has-alien { border-left: 3px solid #ef4444 !important; }

        .bb-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
        .bb-stat-card {
            background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
            padding: 14px; display: flex; flex-direction: column; gap: 4px;
        }
        .bb-stat-val { font-size: 24px; font-weight: 800; color: #f8fafc; }
        .bb-stat-lbl { font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }

        .bb-progress-bar { width: 100%; height: 8px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden; margin: 8px 0; }
        .bb-progress-fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #818cf8); border-radius: 4px; transition: width 0.3s; }
    `;
    document.head.appendChild(unifiedStyle);

    /* =========================================================================
       3. CLIENT BADGES ENGINE (CRM & Anti-Fraud)
       ========================================================================= */

    function getPillClass(color) {
        if (color === '#f59e0b') return 'bb-pill-yellow';
        if (color === '#005bff' || color === '#3b82f6') return 'bb-pill-blue';
        if (color === '#10b981' || color === '#00873e') return 'bb-pill-green';
        return 'bb-pill-red';
    }

    async function getClientBadges(clientId) {
        if (!clientId) return [];
        const record = await dbGet('client_badges', String(clientId));
        return record ? record.badges || [] : [];
    }

    async function addClientBadge(clientId, title, desc, color = '#ef4444') {
        if (!clientId || !title) return;
        const cId = String(clientId);
        let record = await dbGet('client_badges', cId);
        if (!record) record = { clientId: cId, badges: [] };

        const newBadge = {
            id: 'b_' + Date.now().toString(36),
            title: title.trim(),
            desc: desc.trim(),
            color: color,
            createdAt: Date.now(),
            author: getOperatorLogin() || 'Админ'
        };

        record.badges.push(newBadge);
        await dbPut('client_badges', record);
        triggerBadgesRerender();
    }

    async function removeClientBadge(clientId, badgeId) {
        if (!clientId || !badgeId) return;
        const cId = String(clientId);
        let record = await dbGet('client_badges', cId);
        if (!record) return;

        record.badges = record.badges.filter(b => b.id !== badgeId);
        if (record.badges.length === 0) {
            await dbDelete('client_badges', cId);
        } else {
            await dbPut('client_badges', record);
        }
        triggerBadgesRerender();
    }

    function triggerBadgesRerender() {
        const wrapper = document.getElementById('bb-ozon-injected-badges');
        if (wrapper) wrapper.dataset.renderedKey = '';
        renderBadgesInOzonUI();
        const activeTab = document.querySelector('.bb-tab-btn.active')?.dataset?.tab;
        if (activeTab === 'sessions') renderTabContent('sessions');
        if (activeTab === 'badges') renderTabContent('badges');
        if (activeSession) renderSessionReplay(activeSession);
    }

    async function renderBadgesInOzonUI() {
        const sId = getActiveSessionIdOnTab();
        if (!sId) return;

        let session = await dbGet('sessions', sId);
        let clientId = session?.clientId || activeSession?.clientId || sessionStorage.getItem('client_id_' + sId);
        let clientName = session?.clientName || activeSession?.clientName || '';

        const nameHeader = document.querySelector('[class*="_clientName_"]') ||
                           document.querySelector('[class*="_client_"] [class*="heading"]') ||
                           document.querySelector('[data-testid="client-name"]');
        if (!nameHeader) return;

        if (!clientName) {
            clientName = nameHeader.childNodes[0]?.textContent?.trim() || 'Клиент';
        }

        // Если сессия еще не сохранена в IndexedDB, запускаем DOM-автосборщик прямо сейчас!
        if (!session) {
            harvestSessionFromDOM(sId);
        }

        const effectiveId = clientId || ('s_' + sId);
        const badges = clientId ? await getClientBadges(clientId) : [];
        const renderKey = `${effectiveId}_${badges.length}_${badges.map(b => b.id).join(',')}`;

        let badgeWrapper = nameHeader.querySelector('#bb-ozon-injected-badges');
        if (!badgeWrapper) {
            badgeWrapper = document.createElement('div');
            badgeWrapper.id = 'bb-ozon-injected-badges';
            nameHeader.appendChild(badgeWrapper);
        }

        if (badgeWrapper.dataset.renderedKey === renderKey) return;
        badgeWrapper.dataset.renderedKey = renderKey;

        badgeWrapper.innerHTML = `
            ${badges.map(b => `
                <div class="bb-ozon-pill ${getPillClass(b.color)}">
                    <span>${b.title}</span>
                    <div class="bb-ozon-tooltip">
                        <div style="font-weight: 700; color: #001a34; margin-bottom: 4px; font-size: 13px;">${b.title}</div>
                        <div style="color: #495867;">${b.desc || 'Нет описания инцидента'}</div>
                        <div style="font-size: 10px; color: #8c9ba7; margin-top: 6px; border-top: 1px solid #f0f2f5; padding-top: 4px;">Автор: ${b.author}</div>
                    </div>
                </div>
            `).join('')}
            <button id="bb-add-badge-quick-btn" class="bb-ozon-add-btn" type="button" title="Добавить служебную метку клиенту">+ Метка</button>
        `;

        badgeWrapper.querySelector('#bb-add-badge-quick-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCreateBadgeDialog(clientId || sId, clientName);
        };
    }

    function showCreateBadgeDialog(clientId, clientName) {
        const existing = document.getElementById('bb-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'bb-dialog-overlay';

        let selectedColor = '#ef4444';

        overlay.innerHTML = `
            <div class="bb-ozon-dialog">
                <div>
                    <h3 class="bb-dialog-title">Метка клиента</h3>
                    <div class="bb-dialog-sub">${clientName} (ID: ${clientId})</div>
                </div>

                <input type="text" id="bb-badge-title-input" class="bb-ozon-input" placeholder="Название (например: НЕ ОПЛАТИЛ, БРАКЕР)" autofocus>
                <textarea id="bb-badge-desc-input" class="bb-ozon-input" placeholder="Подробности (сумма долга, дата инцидента, номер заказа)..." style="height: 74px; resize: none;"></textarea>

                <div>
                    <div style="font-size: 12px; font-weight: 600; color: #707f8d; margin-bottom: 6px;">ТИП И ЦВЕТ МЕТКИ</div>
                    <div class="bb-color-chips">
                        <div class="bb-color-chip bb-pill-red active" data-color="#ef4444">🔴 Опасность</div>
                        <div class="bb-color-chip bb-pill-yellow" data-color="#f59e0b">🟡 Внимание</div>
                        <div class="bb-color-chip bb-pill-blue" data-color="#005bff">🔵 Заметка</div>
                        <div class="bb-color-chip bb-pill-green" data-color="#10b981">🟢 Доверие</div>
                    </div>
                </div>

                <div class="bb-dialog-actions">
                    <button class="bb-btn-ozon-secondary" id="bb-badge-cancel" type="button">Отмена</button>
                    <button class="bb-btn-ozon-primary" id="bb-badge-save" type="button">Сохранить метку</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const chips = overlay.querySelectorAll('.bb-color-chip');
        chips.forEach(chip => {
            chip.onclick = () => {
                chips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                selectedColor = chip.dataset.color;
            };
        });

        overlay.querySelector('#bb-badge-cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.querySelector('#bb-badge-save').onclick = async () => {
            const title = overlay.querySelector('#bb-badge-title-input').value.trim();
            const desc = overlay.querySelector('#bb-badge-desc-input').value.trim();
            if (title) {
                await addClientBadge(clientId, title, desc, selectedColor);
                overlay.remove();
            } else {
                overlay.querySelector('#bb-badge-title-input').focus();
            }
        };
    }

    /* =========================================================================
       4. CODE CAPTURE & DOM AUTO-HARVESTER (Гарантия сохранения)
       ========================================================================= */

    function getOperatorLogin() {
        const el = document.querySelector('[class*="_rightAvatarMenuLogin_"]');
        if (el) currentOperator = el.textContent.trim().replace('PVZ_', '');
        return currentOperator;
    }

    function getActiveSessionIdOnTab() {
        return (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1] || null;
    }

    function storeSafePickupCode(sId, code) {
        if (!code || code.includes('----')) return;
        sessionStorage.setItem('client_code_' + sId, code);
        if (activeSession && String(activeSession.sessionId) === String(sId)) {
            activeSession.pickupCode = code;
        }
    }

    function extractPostingDetails(p) {
        const title = p.displayName || p.items?.[0]?.name || p.name || 'Товар';
        let bar = p.displayBarcode1 || '';
        if (!bar && Array.isArray(p.barcodes) && p.barcodes.length > 0) {
            bar = p.barcodes.find(b => !b.startsWith('%')) || p.barcodes[0];
        }
        if (!bar && p.items?.[0]?.exemplars?.[0]?.barcodes?.[0]) {
            bar = p.items[0].exemplars[0].barcodes[0];
        }
        if (!bar) bar = String(p.id);

        return {
            id: String(p.id),
            name: title,
            barcode: bar,
            allBarcodes: (p.barcodes || []).map(b => String(b).toLowerCase()),
            price: p.price || 0,
            status: 'storage',
            reasonText: ''
        };
    }

    // Резервный сборщик сессии прямо из DOM страницы (если сеть закэширована)
    async function harvestSessionFromDOM(sId) {
        const nameHeader = document.querySelector('[class*="_clientName_"]') || document.querySelector('[data-testid="client-name"]');
        const shelfEl = document.querySelector('[class*="_shelf_"], [class*="_shelves_"]');
        const clientName = nameHeader ? nameHeader.childNodes[0]?.textContent?.trim() || '' : '';
        const shelves = shelfEl ? shelfEl.textContent.replace('Ячейки', '').trim() : '';
        const clientId = sessionStorage.getItem('client_id_' + sId) || '';
        const pickupCode = sessionStorage.getItem('client_code_' + sId) || sessionStorage.getItem('client_code_pending') || (clientId ? `${clientId}*----` : '');

        let session = await dbGet('sessions', String(sId));
        if (!session) {
            session = {
                sessionId: String(sId),
                clientId: String(clientId),
                clientName: clientName,
                pickupCode: pickupCode,
                foundAt: Date.now(),
                closedAt: null,
                durationSec: 0,
                operator: getOperatorLogin(),
                shelves: shelves,
                closeReason: 'active',
                postings: [],
                timeline: [{ time: Date.now(), type: 'start', text: 'Сессия открыта' }],
                alienScans: [],
                tabId: TAB_ID
            };
            activeSession = session;
            await dbPut('sessions', session);
        }
        return session;
    }

    async function handleSessionPostingsData(sessionId, data) {
        if (!data) return;
        const sId = String(sessionId);

        const postingsArray = data.postings || data.result?.postings || (Array.isArray(data) ? data : []);
        const readyPostings = postingsArray.filter(p => p.pvzState === 'ReadyToGiveout' || !p.pvzState);
        currentPostingsList = readyPostings;

        const clientId = data.client?.ozonClientId || data.client?.clientId || sessionStorage.getItem('client_id_' + sId) || '';
        const clientName = data.client?.clientShortName || '';
        const shelves = Array.isArray(data.postingsShelves) ? data.postingsShelves.join(', ') : '';

        let realCode = sessionStorage.getItem('client_code_' + sId) || sessionStorage.getItem('client_code_pending');
        if (!realCode && clientId) {
            realCode = `${clientId}*----`;
        }

        let session = await dbGet('sessions', sId);

        if (!session) {
            session = {
                sessionId: sId,
                clientId: String(clientId),
                clientName: clientName,
                pickupCode: realCode,
                foundAt: Date.now(),
                closedAt: null,
                durationSec: 0,
                operator: getOperatorLogin(),
                shelves: shelves,
                closeReason: 'active',
                postings: readyPostings.map(extractPostingDetails),
                timeline: [
                    { time: Date.now(), type: 'start', text: 'Сессия открыта' }
                ],
                alienScans: [],
                tabId: TAB_ID
            };
        } else {
            if (clientId) session.clientId = String(clientId);
            if (clientName) session.clientName = clientName;
            if (shelves) session.shelves = shelves;
            if (realCode && !realCode.includes('----')) {
                session.pickupCode = realCode;
            }
            if (readyPostings.length > 0) {
                session.postings = readyPostings.map(extractPostingDetails);
            }
        }

        activeSession = session;
        await dbPut('sessions', session);
        setTimeout(renderBadgesInOzonUI, 150);
    }

    async function recordTimelineEvent(sId, type, text, isAlien = false, extraData = {}) {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : null);
        if (!targetId) return;

        let session = await dbGet('sessions', targetId);
        if (!session) session = await harvestSessionFromDOM(targetId);
        if (!session) return;

        const ev = { time: Date.now(), type, text, isAlien, ...extraData };
        session.timeline.push(ev);
        if (isAlien) {
            session.alienScans.push(ev);
        }
        activeSession = session;
        await dbPut('sessions', session);
    }

    async function finalizeActiveSession(sId, reason = 'completed') {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : getActiveSessionIdOnTab());
        if (!targetId) return;

        let session = await dbGet('sessions', String(targetId));
        if (!session) session = await harvestSessionFromDOM(targetId);
        if (!session || session.closedAt) return;

        session.closedAt = Date.now();
        session.durationSec = Math.max(1, Math.round((session.closedAt - session.foundAt) / 1000));
        session.operator = getOperatorLogin() || session.operator;
        session.closeReason = reason;

        let issuedCount = 0;
        let annulatedCount = 0;
        let storageCount = 0;

        const apiGiveoutData = sessionGiveoutPayloads.get(String(targetId));

        session.postings.forEach(pObj => {
            const pIdStr = String(pObj.id);
            if (apiGiveoutData && apiGiveoutData.has(pIdStr)) {
                const itemMeta = apiGiveoutData.get(pIdStr);
                if (itemMeta.isReturn) {
                    pObj.status = 'annulated';
                    pObj.reasonText = itemMeta.reasonId ? `Причина #${itemMeta.reasonId}` : 'Отказ клиента';
                    annulatedCount++;
                } else {
                    pObj.status = 'issued';
                    issuedCount++;
                }
            } else {
                const cardWrapper = document.querySelector(`[data-testid="${pObj.id}"]`);
                if (cardWrapper) {
                    const txt = cardWrapper.textContent;
                    if (txt.includes('К выдаче') && !txt.includes('К аннуляции') && !txt.includes('Отказ')) {
                        pObj.status = 'issued';
                        issuedCount++;
                    } else if (txt.includes('К аннуляции') || txt.includes('Отказ')) {
                        pObj.status = 'annulated';
                        const reasonBtn = Array.from(cardWrapper.querySelectorAll('button')).find(b => b.textContent.includes('К аннуляции'));
                        pObj.reasonText = reasonBtn ? reasonBtn.textContent.replace('К аннуляции:', '').trim() : 'Отказ';
                        annulatedCount++;
                    } else {
                        pObj.status = 'storage';
                        storageCount++;
                    }
                } else {
                    if (reason === 'completed') {
                        pObj.status = 'issued';
                        issuedCount++;
                    } else {
                        pObj.status = 'storage';
                        storageCount++;
                    }
                }
            }
        });

        let summaryText = 'Сессия завершена';
        if (reason === 'manual_dock') summaryText = 'Закрыто вручную через Dock';
        else if (reason === 'manual_back') summaryText = 'Выход назад на /orders';
        else if (reason === 'tab_unloaded') summaryText = 'Вкладка закрыта/обновлена';
        else if (reason === 'payment_failed') summaryText = 'Сбой оплаты заказа';

        summaryText += ` (Выдано: ${issuedCount}, Отказ: ${annulatedCount}, Хранение: ${storageCount})`;
        session.timeline.push({ time: Date.now(), type: 'finish', text: summaryText });

        await dbPut('sessions', session);
        sessionGiveoutPayloads.delete(String(targetId));

        if (activeSession && String(activeSession.sessionId) === String(targetId)) {
            activeSession = null;
        }
    }

    async function verifyOzonArticle(barcode) {
        try {
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
            if (window._ozonAuthHeaders) Object.assign(headers, window._ozonAuthHeaders);

            const res = await fetch('https://turbo-pvz.ozon.ru/p-api/article-tracking/Entity/Find', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ isManualInput: false, name: barcode }),
                credentials: 'same-origin'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.entity && data.entity.id) {
                    return { isOzonArticle: true, name: data.entity.name || '' };
                }
            }
        } catch (e) {}
        return { isOzonArticle: false };
    }

    function captureAuthToken(headersObj) {
        if (!headersObj) return;
        try {
            const auth = headersObj.get ? headersObj.get('authorization') : headersObj['authorization'] || headersObj['Authorization'];
            if (auth) {
                window._ozonAuthHeaders = {
                    'authorization': auth,
                    'x-o3-app-name': (headersObj.get ? headersObj.get('x-o3-app-name') : headersObj['x-o3-app-name']) || 'turbo-pvz-ui',
                    'x-o3-app-version': (headersObj.get ? headersObj.get('x-o3-app-version') : headersObj['x-o3-app-version']) || '',
                    'x-o3-version-name': (headersObj.get ? headersObj.get('x-o3-version-name') : headersObj['x-o3-version-name']) || ''
                };
            }
        } catch (e) {}
    }

    /* =========================================================================
       5. NETWORK INTERCEPTOR (Универсальный перехват с регулярками)
       ========================================================================= */

    function interceptPayload(url, reqBody, resData, status = 200) {
        if (url.includes('/by-code') || url.includes('/find')) {
            try {
                const parsedReq = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
                const code = parsedReq?.code || parsedReq?.searchString;
                if (code && /^\d{5,12}\*\d{3,6}$/.test(code)) {
                    sessionStorage.setItem('client_code_pending', code);
                }
            } catch(e) {}
        }

        if (url.includes('/api2/giveout/Sessions/close')) {
            let closedId = null;
            if (typeof reqBody === 'string') {
                try { closedId = JSON.parse(reqBody).sessionId; } catch (e) {}
            } else if (reqBody && reqBody.sessionId) {
                closedId = reqBody.sessionId;
            }
            finalizeActiveSession(closedId, 'completed');
        }

        if (url.includes('/api2/giveout/Postings/giveout-v3')) {
            try {
                const parsedReq = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
                const parsedRes = typeof resData === 'string' ? JSON.parse(resData) : resData;

                if (parsedReq && parsedReq.sessionId) {
                    const sId = String(parsedReq.sessionId);
                    const postingsMap = new Map();

                    (parsedReq.postings || []).forEach(p => {
                        const isReturn = Boolean(p.returnReasonId !== null && p.returnReasonId !== undefined) || (p.returnExemplars && p.returnExemplars.length > 0);
                        postingsMap.set(String(p.id), { isReturn, reasonId: p.returnReasonId });
                    });

                    sessionGiveoutPayloads.set(sId, postingsMap);

                    if (parsedRes && Array.isArray(parsedRes.tasks)) {
                        parsedRes.tasks.forEach(t => {
                            pendingGiveoutTasks.set(String(t.taskId), { sessionId: sId, postingIds: t.postingIds });
                        });
                    } else {
                        finalizeActiveSession(sId, 'completed');
                    }
                }
            } catch (e) {}
        }

        if (url.includes('/api2/giveout/Postings/giveout-v2-tasks-statuses')) {
            try {
                const parsedRes = typeof resData === 'string' ? JSON.parse(resData) : resData;
                if (parsedRes && Array.isArray(parsedRes.statuses)) {
                    parsedRes.statuses.forEach(st => {
                        const tId = String(st.id);
                        if (st.status === 'Processed' && pendingGiveoutTasks.has(tId)) {
                            const taskInfo = pendingGiveoutTasks.get(tId);
                            pendingGiveoutTasks.delete(tId);

                            let hasActive = false;
                            for (let entry of pendingGiveoutTasks.values()) {
                                if (entry.sessionId === taskInfo.sessionId) { hasActive = true; break; }
                            }
                            if (!hasActive) finalizeActiveSession(taskInfo.sessionId, 'completed');
                        }
                    });
                }
            } catch (e) {}
        }

        // Универсальный перехват Postings (любой порядок параметров и регистр)
        if (url.includes('/api2/giveout/Postings') && !url.includes('/giveout-v3') && !url.includes('/giveout-v2')) {
            const match = url.match(/[?&]sessionId=(\d+)/i) || (getActiveSessionIdOnTab() ? [null, getActiveSessionIdOnTab()] : null);
            if (match && resData) {
                try {
                    const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                    handleSessionPostingsData(match[1], parsed);
                } catch(e) {}
            }
        }

        if (url.includes('/Payment') || url.includes('/pay')) {
            if (status >= 400) {
                recordTimelineEvent(null, 'payment_failed', '❌ ОШИБКА ОПЛАТЫ ЗАКАЗА', true);
            }
        }

        if (url.includes('/api2/giveout/Sessions') && !url.includes('/close')) {
            try {
                const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                if (parsed && Array.isArray(parsed.sessions)) {
                    parsed.sessions.forEach(s => {
                        if (s.sessionId && s.clientId) {
                            sessionStorage.setItem('client_id_' + s.sessionId, String(s.clientId));
                        }
                    });
                }
            } catch(e) {}
        }
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._bUrl = typeof url === 'string' ? url : '';
        this._bHeaders = {};
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this._bHeaders) this._bHeaders[name.toLowerCase()] = value;
        return origSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        if (this._bHeaders) captureAuthToken(this._bHeaders);
        const self = this;
        this.addEventListener('load', function() {
            try { interceptPayload(self._bUrl, body, self.responseText, self.status); } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            if (args[1]?.headers) captureAuthToken(new Headers(args[1].headers));
        } catch (e) {}

        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const response = await origFetch.apply(this, args);

        try {
            const reqBody = args[1]?.body;
            response.clone().text().then(resText => {
                interceptPayload(url, reqBody, resText, response.status);
            }).catch(() => {});
        } catch (e) {}

        return response;
    };

    /* =========================================================================
       6. SPA ROUTING & SCANNER HOOK
       ========================================================================= */

    function patchRoutingEvents() {
        const fire = () => {
            const currentSessionId = getActiveSessionIdOnTab();
            if (!currentSessionId && activeSession) {
                finalizeActiveSession(activeSession.sessionId, 'navigated_away');
            } else if (currentSessionId) {
                harvestSessionFromDOM(currentSessionId);
            }
            setTimeout(renderBadgesInOzonUI, 300);
        };
        const p = history.pushState, r = history.replaceState;
        history.pushState = function(...a) { p.apply(this, a); fire(); };
        history.replaceState = function(...a) { r.apply(this, a); fire(); };
        window.addEventListener('popstate', fire);
    }

    window.addEventListener('beforeunload', () => finalizeActiveSession(null, 'tab_unloaded'));

    document.addEventListener('input', (e) => {
        if (e.target.matches('input[data-testid="searchInput"], input[placeholder*="Штрихкод"], input[placeholder*="коду"]')) {
            const val = e.target.value.trim();
            if (/^\d{5,12}\*\d{3,6}$/.test(val)) {
                sessionStorage.setItem('client_code_pending', val);
                const aId = getActiveSessionIdOnTab();
                if (aId) storeSafePickupCode(aId, val);
            }
        }
    }, true);

    window.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyB') {
            e.preventDefault();
            e.stopPropagation();
            toggleInspectorModal();
            return;
        }

        if (e.key === 'Escape') {
            const modal = document.getElementById('blackbox-modal-root');
            if (modal) {
                e.preventDefault();
                closeInspectorModal();
                return;
            }
        }

        const now = Date.now();
        if (now - lastScanTime > 150) scanBuffer = '';
        lastScanTime = now;

        if (e.key === 'Enter') {
            const raw = scanBuffer.trim();
            scanBuffer = '';
            if (raw.length >= 4) {
                processBarcodeScan(translit(raw));
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            scanBuffer += e.key;
        }
    }, true);

    async function processBarcodeScan(barcode) {
        const clean = barcode.toLowerCase();
        const now = Date.now();
        const currentOp = getOperatorLogin();
        const activeId = getActiveSessionIdOnTab();

        const isClientBarcode = /^\d{5,12}\*\d{3,6}$/.test(clean);
        if (isClientBarcode) {
            const parts = clean.split('*');
            const cId = parts[0];
            sessionStorage.setItem('client_code_pending', barcode);
            if (activeId) {
                storeSafePickupCode(activeId, barcode);
                let s = await dbGet('sessions', String(activeId));
                if (!s) s = await harvestSessionFromDOM(activeId);
                if (s) {
                    s.pickupCode = barcode;
                    s.clientId = cId;
                    await dbPut('sessions', s);
                }
            }
            return;
        }

        let isMatchInCurrent = false;
        let currentClientName = '';

        if (activeId) {
            let session = await dbGet('sessions', String(activeId));
            if (!session) session = await harvestSessionFromDOM(activeId);
            if (session) {
                currentClientName = session.clientName || '';
                if (session.postings && session.postings.length > 0) {
                    isMatchInCurrent = session.postings.some(p => {
                        const pId = String(p.id).toLowerCase();
                        const pBar = (p.barcode || '').toLowerCase();
                        const bList = (p.allBarcodes || []).map(b => String(b).toLowerCase());
                        return pId.includes(clean) || clean.includes(pId) || pBar.includes(clean) || clean.includes(pBar) || bList.some(b => b.includes(clean));
                    });

                    if (isMatchInCurrent) {
                        recordTimelineEvent(activeId, 'scan', `Отсканирован товар: ${barcode}`, false, { barcode });
                    } else {
                        verifyOzonArticle(barcode).then(res => {
                            if (res.isOzonArticle) {
                                recordTimelineEvent(activeId, 'alien_scan', `⚠️ ЧУЖОЙ ТОВАР СО СКЛАДА: ${barcode} (${res.name})`, true, { barcode, isRealParcel: true });
                            } else {
                                recordTimelineEvent(activeId, 'junk_scan', `ℹ️ Служебный ШК: ${barcode}`, false, { barcode, isRealParcel: false });
                            }
                        });
                    }
                }
            }
        }

        dbPut('scans_history', {
            barcode: barcode,
            sessionId: activeId,
            clientName: currentClientName,
            operator: currentOp,
            time: now,
            isAlien: activeId ? !isMatchInCurrent : false
        });
    }

    /* =========================================================================
       7. INSPECTOR UI CONTROLS
       ========================================================================= */

    function toggleInspectorModal() {
        const m = document.getElementById('blackbox-modal-root');
        if (m) closeInspectorModal();
        else openInspector();
    }

    function closeInspectorModal() {
        const m = document.getElementById('blackbox-modal-root');
        if (m) m.remove();
        document.body.style.overflow = '';
    }

    function openInspector() {
        document.body.style.overflow = 'hidden';
        const modal = document.createElement('div');
        modal.id = 'blackbox-modal-root';
        modal.innerHTML = `
            <div class="bb-window">
                <div class="bb-header">
                    <div class="bb-title">⬛ BLACKBOX <span>// АУДИТ & CRM</span></div>
                    <div class="bb-tabs">
                        <button class="bb-tab-btn active" data-tab="sessions">Хронограф смены</button>
                        <button class="bb-tab-btn" data-tab="badges">🏷️ Метки клиентов</button>
                        <button class="bb-tab-btn" data-tab="lookup">Поиск «Потеряшки»</button>
                        <button class="bb-tab-btn" data-tab="aliens">⚠️ Аномалии</button>
                        <button class="bb-tab-btn" data-tab="storage">База & Память</button>
                    </div>
                    <span class="bb-close" id="bb-close-btn">✕</span>
                </div>
                <div class="bb-body">
                    <div class="bb-main-view" id="bb-main-content"></div>
                    <div class="bb-replay-view" id="bb-replay-sidebar">
                        <div style="color: #64748b; font-size: 13px; text-align: center; margin-top: 40px;">Выберите сессию для анализа</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('#bb-close-btn').onclick = closeInspectorModal;
        const tabs = modal.querySelectorAll('.bb-tab-btn');
        tabs.forEach(t => {
            t.onclick = () => {
                tabs.forEach(tb => tb.classList.remove('active'));
                t.classList.add('active');
                renderTabContent(t.dataset.tab);
            };
        });

        renderTabContent('sessions');
    }

    function formatDateKey(timestamp) {
        const d = new Date(timestamp);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function assignSwimlaneTracks(sessions) {
        const sorted = [...sessions].sort((a, b) => a.foundAt - b.foundAt);
        const tracks = [];

        return sorted.map(s => {
            let placedTrack = -1;
            const endTs = s.closedAt || (s.foundAt + 60000);

            for (let i = 0; i < tracks.length; i++) {
                if (tracks[i] <= s.foundAt) {
                    placedTrack = i;
                    tracks[i] = endTs;
                    break;
                }
            }
            if (placedTrack === -1) {
                placedTrack = tracks.length;
                tracks.push(endTs);
            }
            return { session: s, trackIndex: placedTrack };
        });
    }

    async function renderTabContent(tab) {
        const container = document.getElementById('bb-main-content');
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!container) return;

        if (tab === 'sessions') {
            sidebar.style.display = 'flex';
            let sessions = externalDumpData ? externalDumpData.sessions : await dbGetAll('sessions');
            const allBadges = await dbGetAll('client_badges');
            const badgesMap = new Map(allBadges.map(b => [b.clientId, b.badges]));

            container.innerHTML = `
                <div style="display: flex; gap: 8px; width: 100%;">
                    <input type="text" class="bb-input" id="bb-session-search" placeholder="Поиск по клиенту, штрихкоду, ячейке..." style="flex: 1;">
                    <input type="text" class="bb-input" id="bb-shelf-search" placeholder="Ячейка..." style="width: 120px;">
                </div>
                <div id="bb-sessions-gantt" style="display: flex; flex-direction: column; gap: 14px; margin-top: 6px;"></div>
            `;

            const listEl = container.querySelector('#bb-sessions-gantt');

            function populateGantt(items) {
                listEl.innerHTML = '';
                if (items.length === 0) {
                    listEl.innerHTML = '<div style="color: #64748b; text-align: center; padding: 30px;">Нет зафиксированных сессий</div>';
                    return;
                }

                const grouped = {};
                items.forEach(s => {
                    const key = formatDateKey(s.foundAt);
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(s);
                });

                Object.keys(grouped).sort((a,b) => b.localeCompare(a)).forEach(dayKey => {
                    const daySessions = grouped[dayKey];
                    const trackedSessions = assignSwimlaneTracks(daySessions);
                    const totalTracks = Math.max(...trackedSessions.map(t => t.trackIndex)) + 1;

                    const dayBox = document.createElement('div');
                    dayBox.className = 'bb-gantt-day-block';

                    const d = new Date(daySessions[0].foundAt);
                    dayBox.innerHTML = `
                        <div class="bb-gantt-day-title">
                            <span>📅 ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                            <span style="font-size: 11px; color: #94a3b8;">${daySessions.length} сессий · Дорожек параллельности: ${totalTracks}</span>
                        </div>
                        <div class="bb-swimlane-row" id="tracks-container-${dayKey}"></div>
                    `;

                    const row = dayBox.querySelector(`#tracks-container-${dayKey}`);
                    const trackCols = [];
                    for (let i = 0; i < totalTracks; i++) {
                        const col = document.createElement('div');
                        col.className = 'bb-swimlane-track';
                        col.innerHTML = `<div style="font-size: 10px; color: #64748b; text-align: center;">Поток #${i + 1}</div>`;
                        row.appendChild(col);
                        trackCols.push(col);
                    }

                    trackedSessions.forEach(({ session: s, trackIndex }) => {
                        const hasAlien = s.alienScans && s.alienScans.some(a => a.isRealParcel);
                        const cBadges = badgesMap.get(s.clientId) || [];
                        const dStart = new Date(s.foundAt);
                        const timeStr = `${String(dStart.getHours()).padStart(2, '0')}:${String(dStart.getMinutes()).padStart(2, '0')}`;

                        const card = document.createElement('div');
                        card.className = `bb-session-bar ${hasAlien ? 'has-alien' : ''}`;
                        card.innerHTML = `
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 700; font-size: 13px; color: #f8fafc;">${s.clientName || 'Без имени'}</span>
                                <span style="font-size: 11px; font-family: monospace; color: #64748b;">${timeStr} (${s.durationSec || 0}с)</span>
                            </div>
                            <div style="display: flex; gap: 6px; font-size: 11px; color: #94a3b8; flex-wrap: wrap;">
                                <span>📦 ${s.postings?.length || 0} тов.</span>
                                <span>Яч. <b>${s.shelves || '—'}</b></span>
                                <span>👤 ${s.operator || '—'}</span>
                            </div>
                            ${cBadges.length > 0 ? `
                                <div style="display: flex; gap: 4px; margin-top: 2px;">
                                    ${cBadges.map(b => `<span style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: ${b.color}22; color: ${b.color}; border: 1px solid ${b.color};">⚠️ ${b.title}</span>`).join('')}
                                </div>
                            ` : ''}
                        `;
                        card.onclick = () => renderSessionReplay(s);
                        trackCols[trackIndex].appendChild(card);
                    });

                    listEl.appendChild(dayBox);
                });
            }

            populateGantt(sessions);

            const searchInp = container.querySelector('#bb-session-search');
            const shelfInp = container.querySelector('#bb-shelf-search');

            function filterGantt() {
                const q = searchInp.value.toLowerCase().trim();
                const sh = shelfInp.value.toLowerCase().trim();

                const filtered = sessions.filter(s => {
                    const matchName = (s.clientName || '').toLowerCase().includes(q);
                    const matchId = (s.clientId || '').toLowerCase().includes(q);
                    const matchCode = (s.pickupCode || '').toLowerCase().includes(q);
                    const matchBarcode = s.postings?.some(p => (p.barcode && p.barcode.toLowerCase().includes(q)) || p.allBarcodes?.some(b => b.includes(q)));
                    const matchShelf = !sh || (s.shelves || '').toLowerCase().includes(sh);
                    return (matchName || matchId || matchCode || matchBarcode) && matchShelf;
                });
                populateGantt(filtered);
            }

            searchInp.oninput = filterGantt;
            shelfInp.oninput = filterGantt;
        }

        if (tab === 'badges') {
            sidebar.style.display = 'none';
            const badgesList = await dbGetAll('client_badges');

            container.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div style="font-size: 13px; color: #94a3b8;">Клиенты под особым контролем (Черный список / Метки):</div>
                </div>
                <div id="bb-badges-table" style="display: flex; flex-direction: column; gap: 8px;"></div>
            `;

            const bTable = container.querySelector('#bb-badges-table');
            if (badgesList.length === 0) {
                bTable.innerHTML = '<div style="color: #64748b; padding: 20px; text-align: center;">Нет созданных меток. Вы можете добавить их прямо на экране выдачи Ozon.</div>';
            } else {
                bTable.innerHTML = badgesList.map(item => `
                    <div class="bb-stat-card" style="flex-direction: row; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-weight: 700; font-size: 14px;">ClientId: ${item.clientId}</div>
                            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                ${(item.badges || []).map(b => `
                                    <div style="background: ${b.color}22; border: 1px solid ${b.color}; color: ${b.color}; border-radius: 6px; padding: 3px 8px; font-size: 11px;">
                                        <b>${b.title}</b> — ${b.desc} <span style="opacity: 0.6;">(${b.author})</span>
                                        <span class="bb-del-badge-btn" data-cid="${item.clientId}" data-bid="${b.id}" style="margin-left: 6px; cursor: pointer;">✕</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                `).join('');

                bTable.querySelectorAll('.bb-del-badge-btn').forEach(btn => {
                    btn.onclick = async () => {
                        await removeClientBadge(btn.dataset.cid, btn.dataset.bid);
                        renderTabContent('badges');
                    };
                });
            }
        }

        if (tab === 'lookup') {
            sidebar.style.display = 'none';
            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8; margin-bottom: 4px;">Поиск сканирований штрихкода по всей базе смены:</div>
                <input type="text" class="bb-input" id="bb-lookup-input" placeholder="Вставьте ШК товара...">
                <div id="bb-lookup-results" style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;"></div>
            `;

            const input = container.querySelector('#bb-lookup-input');
            const resEl = container.querySelector('#bb-lookup-results');

            input.oninput = async () => {
                const val = translit(input.value.trim().toLowerCase());
                if (val.length < 3) { resEl.innerHTML = ''; return; }

                const allScans = await dbGetAll('scans_history');
                const matched = (allScans || []).filter(sc => (sc.barcode || '').toLowerCase().includes(val));

                if (matched.length === 0) {
                    resEl.innerHTML = '<div style="color: #64748b; padding: 15px;">Штрихкод не найден в реестре</div>';
                    return;
                }

                matched.sort((a, b) => b.time - a.time);
                resEl.innerHTML = matched.map(m => {
                    const d = new Date(m.time);
                    const time = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                    return `
                        <div class="bb-session-bar ${m.isAlien ? 'has-alien' : ''}">
                            <div style="display: flex; justify-content: space-between;">
                                <span style="font-weight: 700; color: #f8fafc;">${m.barcode}</span>
                                <span style="font-size: 11px; color: #64748b; font-family: monospace;">${time}</span>
                            </div>
                            <div style="font-size: 11px; color: #94a3b8; display: flex; gap: 8px;">
                                <span>Клиент: <b>${m.clientName || 'Сессия #' + m.sessionId}</b></span>
                                <span>Оператор: <b>${m.operator}</b></span>
                                ${m.isAlien ? '<span style="color: #ef4444; font-weight: bold;">⚠️ ЧУЖОЙ ПИК</span>' : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            };
        }

        if (tab === 'aliens') {
            sidebar.style.display = 'none';
            const sessions = await dbGetAll('sessions');
            const alienSessions = (sessions || []).filter(s => s.alienScans && s.alienScans.some(a => a.isRealParcel));

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов товаров Ozon не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold; margin-bottom: 6px;">Реестр опасных сканов (попытка выдать чужой товар):</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${alienSessions.map(s => `
                        <div class="bb-session-bar has-alien">
                            <div style="display: flex; justify-content: space-between;">
                                <span style="font-weight: 700;">${s.clientName} (Код: ${s.pickupCode || '—'})</span>
                                <span style="font-size: 11px; color: #64748b;">${new Date(s.foundAt).toLocaleString('ru-RU')}</span>
                            </div>
                            <div style="font-size: 12px; color: #94a3b8;">Оператор: <b>${s.operator}</b> · Ячейки: <b>${s.shelves || '—'}</b></div>
                            <div style="margin-top: 6px; font-size: 11px; color: #f87171;">
                                ${s.alienScans.filter(a => a.isRealParcel).map(a => `<div>• [${new Date(a.time).toLocaleTimeString()}] ${a.text}</div>`).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        if (tab === 'storage') {
            sidebar.style.display = 'none';
            const sessions = await dbGetAll('sessions');
            const scans = await dbGetAll('scans_history');
            const badges = await dbGetAll('client_badges');

            let estUsageMB = 0;
            let estQuotaMB = 0;
            let percentUsed = 0;

            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                estUsageMB = (est.usage / (1024 * 1024)).toFixed(1);
                estQuotaMB = (est.quota / (1024 * 1024)).toFixed(0);
                percentUsed = Math.min(100, Math.max(1, ((est.usage / est.quota) * 100).toFixed(2)));
            }

            const totalAliens = sessions.reduce((acc, s) => acc + (s.alienScans?.length || 0), 0);

            container.innerHTML = `
                <div class="bb-stat-grid">
                    <div class="bb-stat-card">
                        <span class="bb-stat-val">${sessions.length}</span>
                        <span class="bb-stat-lbl">Всего сессий</span>
                    </div>
                    <div class="bb-stat-card">
                        <span class="bb-stat-val">${scans.length}</span>
                        <span class="bb-stat-lbl">Сканирований</span>
                    </div>
                    <div class="bb-stat-card">
                        <span class="bb-stat-val" style="color: ${totalAliens > 0 ? '#ef4444' : '#10b981'};">${totalAliens}</span>
                        <span class="bb-stat-lbl">Аномалий</span>
                    </div>
                    <div class="bb-stat-card">
                        <span class="bb-stat-val" style="color: #38bdf8;">${badges.length}</span>
                        <span class="bb-stat-lbl">Клиентов на контроле</span>
                    </div>
                </div>

                <div class="bb-stat-card" style="margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8;">
                        <span>Использование IndexedDB квоты:</span>
                        <span><b>${estUsageMB} MB</b> из <b>${estQuotaMB} MB</b> (${percentUsed}%)</span>
                    </div>
                    <div class="bb-progress-bar">
                        <div class="bb-progress-fill" style="width: ${percentUsed}%;"></div>
                    </div>
                    <div style="font-size: 10px; color: #64748b;">Хранение локального архива настроено на ${TTL_DAYS} суток. Авто-очистка устаревших пакетов активна.</div>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="bb-btn" id="bb-export-json">💾 Скачать JSON дамп</button>
                    <button class="bb-btn" id="bb-export-csv">📊 Экспорт Excel (CSV)</button>
                    <button class="bb-btn" id="bb-vacuum-scans" style="border-color: #f59e0b; color: #fbbf24;">🧹 Очистить сканы старше 30 дней</button>
                </div>

                ${ENABLE_DEV_PURGE ? `
                    <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid rgba(239, 68, 68, 0.2);">
                        <button class="bb-btn bb-btn-danger" id="bb-purge-btn">⚠️ Полная очистка всей базы BlackBox</button>
                    </div>
                ` : ''}

                <div id="bb-storage-status" style="margin-top: 10px; font-size: 12px; color: #10b981;"></div>
            `;

            container.querySelector('#bb-export-json').onclick = () => {
                const dump = { sessions, scans, badges, exportedAt: Date.now() };
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                downloadBlob(blob, `blackbox_full_dump_${Date.now()}.json`);
            };

            container.querySelector('#bb-export-csv').onclick = () => {
                const header = ['Дата', 'Время', 'Клиент', 'ClientId', 'Код_Выдачи', 'Оператор', 'Ячейки', 'Товаров', 'Длительность_сек', 'Причина'];
                const rows = [header.join(';')];
                sessions.forEach(s => {
                    const d = new Date(s.foundAt);
                    rows.push([
                        d.toLocaleDateString('ru-RU'),
                        d.toLocaleTimeString('ru-RU'),
                        `"${(s.clientName || '').replace(/"/g, '""')}"`,
                        s.clientId || '',
                        s.pickupCode || '',
                        s.operator || '',
                        `"${(s.shelves || '').replace(/"/g, '""')}"`,
                        s.postings?.length || 0,
                        s.durationSec || 0,
                        s.closeReason || ''
                    ].join(';'));
                });
                const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
                downloadBlob(blob, `blackbox_sessions_${Date.now()}.csv`);
            };

            container.querySelector('#bb-vacuum-scans').onclick = async () => {
                const thirtyDays = Date.now() - (30 * 24 * 3600 * 1000);
                const tx = db.transaction('scans_history', 'readwrite');
                const store = tx.objectStore('scans_history');
                const idx = store.index('by_time');
                let delCount = 0;
                idx.openCursor(IDBKeyRange.upperBound(thirtyDays)).onsuccess = (e) => {
                    const c = e.target.result;
                    if (c) { store.delete(c.primaryKey); delCount++; c.continue(); }
                };
                tx.oncomplete = () => {
                    container.querySelector('#bb-storage-status').textContent = `✅ Успешно оптимизировано! Удалено старых сканов: ${delCount}`;
                };
            };

            if (ENABLE_DEV_PURGE) {
                container.querySelector('#bb-purge-btn').onclick = async () => {
                    if (confirm('Стереть абсолютно ВСЕ сессии, сканы и метки клиентов?')) {
                        await clearEntireDB();
                        renderTabContent('storage');
                    }
                };
            }
        }
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    /* =========================================================================
       8. REPLAY INSPECTOR VIEW & CRM CONTROLS
       ========================================================================= */

    async function renderSessionReplay(session) {
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!sidebar) return;

        const badges = await getClientBadges(session.clientId);
        const hasCode = session.pickupCode && !session.pickupCode.includes('----');

        sidebar.innerHTML = `
            <div style="font-weight: 800; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                <span>${session.clientName || 'Без имени'}</span>
                ${hasCode ? `<button class="bb-btn" id="bb-reopen-order-btn" style="padding: 2px 8px; font-size: 11px;">Повторить код</button>` : ''}
            </div>

            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">
                <div>Штрихкод выдачи: <b style="color: #38bdf8; font-family: monospace;">${session.pickupCode || '—'}</b></div>
                <div>ClientId: <b>${session.clientId || '—'}</b> · Оператор: <b>${session.operator || '—'}</b></div>
                <div>Ячейки: <b>${session.shelves || '—'}</b> · Время: <b>${session.durationSec || 0} сек</b></div>
            </div>

            <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span style="font-size: 11px; font-weight: 700; color: #94a3b8;">Метки клиента:</span>
                    <button class="bb-btn" id="bb-sidebar-add-badge" style="padding: 2px 6px; font-size: 10px;">+ Метка</button>
                </div>
                <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                    ${badges.length === 0 ? '<span style="font-size: 11px; color: #64748b;">Нет меток</span>' : ''}
                    ${badges.map(b => `
                        <div style="background: ${b.color}22; border: 1px solid ${b.color}; color: ${b.color}; font-size: 10px; padding: 2px 6px; border-radius: 4px;">
                            ${b.title}
                        </div>
                    `).join('')}
                </div>
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 8px; color: #38bdf8;">Товары (${session.postings?.length || 0}):</div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                ${(session.postings || []).map(p => `
                    <div style="font-size: 11px; background: rgba(255,255,255,0.02); padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                        <div style="font-weight: 600;">${p.name}</div>
                        <div style="color: #64748b; margin-top: 2px;">
                            ${p.barcode} · ${p.price} ₽ ·
                            <span style="font-weight: 700; color: ${p.status === 'issued' ? '#10b981' : (p.status === 'annulated' ? '#ef4444' : '#94a3b8')}">
                                ${p.status === 'issued' ? 'Выдан' : (p.status === 'annulated' ? 'Отказ (' + p.reasonText + ')' : 'На хранении')}
                            </span>
                        </div>
                    </div>
                `).join('')}
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 8px; color: #38bdf8;">Хронология событий:</div>
            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
                ${(session.timeline || []).map(ev => `
                    <div style="font-size: 11px; border-left: 2px solid ${ev.isAlien ? '#ef4444' : '#38bdf8'}; padding-left: 8px;">
                        <span style="color: #64748b; font-family: monospace;">${new Date(ev.time).toLocaleTimeString()}</span>
                        <div style="${ev.isAlien ? 'color: #f87171; font-weight: bold;' : 'color: #e2e8f0;'}">${ev.text}</div>
                    </div>
                `).join('')}
            </div>
        `;

        sidebar.querySelector('#bb-sidebar-add-badge').onclick = () => {
            showCreateBadgeDialog(session.clientId, session.clientName);
        };

        if (hasCode) {
            sidebar.querySelector('#bb-reopen-order-btn').onclick = () => {
                closeInspectorModal();
                sessionStorage.setItem('pending_client_scan', session.pickupCode);
                if (window.location.pathname === '/orders') {
                    const input = document.querySelector('[data-testid="searchInput"]');
                    const btn = document.querySelector('[data-testid="searchButton"]');
                    if (input && btn) {
                        input.value = session.pickupCode;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        setTimeout(() => btn.click(), 80);
                    }
                } else {
                    window.location.href = '/orders';
                }
            };
        }
    }

    // Инициализация
    initDB().then(() => {
        patchRoutingEvents();
        setInterval(renderBadgesInOzonUI, 1000);
    });

})();
