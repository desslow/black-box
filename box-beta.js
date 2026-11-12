// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Ozon BlackBox
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
       1. DATABASE (Оригинал v2.1)
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
            const sRange = IDBKeyRange.upperBound(expireTs);
            sIndex.openCursor(sRange).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    sStore.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };

            const scIndex = scStore.index('by_time');
            const scRange = IDBKeyRange.upperBound(expireTs);
            scIndex.openCursor(scRange).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    scStore.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };
        } catch (e) {}
    }

    function dbPut(storeName, data) {
        if (!db) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.put(data);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    }

    function dbGet(storeName, key) {
        if (!db) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    function dbGetAll(storeName) {
        if (!db) return Promise.resolve([]);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } catch (e) {
                resolve([]);
            }
        });
    }

    function clearEntireDB() {
        if (!db) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(['sessions', 'scans_history'], 'readwrite');
                tx.objectStore('sessions').clear();
                tx.objectStore('scans_history').clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    /* =========================================================================
       2. CLIENT BADGES (localStorage - не трогает IndexedDB)
       ========================================================================= */

    const BADGES_KEY = '_o3_bb_badges_store';
    function getAllBadges() {
        try { return JSON.parse(localStorage.getItem(BADGES_KEY) || '{}'); } catch(e) { return {}; }
    }
    function getClientBadges(cId) {
        if (!cId) return [];
        return getAllBadges()[String(cId)] || [];
    }
    function saveBadge(cId, title, desc, color) {
        const all = getAllBadges();
        const id = String(cId);
        if (!all[id]) all[id] = [];
        all[id].push({ id: 'b_' + Date.now(), title, desc, color, author: currentOperator || getOperatorLogin() || 'Админ' });
        localStorage.setItem(BADGES_KEY, JSON.stringify(all));
        renderBadgesInOzonUI();
    }
    function deleteBadge(cId, bId) {
        const all = getAllBadges();
        const id = String(cId);
        if (!all[id]) return;
        all[id] = all[id].filter(b => b.id !== bId);
        if (all[id].length === 0) delete all[id];
        localStorage.setItem(BADGES_KEY, JSON.stringify(all));
        renderBadgesInOzonUI();
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

        const session = await dbGet('sessions', sId);
        const clientId = session?.clientId || sessionStorage.getItem('client_id_' + sId);
        if (!clientId) return;

        const nameHeader = document.querySelector('[class*="_clientName_"]') ||
                           document.querySelector('[class*="_client_"] [class*="heading"]') ||
                           document.querySelector('[data-testid="client-name"]');
        if (!nameHeader) return;

        let wrapper = nameHeader.querySelector('#bb-ozon-injected-badges');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = 'bb-ozon-injected-badges';
            nameHeader.appendChild(wrapper);
        }

        const badges = getClientBadges(clientId);
        const renderKey = clientId + '_' + badges.length;
        if (wrapper.dataset.renderedKey === renderKey) return;
        wrapper.dataset.renderedKey = renderKey;

        wrapper.innerHTML = `
            ${badges.map(b => `
                <div class="bb-ozon-pill ${getPillClass(b.color)}">
                    <span>${b.title}</span>
                    <div class="bb-ozon-tooltip">
                        <div style="font-weight: 700; color: #001a34; margin-bottom: 4px; font-size: 13px;">${b.title}</div>
                        <div style="color: #495867;">${b.desc || 'Нет описания'}</div>
                        <div style="font-size: 10px; color: #8c9ba7; margin-top: 6px; border-top: 1px solid #f0f2f5; padding-top: 4px;">Автор: ${b.author}</div>
                    </div>
                </div>
            `).join('')}
            <button id="bb-add-badge-quick-btn" class="bb-ozon-add-btn" type="button">+ Метка</button>
        `;

        wrapper.querySelector('#bb-add-badge-quick-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showBadgeModal(clientId, session?.clientName || 'Клиент');
        };
    }

    function showBadgeModal(clientId, clientName) {
        const old = document.getElementById('bb-dialog-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'bb-dialog-overlay';
        let selColor = '#ef4444';

        overlay.innerHTML = `
            <div class="bb-ozon-dialog">
                <div>
                    <h3 class="bb-dialog-title">Метка клиента</h3>
                    <div class="bb-dialog-sub">${clientName} (ID: ${clientId})</div>
                </div>
                <input type="text" id="bb-b-title" class="bb-ozon-input" placeholder="Название (например: НЕ ОПЛАТИЛ, БРАКЕР)" autofocus>
                <textarea id="bb-b-desc" class="bb-ozon-input" placeholder="Подробности инцидента..." style="height: 70px; resize: none;"></textarea>
                <div class="bb-color-chips">
                    <div class="bb-color-chip bb-pill-red active" data-c="#ef4444">🔴 Опасность</div>
                    <div class="bb-color-chip bb-pill-yellow" data-c="#f59e0b">🟡 Внимание</div>
                    <div class="bb-color-chip bb-pill-blue" data-c="#005bff">🔵 Заметка</div>
                    <div class="bb-color-chip bb-pill-green" data-c="#10b981">🟢 Доверие</div>
                </div>
                <div class="bb-dialog-actions">
                    <button class="bb-btn-ozon-secondary" id="bb-b-cancel" type="button">Отмена</button>
                    <button class="bb-btn-ozon-primary" id="bb-b-save" type="button">Сохранить</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const chips = overlay.querySelectorAll('.bb-color-chip');
        chips.forEach(c => {
            c.onclick = () => {
                chips.forEach(ch => ch.classList.remove('active'));
                c.classList.add('active');
                selColor = c.dataset.c;
            };
        });

        overlay.querySelector('#bb-b-cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.querySelector('#bb-b-save').onclick = () => {
            const title = overlay.querySelector('#bb-b-title').value.trim();
            const desc = overlay.querySelector('#bb-b-desc').value.trim();
            if (title) {
                saveBadge(clientId, title, desc, selColor);
                overlay.remove();
            }
        };
    }

    /* =========================================================================
       3. LOGIC (Оригинал v2.1)
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

        // Сохраняем имя оператора из заказа, если доступно
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
    }

    async function recordTimelineEvent(sId, type, text, isAlien = false, extraData = {}) {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : null);
        if (!targetId) return;

        const session = await dbGet('sessions', targetId);
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
       4. NETWORK INTERCEPTOR (Оригинал v2.1)
       ========================================================================= */

    function interceptPayload(url, data, status = 200) {
        if (url.includes('/api2/giveout/Sessions/close')) {
            let closedId = null;
            if (typeof data === 'string') {
                try { closedId = JSON.parse(data).sessionId; } catch (e) {}
            } else if (data && data.sessionId) {
                closedId = data.sessionId;
            }
            finalizeActiveSession(closedId, 'completed');
        }

        if (url.includes('/api2/giveout/Postings/giveout-v3')) {
            try {
                let parsed = typeof data === 'string' ? JSON.parse(data) : data;
                if (parsed && parsed.sessionId) {
                    const sId = String(parsed.sessionId);
                    const postingsMap = new Map();
                    (parsed.postings || []).forEach(p => {
                        const isReturn = Boolean(p.returnReasonId !== null && p.returnReasonId !== undefined) || (p.returnExemplars && p.returnExemplars.length > 0);
                        postingsMap.set(String(p.id), { isReturn, reasonId: p.returnReasonId });
                    });
                    sessionGiveoutPayloads.set(sId, postingsMap);
                    finalizeActiveSession(sId, 'completed');
                }
            } catch (e) {}
        }

        if (url.includes('/api2/giveout/Postings?sessionId=')) {
            const match = url.match(/sessionId=(\d+)/);
            if (match && data) {
                handleSessionPostingsData(match[1], data);
            }
        }

        if (url.includes('/Payment') || url.includes('/pay')) {
            if (status >= 400) {
                recordTimelineEvent(null, 'payment_failed', '❌ ОШИБКА ПРОВЕДЕНИЯ ОПЛАТЫ', true);
            }
        }

        if (url.includes('/api2/giveout/Sessions') && !url.includes('/close')) {
            if (data && Array.isArray(data.sessions)) {
                data.sessions.forEach(s => {
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

    XMLHttpRequest.prototype.send = function() {
        if (this._bHeaders) captureAuthToken(this._bHeaders);
        const body = arguments[0];
        const self = this;
        this.addEventListener('load', function() {
            try {
                if (self._bUrl.includes('/api2/giveout/Sessions/close')) {
                    interceptPayload(self._bUrl, body, self.status);
                }
                if (self._bUrl.includes('/api2/giveout/Postings/giveout-v3')) {
                    interceptPayload(self._bUrl, body, self.status);
                }
                if (self._bUrl.includes('/api2/giveout/Postings?sessionId=')) {
                    interceptPayload(self._bUrl, JSON.parse(self.responseText), self.status);
                }
                if (self._bUrl.includes('/api2/giveout/Sessions')) {
                    interceptPayload(self._bUrl, JSON.parse(self.responseText), self.status);
                }
                if (self._bUrl.includes('/Payment') || self._bUrl.includes('/pay')) {
                    interceptPayload(self._bUrl, null, self.status);
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const config = args[1];
            if (config && config.headers) {
                captureAuthToken(new Headers(config.headers));
            }
        } catch (e) {}

        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const response = await origFetch.apply(this, args);

        try {
            if (url.includes('/api2/giveout/Sessions/close')) {
                interceptPayload(url, args[1]?.body, response.status);
            }
            if (url.includes('/api2/giveout/Postings/giveout-v3')) {
                interceptPayload(url, args[1]?.body, response.status);
            }
            if (url.includes('/api2/giveout/Postings?sessionId=')) {
                response.clone().json().then(data => interceptPayload(url, data, response.status)).catch(() => {});
            }
            if (url.includes('/api2/giveout/Sessions')) {
                response.clone().json().then(data => interceptPayload(url, data, response.status)).catch(() => {});
            }
            if (url.includes('/Payment') || url.includes('/pay')) {
                interceptPayload(url, null, response.status);
            }
        } catch (e) {}

        return response;
    };

    window.addEventListener('beforeunload', () => {
        finalizeActiveSession(null, 'tab_unloaded');
    });

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
                e.stopPropagation();
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
                const cleaned = translit(raw);
                processBarcodeScan(cleaned);
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
                            recordTimelineEvent(activeId, 'junk_scan', `ℹ️ Служебный/Внешний ШК: ${barcode}`, false, { barcode, isRealParcel: false });
                        }
                    });
                }
            }
        }

        dbPut('scans_history', {
            barcode: barcode,
            sessionId: activeId,
            operator: currentOp,
            time: now,
            isAlien: activeId ? !isMatchInCurrent : false
        });
    }

    /* =========================================================================
       5. STYLES (Тонкие темные скроллбары + Непрозрачный нативный тултип)
       ========================================================================= */

    const modalStyle = document.createElement('style');
    modalStyle.innerHTML = `
        /* ---------------- ТЕМНЫЕ СКРОЛЛБАРЫ ---------------- */
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

        /* ---------------- НА ТЕМЕ OZON (СВЕТЛЫЙ OZI) ---------------- */
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
        .bb-ozon-add-btn:hover { background: #e8f2ff !important; border-color: #b8d5ff !important; }

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
            font-size: 14px !important; color: #001a34 !important; outline: none !important;
        }
        .bb-ozon-input:focus { border-color: #005bff !important; }
        .bb-color-chips { display: flex !important; gap: 8px !important; }
        .bb-color-chip {
            flex: 1 !important; padding: 7px 4px !important; border-radius: 8px !important; font-size: 12px !important;
            font-weight: 600 !important; text-align: center !important; cursor: pointer !important; border: 2px solid transparent !important;
            user-select: none !important;
        }
        .bb-color-chip.active { border-color: #001a34 !important; }

        .bb-dialog-actions { display: flex !important; justify-content: flex-end !important; gap: 10px !important; margin-top: 6px !important; }
        .bb-btn-ozon-secondary {
            background: #f2f5f9 !important; color: #001a34 !important; border: none !important; padding: 9px 16px !important;
            border-radius: 8px !important; font-weight: 600 !important; font-size: 13px !important; cursor: pointer !important;
        }
        .bb-btn-ozon-primary {
            background: #005bff !important; color: #ffffff !important; border: none !important; padding: 9px 18px !important;
            border-radius: 8px !important; font-weight: 600 !important; font-size: 13px !important; cursor: pointer !important;
        }

        /* ---------------- BLACKBOX MODAL ---------------- */
        #blackbox-modal-root {
            position: fixed !important;
            top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.8) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            z-index: 10000000 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important;
            color: #f8fafc !important;
            overscroll-behavior: contain !important;
        }

        .bb-window {
            width: 1080px !important;
            max-width: 96vw !important;
            height: 780px !important;
            max-height: 92vh !important;
            background: #0f172a !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 16px !important;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75) !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
            overscroll-behavior: contain !important;
        }

        .bb-header {
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            padding: 14px 20px !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
            background: rgba(255, 255, 255, 0.02) !important;
        }
        .bb-title {
            font-size: 15px !important;
            font-weight: 800 !important;
            letter-spacing: 0.5px !important;
            color: #f8fafc !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
        }
        .bb-title span { color: #38bdf8 !important; }

        .bb-tabs { display: flex !important; gap: 6px !important; }
        .bb-tab-btn {
            background: transparent !important;
            border: 1px solid transparent !important;
            color: #94a3b8 !important;
            padding: 5px 12px !important;
            border-radius: 8px !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            transition: all 0.15s !important;
        }
        .bb-tab-btn:hover { color: #fff !important; background: rgba(255, 255, 255, 0.05) !important; }
        .bb-tab-btn.active {
            color: #38bdf8 !important;
            background: rgba(56, 189, 248, 0.12) !important;
            border-color: rgba(56, 189, 248, 0.3) !important;
        }

        .bb-close { color: #64748b !important; cursor: pointer !important; font-size: 18px !important; padding: 2px 6px !important; }
        .bb-close:hover { color: #fff !important; }

        .bb-body { flex: 1 1 auto !important; display: flex !important; overflow: hidden !important; overscroll-behavior: contain !important; }
        .bb-main-view { flex: 1 1 auto !important; padding: 16px !important; overflow-y: auto !important; display: flex !important; flex-direction: column !important; gap: 10px !important; overscroll-behavior: contain !important; }
        .bb-replay-view { width: 440px !important; min-width: 440px !important; border-left: 1px solid rgba(255, 255, 255, 0.08) !important; background: #090d16 !important; padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 10px !important; overflow-y: auto !important; overscroll-behavior: contain !important; }

        .bb-input {
            background: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            color: #fff !important;
            padding: 8px 12px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            outline: none !important;
            box-sizing: border-box !important;
        }
        .bb-input:focus { border-color: #38bdf8 !important; }

        .bb-filter-row {
            display: flex !important;
            gap: 8px !important;
            width: 100% !important;
        }

        .bb-accordion {
            border: 1px solid rgba(255, 255, 255, 0.08) !important;
            border-radius: 10px !important;
            background: rgba(255, 255, 255, 0.01) !important;
            overflow: hidden !important;
        }
        .bb-accordion-summary {
            padding: 10px 14px !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            color: #38bdf8 !important;
            cursor: pointer !important;
            display: flex !important;
            justify-content: space-between !important;
            align-items: center !important;
            background: rgba(56, 189, 248, 0.06) !important;
            user-select: none !important;
        }
        .bb-accordion-body {
            padding: 8px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
        }

        .bb-card {
            background: rgba(255, 255, 255, 0.03) !important;
            border: 1px solid rgba(255, 255, 255, 0.06) !important;
            border-radius: 10px !important;
            padding: 10px 14px !important;
            cursor: pointer !important;
            transition: all 0.15s !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
        }
        .bb-card:hover {
            background: rgba(255, 255, 255, 0.06) !important;
            border-color: rgba(255, 255, 255, 0.15) !important;
        }
        .bb-card.has-alien { border-left: 3px solid #ef4444 !important; }
        .bb-card.is-parallel { border-left: 3px solid #c084fc !important; }

        .bb-card-head { display: flex !important; justify-content: space-between !important; align-items: center !important; }
        .bb-card-name { font-weight: 700; font-size: 14px; color: #f8fafc; }
        .bb-card-time { font-size: 11px; color: #64748b; font-family: monospace; }
        .bb-card-sub { font-size: 12px; color: #94a3b8; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

        .bb-duration-bar { width: 100%; height: 3px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; margin-top: 2px; }
        .bb-duration-fill { height: 100%; background: #0284c7; border-radius: 2px; }

        .bb-tag { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
        .bb-tag-warn { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .bb-tag-parallel { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }

        .bb-timeline-node {
            position: relative !important;
            padding-left: 18px !important;
            border-left: 2px solid rgba(255, 255, 255, 0.1) !important;
            margin-left: 6px !important;
            padding-bottom: 12px !important;
        }
        .bb-timeline-node::before {
            content: ''; position: absolute; left: -5px; top: 2px;
            width: 8px; height: 8px; border-radius: 50%; background: #38bdf8;
        }
        .bb-timeline-node.alien::before { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
        .bb-timeline-time { font-size: 10px; color: #64748b; font-family: monospace; }
        .bb-timeline-text { font-size: 12px; color: #e2e8f0; font-weight: 500; }

        .bb-btn {
            background: #1c3557;
            color: #38bdf8;
            border: 1px solid #2b4260;
            padding: 8px 14px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        }
        .bb-btn:hover { background: #007aff; color: #fff; }
        .bb-btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }
        .bb-btn-danger:hover { background: #ef4444; color: #fff; }

        .bb-notice-bar {
            background: rgba(56, 189, 248, 0.12);
            border: 1px solid rgba(56, 189, 248, 0.3);
            color: #38bdf8;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
    `;
    document.head.appendChild(modalStyle);

    function toggleInspectorModal() {
        let m = document.getElementById('blackbox-modal-root');
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
                        <button class="bb-tab-btn active" data-tab="sessions">Журнал смены</button>
                        <button class="bb-tab-btn" data-tab="badges">🏷️ Метки клиентов</button>
                        <button class="bb-tab-btn" data-tab="lookup">Поиск «Потеряшки»</button>
                        <button class="bb-tab-btn" data-tab="aliens">⚠️ Аномалии</button>
                        <button class="bb-tab-btn" data-tab="storage">База данных</button>
                    </div>
                    <span class="bb-close" id="bb-close-btn">✕</span>
                </div>
                <div class="bb-body">
                    <div class="bb-main-view" id="bb-main-content"></div>
                    <div class="bb-replay-view" id="bb-replay-sidebar">
                        <div style="color: #64748b; font-size: 13px; text-align: center; margin-top: 40px;">Выберите сессию для посекундной реконструкции</div>
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

    function formatDateDivider(timestamp) {
        const d = new Date(timestamp);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (isToday) return 'Сегодня';
        if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function buildCsvData(sessions) {
        const header = ['Дата', 'Время', 'Клиент', 'ClientId', 'Код_Выдачи', 'Оператор', 'Ячейки', 'Всего_товаров', 'Длительность_сек', 'Причина_закрытия', 'Чужих_сканов'];
        const rows = [header.join(';')];

        sessions.forEach(s => {
            const d = new Date(s.foundAt);
            const dateStr = d.toLocaleDateString('ru-RU');
            const timeStr = d.toLocaleTimeString('ru-RU');
            const row = [
                dateStr,
                timeStr,
                `"${(s.clientName || '').replace(/"/g, '""')}"`,
                s.clientId || '',
                s.pickupCode || '',
                s.operator || '',
                `"${(s.shelves || '').replace(/"/g, '""')}"`,
                s.postings?.length || 0,
                s.durationSec || 0,
                s.closeReason || '',
                s.alienScans?.length || 0
            ];
            rows.push(row.join(';'));
        });

        return rows.join('\r\n');
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
                ${externalDumpData ? `<div class="bb-notice-bar"><span>📂 Просмотр внешнего дампа (${sessions.length} сессий)</span><button class="bb-btn" id="bb-exit-dump-view" style="padding: 2px 8px;">Вернуться в свою базу</button></div>` : ''}
                <div class="bb-filter-row">
                    <input type="text" class="bb-input" id="bb-session-search" placeholder="Поиск по клиенту, штрихкоду, ячейке, оператору...">
                    <input type="text" class="bb-input" id="bb-shelf-search" placeholder="Ячейка..." style="width: 120px;">
                </div>
                <div id="bb-sessions-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
            `;

            if (externalDumpData) {
                container.querySelector('#bb-exit-dump-view').onclick = () => {
                    externalDumpData = null;
                    renderTabContent('sessions');
                };
            }

            const listEl = container.querySelector('#bb-sessions-list');

            function populate(items) {
                listEl.innerHTML = '';
                if (items.length === 0) {
                    listEl.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">Нет данных</div>';
                    return;
                }

                const grouped = {};
                items.forEach((s, idx) => {
                    const key = formatDateKey(s.foundAt);
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push({ s, idx });
                });

                Object.keys(grouped).forEach(k => {
                    const groupItems = grouped[k];
                    const firstDate = groupItems[0].s.foundAt;
                    const dateTitle = formatDateDivider(firstDate);

                    const details = document.createElement('details');
                    details.className = 'bb-accordion';
                    details.open = true;

                    details.innerHTML = `
                        <summary class="bb-accordion-summary">
                            <span>${dateTitle}</span>
                            <span style="color: rgba(255,255,255,0.4);">${groupItems.length} сессий</span>
                        </summary>
                        <div class="bb-accordion-body"></div>
                    `;

                    const body = details.querySelector('.bb-accordion-body');

                    groupItems.forEach(({ s, idx }) => {
                        const hasAlien = s.alienScans && s.alienScans.some(a => a.isRealParcel);
                        const isParallel = items.some((other, oIdx) => {
                            if (oIdx === idx || !s.closedAt || !other.closedAt) return false;
                            return (s.foundAt <= other.closedAt && (s.closedAt || s.foundAt) >= other.foundAt);
                        });

                        const dStart = new Date(s.foundAt);
                        const dEnd = s.closedAt ? new Date(s.closedAt) : null;
                        const timeStr = `${String(dStart.getHours()).padStart(2, '0')}:${String(dStart.getMinutes()).padStart(2, '0')}:${String(dStart.getSeconds()).padStart(2, '0')}${dEnd ? ' → ' + String(dEnd.getHours()).padStart(2, '0') + ':' + String(dEnd.getMinutes()).padStart(2, '0') : ''}`;

                        const durationWidth = Math.min(100, Math.max(6, (s.durationSec || 1) / 3));
                        const cBadges = getClientBadges(s.clientId);

                        const card = document.createElement('div');
                        card.className = `bb-card ${hasAlien ? 'has-alien' : ''} ${isParallel ? 'is-parallel' : ''}`;
                        card.innerHTML = `
                            <div class="bb-card-head">
                                <span class="bb-card-name">${s.clientName || 'Без имени'}</span>
                                <span class="bb-card-time">${timeStr} (${s.durationSec || 0}с)</span>
                            </div>
                            <div class="bb-card-sub">
                                <span>📦 ${s.postings?.length || 0} тов.</span>
                                <span>Яч. ${s.shelves || '—'}</span>
                                <span>👤 ${s.operator || '—'}</span>
                                ${hasAlien ? `<span class="bb-tag bb-tag-warn">⚠️ Чужой пик</span>` : ''}
                                ${isParallel ? `<span class="bb-tag bb-tag-parallel">⚡ Параллельно</span>` : ''}
                                ${cBadges.map(b => `<span style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: ${b.color}22; color: ${b.color}; border: 1px solid ${b.color}; font-weight: 700;">⚠️ ${b.title}</span>`).join('')}
                            </div>
                            <div class="bb-duration-bar">
                                <div class="bb-duration-fill" style="width: ${durationWidth}%;"></div>
                            </div>
                        `;
                        card.onclick = () => renderSessionReplay(s);
                        body.appendChild(card);
                    });

                    listEl.appendChild(details);
                });
            }

            populate(sessions);

            const searchInp = container.querySelector('#bb-session-search');
            const shelfInp = container.querySelector('#bb-shelf-search');

            function applyFilters() {
                const q = searchInp.value.toLowerCase().trim();
                const sh = shelfInp.value.toLowerCase().trim();

                const filtered = sessions.filter(s => {
                    const matchName = (s.clientName || '').toLowerCase().includes(q);
                    const matchId = (s.clientId || '').toLowerCase().includes(q);
                    const matchCode = (s.pickupCode || '').toLowerCase().includes(q);
                    const matchOp = (s.operator || '').toLowerCase().includes(q);
                    const matchBarcode = s.postings?.some(p => (p.barcode && p.barcode.toLowerCase().includes(q)) || p.allBarcodes?.some(b => b.includes(q)));
                    const matchShelf = !sh || (s.shelves || '').toLowerCase().includes(sh);

                    return (matchName || matchId || matchCode || matchBarcode || matchOp) && matchShelf;
                });
                populate(filtered);
            }

            searchInp.oninput = applyFilters;
            shelfInp.oninput = applyFilters;
        }

        if (tab === 'badges') {
            sidebar.style.display = 'none';
            const allBadges = getAllBadges();
            const clientIds = Object.keys(allBadges);

            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8; margin-bottom: 8px;">Реестр меток клиентов (Черный список / CRM):</div>
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
                        deleteBadge(btn.dataset.cid, btn.dataset.bid);
                        renderTabContent('badges');
                    };
                });
            }
        }

        if (tab === 'lookup') {
            sidebar.style.display = 'none';
            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8; margin-bottom: 4px;">Поиск перемещений штрихкода по всей базе:</div>
                <input type="text" class="bb-input" id="bb-lookup-input" placeholder="Вставьте ШК товара...">
                <div id="bb-lookup-results" style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;"></div>
            `;

            const input = container.querySelector('#bb-lookup-input');
            const resEl = container.querySelector('#bb-lookup-results');

            input.oninput = async () => {
                const val = translit(input.value.trim().toLowerCase());
                if (val.length < 3) {
                    resEl.innerHTML = '';
                    return;
                }

                const allScans = externalDumpData ? externalDumpData.scans : await dbGetAll('scans_history');
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
                        <div class="bb-card ${m.isAlien ? 'has-alien' : ''}">
                            <div class="bb-card-head">
                                <span class="bb-card-name">${m.barcode}</span>
                                <span class="bb-card-time">${time}</span>
                            </div>
                            <div class="bb-card-sub">
                                <span>Оператор: <b>${m.operator}</b></span>
                                ${m.isAlien ? '<span class="bb-tag bb-tag-warn">⚠️ ПИКНУТ В ЧУЖОМ ЗАКАЗЕ</span>' : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            };
        }

        if (tab === 'aliens') {
            sidebar.style.display = 'none';
            const sessions = externalDumpData ? externalDumpData.sessions : await dbGetAll('sessions');
            const alienSessions = (sessions || []).filter(s => s.alienScans && s.alienScans.some(a => a.isRealParcel));

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов товаров Ozon не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold; margin-bottom: 6px;">Реестр опасных сканов (товар принадлежал другому клиенту/складу):</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${alienSessions.map(s => `
                        <div class="bb-card has-alien">
                            <div class="bb-card-head">
                                <span class="bb-card-name">${s.clientName} (Код: ${s.pickupCode || '—'})</span>
                                <span class="bb-card-time">${new Date(s.foundAt).toLocaleString('ru-RU')}</span>
                            </div>
                            <div class="bb-card-sub">
                                <span>Оператор: <b>${s.operator}</b></span>
                                <span>Ячейки: <b>${s.shelves || '—'}</b></span>
                            </div>
                            <div style="margin-top: 6px; font-size: 12px; color: #f87171;">
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
                        <button class="bb-btn" id="bb-export-json">💾 Дамп JSON</button>
                        <button class="bb-btn" id="bb-export-csv">📊 Экспорт Excel (CSV)</button>
                        <button class="bb-btn" id="bb-import-btn">📥 Слияние баз</button>
                        <button class="bb-btn" id="bb-view-dump-btn" style="background: #0284c7; color: #fff;">📂 Открыть чужой дамп</button>
                        <input type="file" id="bb-import-file" accept=".json" style="display: none;">
                        <input type="file" id="bb-view-file" accept=".json" style="display: none;">
                    </div>

                    ${ENABLE_DEV_PURGE ? `
                    <div style="margin-top: 20px; padding-top: 14px; border-top: 1px solid rgba(239, 68, 68, 0.2);">
                        <button class="bb-btn bb-btn-danger" id="bb-purge-btn">⚠️ Очистить базу (DEV)</button>
                    </div>` : ''}

                    <div id="bb-storage-status" style="font-size: 12px; color: #10b981;"></div>
                </div>
            `;

            container.querySelector('#bb-export-json').onclick = () => {
                const dump = { sessions, scans, exportedAt: Date.now() };
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                downloadBlob(blob, `blackbox_dump_${Date.now()}.json`);
            };

            container.querySelector('#bb-export-csv').onclick = () => {
                const csv = buildCsvData(sessions);
                const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
                downloadBlob(blob, `blackbox_export_${Date.now()}.csv`);
            };

            const fileInp = container.querySelector('#bb-import-file');
            container.querySelector('#bb-import-btn').onclick = () => fileInp.click();

            fileInp.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const imported = JSON.parse(ev.target.result);
                        let addedSessions = 0;
                        if (Array.isArray(imported.sessions)) {
                            for (let s of imported.sessions) {
                                await dbPut('sessions', s);
                                addedSessions++;
                            }
                        }
                        if (Array.isArray(imported.scans)) {
                            for (let sc of imported.scans) {
                                delete sc.id;
                                await dbPut('scans_history', sc);
                            }
                        }
                        container.querySelector('#bb-storage-status').textContent = `✅ Успешно! Добавлено сессий: ${addedSessions}`;
                    } catch (err) {
                        container.querySelector('#bb-storage-status').textContent = '❌ Ошибка чтения файла дампа';
                    }
                };
                reader.readAsText(file);
            };

            const viewInp = container.querySelector('#bb-view-file');
            container.querySelector('#bb-view-dump-btn').onclick = () => viewInp.click();

            viewInp.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        externalDumpData = JSON.parse(ev.target.result);
                        const tabs = document.querySelectorAll('.bb-tab-btn');
                        tabs.forEach(tb => tb.classList.remove('active'));
                        document.querySelector('[data-tab="sessions"]').classList.add('active');
                        renderTabContent('sessions');
                    } catch (err) {
                        container.querySelector('#bb-storage-status').textContent = '❌ Файл поврежден или не является дампом';
                    }
                };
                reader.readAsText(file);
            };

            if (ENABLE_DEV_PURGE) {
                container.querySelector('#bb-purge-btn').onclick = async () => {
                    if (confirm('Стереть ВСЕ накопленные данные из базы?')) {
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
       8. REPLAY (Оригинал v2.1)
       ========================================================================= */

    function renderSessionReplay(session) {
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!sidebar) return;

        const hasCode = session.pickupCode && session.pickupCode.includes('*');
        const badges = getClientBadges(session.clientId);

        sidebar.innerHTML = `
            <div style="font-weight: 800; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                <span>Реконструкция: ${session.clientName || 'Без имени'}</span>
                ${hasCode ? `<button class="bb-btn" id="bb-reopen-order-btn" style="padding: 2px 8px; font-size: 11px;">Повторить выдачу</button>` : ''}
            </div>
            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">
                <div>Штрихкод / ID: <b>${session.pickupCode || session.clientId || '—'}</b></div>
                <div>Оператор: <b>${session.operator || '—'}</b> · Ячейки: <b>${session.shelves || '—'}</b></div>
                <div>Длительность: <b>${session.durationSec || 0} сек</b> (${session.closeReason || 'завершено'})</div>
            </div>

            <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span style="font-size: 11px; font-weight: 700; color: #94a3b8;">Метки клиента:</span>
                    <button class="bb-btn" id="bb-sidebar-add-b" style="padding: 2px 6px; font-size: 10px;">+ Метка</button>
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

            <div style="font-size: 12px; font-weight: 700; margin-top: 10px; color: #38bdf8;">Товары заказа (${session.postings?.length || 0}):</div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                ${(session.postings || []).map(p => `
                    <div style="font-size: 11px; background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                        <div style="font-weight: 600; color: #f8fafc;">${p.name}</div>
                        <div style="color: #64748b; margin-top: 2px;">
                            ${p.barcode} · ${p.price} ₽ · 
                            <span style="font-weight: 700; color: ${p.status === 'issued' ? '#10b981' : (p.status === 'annulated' ? '#ef4444' : '#94a3b8')}">
                                ${p.status === 'issued' ? 'Выдан' : (p.status === 'annulated' ? 'Отказ (' + p.reasonText + ')' : 'На хранении')}
                            </span>
                        </div>
                    </div>
                `).join('')}
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 10px; color: #38bdf8;">Хронология событий:</div>
            <div style="display: flex; flex-direction: column; margin-top: 4px;">
                ${(session.timeline || []).map(ev => `
                    <div class="bb-timeline-node ${ev.isAlien ? 'alien' : ''}">
                        <div class="bb-timeline-time">${new Date(ev.time).toLocaleTimeString()}</div>
                        <div class="bb-timeline-text" style="${ev.isAlien ? 'color: #f87171; font-weight: bold;' : ''}">${ev.text}</div>
                    </div>
                `).join('')}
            </div>
        `;

        sidebar.querySelector('#bb-sidebar-add-b').onclick = () => {
            showBadgeModal(session.clientId, session.clientName);
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

    // Запуск
    initDB();
    setInterval(renderBadgesInOzonUI, 1000);

})();
