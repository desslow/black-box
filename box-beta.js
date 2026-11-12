// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Ozon BlackBox: Fixed DB Core, Chrono-Timeline & Anti-Fraud Badges
// @author       desslow
// @match        https://*.ozon.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = '_o3_telemetry_cache';
    const DB_VERSION = 1;
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
       1. DATABASE ARCHITECTURE (Надежное подключение на базе v2.1)
       ========================================================================= */

    function initDB() {
        return new Promise((resolve) => {
            const connect = (ver) => {
                const req = ver ? indexedDB.open(DB_NAME, ver) : indexedDB.open(DB_NAME);
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
                };
                req.onsuccess = (e) => {
                    db = e.target.result;
                    if (navigator.storage && navigator.storage.persist) {
                        navigator.storage.persist();
                    }
                    purgeExpiredData();
                    resolve(db);
                };
                req.onerror = () => {
                    // Если в браузере уже была создана версия выше, открываем ее авто-детектом
                    if (req.error && req.error.name === 'VersionError') {
                        connect(null);
                    } else {
                        resolve(null);
                    }
                };
            };
            connect(DB_VERSION);
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
                const cursor = e.target.result;
                if (cursor) { sStore.delete(cursor.primaryKey); cursor.continue(); }
            };

            const scIndex = scStore.index('by_time');
            scIndex.openCursor(IDBKeyRange.upperBound(expireTs)).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { scStore.delete(cursor.primaryKey); cursor.continue(); }
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

    function clearEntireDB() {
        if (!db) return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(['sessions', 'scans_history'], 'readwrite');
                tx.objectStore('sessions').clear();
                tx.objectStore('scans_history').clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /* =========================================================================
       2. CLIENT BADGES ENGINE (Изолированное хранилище localStorage)
       ========================================================================= */

    const BADGES_STORAGE_KEY = '_o3_bb_badges_crm';

    function getAllBadgesMap() {
        try {
            return JSON.parse(localStorage.getItem(BADGES_STORAGE_KEY) || '{}');
        } catch(e) { return {}; }
    }

    function getClientBadges(clientId) {
        if (!clientId) return [];
        const all = getAllBadgesMap();
        return all[String(clientId)] || [];
    }

    function addClientBadge(clientId, title, desc, color = '#ef4444') {
        if (!clientId || !title) return;
        const all = getAllBadgesMap();
        const cId = String(clientId);
        if (!all[cId]) all[cId] = [];

        all[cId].push({
            id: 'b_' + Date.now().toString(36),
            title: title.trim(),
            desc: desc.trim(),
            color: color,
            author: currentOperator || getOperatorLogin() || 'Админ'
        });

        localStorage.setItem(BADGES_STORAGE_KEY, JSON.stringify(all));
        triggerBadgesRerender();
    }

    function removeClientBadge(clientId, badgeId) {
        const all = getAllBadgesMap();
        const cId = String(clientId);
        if (!all[cId]) return;

        all[cId] = all[cId].filter(b => b.id !== badgeId);
        if (all[cId].length === 0) delete all[cId];

        localStorage.setItem(BADGES_STORAGE_KEY, JSON.stringify(all));
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

    function getPillClass(color) {
        if (color === '#f59e0b') return 'bb-pill-yellow';
        if (color === '#005bff' || color === '#3b82f6') return 'bb-pill-blue';
        if (color === '#10b981' || color === '#00873e') return 'bb-pill-green';
        return 'bb-pill-red';
    }

    async function renderBadgesInOzonUI() {
        const sId = getActiveSessionIdOnTab();
        if (!sId) return;

        let session = await dbGet('sessions', sId);
        let clientId = session?.clientId || sessionStorage.getItem('client_id_' + sId);
        let clientName = session?.clientName || '';

        const nameHeader = document.querySelector('[class*="_clientName_"]') ||
                           document.querySelector('[class*="_client_"] [class*="heading"]') ||
                           document.querySelector('[data-testid="client-name"]');
        if (!nameHeader) return;

        if (!clientName) {
            clientName = nameHeader.childNodes[0]?.textContent?.trim() || 'Клиент';
        }

        const effectiveId = clientId || ('s_' + sId);
        const badges = clientId ? getClientBadges(clientId) : [];
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
            <button id="bb-add-badge-quick-btn" class="bb-ozon-add-btn" type="button" title="Добавить метку клиенту">+ Метка</button>
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

        overlay.querySelector('#bb-badge-save').onclick = () => {
            const title = overlay.querySelector('#bb-badge-title-input').value.trim();
            const desc = overlay.querySelector('#bb-badge-desc-input').value.trim();
            if (title) {
                addClientBadge(clientId, title, desc, selectedColor);
                overlay.remove();
            } else {
                overlay.querySelector('#bb-badge-title-input').focus();
            }
        };
    }

    /* =========================================================================
       3. LOGIC & POSTINGS CAPTURE (Стабильная база v2.1 + Фикс оператора)
       ========================================================================= */

    function getOperatorLogin() {
        const el = document.querySelector('[class*="_rightAvatarMenuLogin_"]');
        if (el) currentOperator = el.textContent.trim().replace('PVZ_', '');
        return currentOperator;
    }

    function getActiveSessionIdOnTab() {
        return (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1] || null;
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

    async function handleSessionPostingsData(sessionId, data) {
        if (!data || !data.postings) return;
        const sId = String(sessionId);

        const readyPostings = (data.postings || []).filter(p => p.pvzState === 'ReadyToGiveout' || !p.pvzState);
        currentPostingsList = readyPostings;

        const clientId = data.client?.ozonClientId || data.client?.clientId || '';
        const clientName = data.client?.clientShortName || '';
        const shelves = Array.isArray(data.postingsShelves) ? data.postingsShelves.join(', ') : '';
        const currentCode = sessionStorage.getItem('client_code_' + sId) || (clientId ? `${clientId}*----` : '');

        // Берем логин оператора из ответа сервера Ozon, если доступен
        const apiOp = data.employeeLogin || data.operator || data.session?.employeeLogin || null;

        let session = await dbGet('sessions', sId);

        if (!session) {
            session = {
                sessionId: sId,
                clientId: String(clientId),
                clientName: clientName,
                pickupCode: currentCode,
                foundAt: Date.now(),
                closedAt: null,
                durationSec: 0,
                operator: apiOp || getOperatorLogin() || '—',
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
            if (currentCode && !currentCode.includes('----')) session.pickupCode = currentCode;
            if (apiOp && (!session.operator || session.operator === '—')) session.operator = apiOp;
            if (!session.postings || session.postings.length === 0) {
                session.postings = readyPostings.map(extractPostingDetails);
            }
        }

        activeSession = session;
        await dbPut('sessions', session);
        setTimeout(renderBadgesInOzonUI, 200);
    }

    async function recordTimelineEvent(sId, type, text, isAlien = false, extraData = {}) {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : null);
        if (!targetId) return;

        const session = await dbGet('sessions', targetId);
        if (!session) return;

        const ev = { time: Date.now(), type, text, isAlien, ...extraData };
        session.timeline.push(ev);
        if (isAlien) session.alienScans.push(ev);
        activeSession = session;
        await dbPut('sessions', session);
    }

    async function finalizeActiveSession(sId, reason = 'completed') {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : getActiveSessionIdOnTab());
        if (!targetId) return;

        const session = await dbGet('sessions', String(targetId));
        if (!session || session.closedAt) return;

        session.closedAt = Date.now();
        session.durationSec = Math.max(1, Math.round((session.closedAt - session.foundAt) / 1000));
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
                if (reason === 'completed') {
                    pObj.status = 'issued';
                    issuedCount++;
                } else {
                    pObj.status = 'storage';
                    storageCount++;
                }
            }
        });

        let summaryText = 'Сессия завершена';
        if (reason === 'manual_dock') summaryText = 'Закрыто вручную через Dock';
        else if (reason === 'manual_back') summaryText = 'Выход назад на /orders';
        else if (reason === 'tab_unloaded') summaryText = 'Вкладка закрыта/обновлена';

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
       4. NETWORK INTERCEPTOR (Fetch & XHR)
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

        // Перехват giveout-v3
        if (url.includes('/api2/giveout/Postings/giveout-v3')) {
            try {
                const parsedReq = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
                if (parsedReq && parsedReq.sessionId) {
                    const sId = String(parsedReq.sessionId);
                    const postingsMap = new Map();

                    (parsedReq.postings || []).forEach(p => {
                        const isReturn = Boolean(p.returnReasonId !== null && p.returnReasonId !== undefined) || (p.returnExemplars && p.returnExemplars.length > 0);
                        postingsMap.set(String(p.id), {
                            isReturn,
                            reasonId: p.returnReasonId
                        });
                    });

                    sessionGiveoutPayloads.set(sId, postingsMap);
                    finalizeActiveSession(sId, 'completed');
                }
            } catch (e) {}
        }

        // Перехват загрузки товаров
        if (url.includes('/api2/giveout/Postings') && !url.includes('/giveout-v3') && !url.includes('/giveout-v2')) {
            const match = url.match(/[?&]sessionId=(\d+)/i) || url.match(/sessionId=(\d+)/);
            if (match && resData) {
                const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                handleSessionPostingsData(match[1], parsed);
            }
        }

        if (url.includes('/Payment') || url.includes('/pay')) {
            if (status >= 400) {
                recordTimelineEvent(null, 'payment_failed', '❌ ОШИБКА ОПЛАТЫ ЗАКАЗА', true);
            }
        }

        if (url.includes('/api2/giveout/Sessions') && !url.includes('/close')) {
            const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
            if (parsed && Array.isArray(parsed.sessions)) {
                parsed.sessions.forEach(s => {
                    if (s.sessionId && s.clientId) {
                        sessionStorage.setItem('client_id_' + s.sessionId, String(s.clientId));
                    }
                });
            }
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
            try {
                interceptPayload(self._bUrl, body, self.responseText, self.status);
            } catch (e) {}
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
       5. SCANNER HOOK
       ========================================================================= */

    window.addEventListener('beforeunload', () => finalizeActiveSession(null, 'tab_unloaded'));

    document.addEventListener('click', (e) => {
        if (e.target.closest('.apple-close-btn')) {
            const card = e.target.closest('.apple-session-card');
            const sId = card?.dataset?.sessionId;
            if (sId) finalizeActiveSession(sId, 'manual_dock');
        }
        if (e.target.closest('button') && e.target.closest('button').querySelector('path[d^="M6.293 2.293"]')) {
            finalizeActiveSession(null, 'manual_back');
        }
    }, true);

    document.addEventListener('input', (e) => {
        if (e.target.matches('input[data-testid="searchInput"], input[placeholder*="Штрихкод"], input[placeholder*="коду"]')) {
            const val = e.target.value.trim();
            if (/^\d{5,12}\*\d{3,6}$/.test(val)) {
                sessionStorage.setItem('client_code_pending', val);
                const aId = getActiveSessionIdOnTab();
                if (aId) sessionStorage.setItem('client_code_' + aId, val);
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
        const activeId = getActiveSessionIdOnTab();

        const isClientBarcode = /^\d{5,12}\*\d{3,6}$/.test(clean);
        if (isClientBarcode) {
            const parts = clean.split('*');
            const cId = parts[0];
            sessionStorage.setItem('client_code_pending', barcode);
            if (activeId) {
                sessionStorage.setItem('client_code_' + activeId, barcode);
                const s = await dbGet('sessions', String(activeId));
                if (s) {
                    s.pickupCode = barcode;
                    s.clientId = cId;
                    await dbPut('sessions', s);
                }
            }
            return;
        }

        let isMatchInCurrent = false;

        if (activeId) {
            const session = await dbGet('sessions', String(activeId));
            if (session && session.postings) {
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

        dbPut('scans_history', {
            barcode: barcode,
            sessionId: activeId,
            operator: activeSession?.operator || getOperatorLogin() || '—',
            time: now,
            isAlien: activeId ? !isMatchInCurrent : false
        });
    }

    /* =========================================================================
       6. STYLES (Custom Slim Scrollbars + Opaque Native Tooltip)
       ========================================================================= */

    const unifiedStyle = document.createElement('style');
    unifiedStyle.innerHTML = `
        /* ---------------- КАСТОМНЫЕ ТЕМНЫЕ СКРОЛЛБАРЫ ---------------- */
        #blackbox-modal-root *::-webkit-scrollbar {
            width: 6px !important;
            height: 6px !important;
        }
        #blackbox-modal-root *::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.02) !important;
            border-radius: 4px !important;
        }
        #blackbox-modal-root *::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.16) !important;
            border-radius: 4px !important;
        }
        #blackbox-modal-root *::-webkit-scrollbar-thumb:hover {
            background: #38bdf8 !important;
        }

        /* ---------------- НА ТЕМЕ OZON (СВЕТЛЫЙ ДИЗАЙН OZI) ---------------- */
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
            width: 1180px !important; max-width: 96vw !important; height: 840px !important; max-height: 94vh !important;
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

        /* ---------------- ХРОНОГРАФ СМЕНЫ (ЧЕТКИЙ ВЕРТИКАЛЬНЫЙ ТАЙМЛАЙН) ---------------- */
        .bb-chrono-day { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
        .bb-chrono-day-title {
            font-size: 13px; font-weight: 800; color: #38bdf8; display: flex; justify-content: space-between;
            border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; margin-bottom: 4px;
        }
        .bb-chrono-list { display: flex; flex-direction: column; gap: 8px; }

        .bb-chrono-item {
            background: #111827; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px;
            padding: 10px 14px; cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; gap: 6px;
        }
        .bb-chrono-item:hover { background: #1a2438; border-color: #38bdf8; transform: translateY(-1px); }
        .bb-chrono-item.has-alien { border-left: 3px solid #ef4444 !important; }
        .bb-chrono-item.is-parallel { border-left: 3px solid #c084fc !important; }

        .bb-chrono-head { display: flex; justify-content: space-between; align-items: baseline; }
        .bb-chrono-client { font-weight: 700; font-size: 14px; color: #f8fafc; }
        .bb-chrono-time { font-size: 11px; font-family: monospace; color: #64748b; font-weight: 600; }
        .bb-chrono-meta { display: flex; gap: 8px; font-size: 11px; color: #94a3b8; align-items: center; flex-wrap: wrap; }

        .bb-duration-bar { width: 100%; height: 3px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; margin-top: 2px; }
        .bb-duration-fill { height: 100%; background: #0284c7; border-radius: 2px; }

        .bb-badge-parallel {
            background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); color: #c084fc;
            font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700;
        }
    `;
    document.head.appendChild(unifiedStyle);

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

    async function renderTabContent(tab) {
        const container = document.getElementById('bb-main-content');
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!container) return;

        if (tab === 'sessions') {
            sidebar.style.display = 'flex';
            let sessions = externalDumpData ? externalDumpData.sessions : await dbGetAll('sessions');
            sessions.sort((a, b) => b.foundAt - a.foundAt);

            container.innerHTML = `
                <div style="display: flex; gap: 8px; width: 100%;">
                    <input type="text" class="bb-input" id="bb-session-search" placeholder="Поиск по клиенту, коду, ячейке, оператору..." style="flex: 1;">
                    <input type="text" class="bb-input" id="bb-shelf-search" placeholder="Ячейка..." style="width: 120px;">
                </div>
                <div id="bb-timeline-stream" style="display: flex; flex-direction: column; gap: 14px; margin-top: 6px;"></div>
            `;

            const streamEl = container.querySelector('#bb-timeline-stream');

            function populateTimeline(items) {
                streamEl.innerHTML = '';
                if (items.length === 0) {
                    streamEl.innerHTML = '<div style="color: #64748b; text-align: center; padding: 40px;">Сессии не найдены</div>';
                    return;
                }

                const grouped = {};
                items.forEach((s, idx) => {
                    const key = formatDateKey(s.foundAt);
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push({ s, idx });
                });

                Object.keys(grouped).forEach(dayKey => {
                    const dayItems = grouped[dayKey];
                    const dayBox = document.createElement('div');
                    dayBox.className = 'bb-chrono-day';

                    const d = new Date(dayItems[0].s.foundAt);
                    dayBox.innerHTML = `
                        <div class="bb-chrono-day-title">
                            <span>📅 ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                            <span style="font-size: 11px; color: #94a3b8; font-weight: normal;">${dayItems.length} сессий</span>
                        </div>
                        <div class="bb-chrono-list"></div>
                    `;

                    const list = dayBox.querySelector('.bb-chrono-list');

                    dayItems.forEach(({ s, idx }) => {
                        const hasAlien = s.alienScans && s.alienScans.length > 0;
                        const cBadges = getClientBadges(s.clientId);

                        const parallelWith = items.find((other, oIdx) => {
                            if (oIdx === idx || !s.closedAt || !other.closedAt) return false;
                            return (s.foundAt <= other.closedAt && (s.closedAt || s.foundAt) >= other.foundAt);
                        });

                        const dStart = new Date(s.foundAt);
                        const dEnd = s.closedAt ? new Date(s.closedAt) : null;
                        const timeStr = `${String(dStart.getHours()).padStart(2, '0')}:${String(dStart.getMinutes()).padStart(2, '0')}:${String(dStart.getSeconds()).padStart(2, '0')}${dEnd ? ' → ' + String(dEnd.getHours()).padStart(2, '0') + ':' + String(dEnd.getMinutes()).padStart(2, '0') + ':' + String(dEnd.getSeconds()).padStart(2, '0') : ''}`;

                        const issuedCount = s.postings?.filter(p => p.status === 'issued').length || 0;
                        const totalCount = s.postings?.length || 0;
                        const durationWidth = Math.min(100, Math.max(8, (s.durationSec || 1) / 3));

                        const itemEl = document.createElement('div');
                        itemEl.className = `bb-chrono-item ${hasAlien ? 'has-alien' : ''} ${parallelWith ? 'is-parallel' : ''}`;
                        itemEl.innerHTML = `
                            <div class="bb-chrono-head">
                                <span class="bb-chrono-client">${s.clientName || 'Без имени'}</span>
                                <span class="bb-chrono-time">${timeStr} (${s.durationSec || 0} сек)</span>
                            </div>
                            <div class="bb-chrono-meta">
                                <span>📦 <b>${issuedCount}/${totalCount}</b> выд.</span>
                                <span>Яч. <b>${s.shelves || '—'}</b></span>
                                <span>👤 <b>${s.operator || '—'}</b></span>
                                ${parallelWith ? `<span class="bb-badge-parallel">⚡ Параллельно с ${parallelWith.clientName || 'заказом'}</span>` : ''}
                                ${cBadges.map(b => `<span style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: ${b.color}22; color: ${b.color}; border: 1px solid ${b.color};">⚠️ ${b.title}</span>`).join('')}
                            </div>
                            <div class="bb-duration-bar">
                                <div class="bb-duration-fill" style="width: ${durationWidth}%;"></div>
                            </div>
                        `;
                        itemEl.onclick = () => renderSessionReplay(s);
                        list.appendChild(itemEl);
                    });

                    streamEl.appendChild(dayBox);
                });
            }

            populateTimeline(sessions);

            const searchInp = container.querySelector('#bb-session-search');
            const shelfInp = container.querySelector('#bb-shelf-search');

            function filterTimeline() {
                const q = searchInp.value.toLowerCase().trim();
                const sh = shelfInp.value.toLowerCase().trim();

                const filtered = sessions.filter(s => {
                    const matchName = (s.clientName || '').toLowerCase().includes(q);
                    const matchId = (s.clientId || '').toLowerCase().includes(q);
                    const matchOp = (s.operator || '').toLowerCase().includes(q);
                    const matchCode = (s.pickupCode || '').toLowerCase().includes(q);
                    const matchBarcode = s.postings?.some(p => (p.barcode && p.barcode.toLowerCase().includes(q)));
                    const matchShelf = !sh || (s.shelves || '').toLowerCase().includes(sh);
                    return (matchName || matchId || matchCode || matchBarcode || matchOp) && matchShelf;
                });
                populateTimeline(filtered);
            }

            searchInp.oninput = filterTimeline;
            shelfInp.oninput = filterTimeline;
        }

        if (tab === 'badges') {
            sidebar.style.display = 'none';
            const allBadges = getAllBadgesMap();
            const clientIds = Object.keys(allBadges);

            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8; margin-bottom: 8px;">Реестр персональных меток и черного списка клиентов:</div>
                <div id="bb-badges-table" style="display: flex; flex-direction: column; gap: 8px;"></div>
            `;

            const bTable = container.querySelector('#bb-badges-table');
            if (clientIds.length === 0) {
                bTable.innerHTML = '<div style="color: #64748b; padding: 20px; text-align: center;">Нет созданных меток</div>';
            } else {
                bTable.innerHTML = clientIds.map(cId => `
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-weight: 700; font-size: 14px;">ClientId: ${cId}</div>
                            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                ${(allBadges[cId] || []).map(b => `
                                    <div style="background: ${b.color}22; border: 1px solid ${b.color}; color: ${b.color}; border-radius: 6px; padding: 3px 8px; font-size: 11px;">
                                        <b>${b.title}</b> — ${b.desc} <span style="opacity: 0.6;">(${b.author})</span>
                                        <span class="bb-del-badge-btn" data-cid="${cId}" data-bid="${b.id}" style="margin-left: 6px; cursor: pointer;">✕</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                `).join('');

                bTable.querySelectorAll('.bb-del-badge-btn').forEach(btn => {
                    btn.onclick = () => {
                        removeClientBadge(btn.dataset.cid, btn.dataset.bid);
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
                        <div class="bb-chrono-item ${m.isAlien ? 'has-alien' : ''}">
                            <div style="display: flex; justify-content: space-between;">
                                <span style="font-weight: 700; color: #f8fafc;">${m.barcode}</span>
                                <span style="font-size: 11px; color: #64748b; font-family: monospace;">${time}</span>
                            </div>
                            <div style="font-size: 11px; color: #94a3b8; display: flex; gap: 8px;">
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
            const alienSessions = (sessions || []).filter(s => s.alienScans && s.alienScans.length > 0);

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов товаров Ozon не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold; margin-bottom: 6px;">Реестр опасных сканов (попытка выдать чужой товар):</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${alienSessions.map(s => `
                        <div class="bb-chrono-item has-alien">
                            <div style="display: flex; justify-content: space-between;">
                                <span style="font-weight: 700;">${s.clientName} (Код: ${s.pickupCode || '—'})</span>
                                <span style="font-size: 11px; color: #64748b;">${new Date(s.foundAt).toLocaleString('ru-RU')}</span>
                            </div>
                            <div style="font-size: 12px; color: #94a3b8;">Оператор: <b>${s.operator}</b> · Ячейки: <b>${s.shelves || '—'}</b></div>
                            <div style="margin-top: 6px; font-size: 11px; color: #f87171;">
                                ${s.alienScans.map(a => `<div>• [${new Date(a.time).toLocaleTimeString()}] ${a.text}</div>`).join('')}
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

            let estSize = 0;
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                estSize = (est.usage / (1024 * 1024)).toFixed(2);
            }

            container.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 14px; max-width: 580px;">
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 14px; border-radius: 10px;">
                        <div style="font-weight: bold; margin-bottom: 6px;">Статистика локального хранилища</div>
                        <div style="font-size: 12px; color: #94a3b8;">Сохранено сессий в базе: <b>${sessions.length}</b></div>
                        <div style="font-size: 12px; color: #94a3b8;">Всего сканов в реестре: <b>${scans.length}</b></div>
                        <div style="font-size: 12px; color: #94a3b8;">Занято дискового пространства: <b>${estSize} МБ</b> (Хранение 180 дней)</div>
                    </div>

                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="bb-btn" id="bb-export-json">💾 Скачать JSON дамп</button>
                        <button class="bb-btn" id="bb-export-csv">📊 Экспорт Excel (CSV)</button>
                        <button class="bb-btn" id="bb-vacuum-scans" style="border-color: #f59e0b; color: #fbbf24;">🧹 Очистить сканы старше 30 дней</button>
                    </div>

                    ${ENABLE_DEV_PURGE ? `
                    <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid rgba(239, 68, 68, 0.2);">
                        <button class="bb-btn bb-btn-danger" id="bb-purge-btn">⚠️ Полная очистка всей базы BlackBox</button>
                    </div>` : ''}

                    <div id="bb-storage-status" style="margin-top: 10px; font-size: 12px; color: #10b981;"></div>
                </div>
            `;

            container.querySelector('#bb-export-json').onclick = () => {
                const dump = { sessions, scans, exportedAt: Date.now() };
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                downloadBlob(blob, `blackbox_dump_${Date.now()}.json`);
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
                    if (confirm('Стереть абсолютно ВСЕ сессии и сканы?')) {
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
       8. REPLAY INSPECTOR VIEW
       ========================================================================= */

    async function renderSessionReplay(session) {
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!sidebar) return;

        const badges = getClientBadges(session.clientId);
        const hasCode = session.pickupCode && !session.pickupCode.includes('----');

        sidebar.innerHTML = `
            <div style="font-weight: 800; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                <span>${session.clientName || 'Без имени'}</span>
                ${hasCode ? `<button class="bb-btn" id="bb-reopen-order-btn" style="padding: 2px 8px; font-size: 11px;">Повторить код</button>` : ''}
            </div>

            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">
                <div>Штрихкод выдачи: <b style="color: #38bdf8; font-family: monospace;">${session.pickupCode || '—'}</b></div>
                <div>ClientId: <b>${session.clientId || '—'}</b> · Оператор: <b>${session.operator || '—'}</b></div>
                <div>Ячейки: <b>${session.shelves || '—'}</b> · Длительность: <b>${session.durationSec || 0} сек</b></div>
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
        setInterval(renderBadgesInOzonUI, 1000);
    });

})();
