// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      5.1.1
// @description  Ozon BlackBox 5.1.1 - Fixed Keydown Hotkeys & Full Core
// @author       desslow
// @match        https://*.ozon.ru/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      prsstkodpfugnyazrxrp.supabase.co
// ==/UserScript==

(function() {
    'use strict';

    const SUPABASE_URL = '';
    const SUPABASE_KEY = '';
    const PVZ_LIST = ['PVZ_2210', 'PVZ_2379', 'PVZ_3021', 'PVZ_3228', 'PVZ_3239'];

    function getPvzId() {
        let saved = localStorage.getItem('bb_current_pvz');
        if (!saved || !PVZ_LIST.includes(saved)) {
            saved = prompt(`[BlackBox] Выберите ПВЗ для этого ПК:\n${PVZ_LIST.join(', ')}`, PVZ_LIST[0]);
            if (!PVZ_LIST.includes(saved)) saved = PVZ_LIST[0];
            localStorage.setItem('bb_current_pvz', saved);
        }
        return saved;
    }
    const CURRENT_PVZ = getPvzId();

    function getDeviceId() {
        let dId = localStorage.getItem('bb_device_id');
        if (!dId) {
            dId = 'DEV_' + Math.random().toString(36).slice(2, 9).toUpperCase();
            localStorage.setItem('bb_device_id', dId);
        }
        return dId;
    }
    const DEVICE_ID = getDeviceId();

    const DB_NAME = '_o3_telemetry_cache_v5';
    const DB_VERSION = 1;
    const TTL_DAYS = 180;
    const ENABLE_DEV_PURGE = true;
    const MAX_TREE_DEPTH = 5;

    let db = null;
    let scanBuffer = '';
    let lastScanTime = Date.now();
    let currentOperator = '';
    let activeSession = null;
    let currentPostingsList = [];
    let externalDumpData = null;
    window._ozonAuthHeaders = null;

    let currentSortOrder = 'desc';
    const postingsInboundCache = new Map();
    const pendingGiveoutTasks = new Map();
    const sessionGiveoutPayloads = new Map();
    const dismissedAlerts = new Set();

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

    // ================= SUPABASE CLIENT =================
    function supabaseReq(endpoint, method = 'GET', body = null) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: method,
                url: `${SUPABASE_URL}/rest/v1/${endpoint}`,
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                },
                data: body ? JSON.stringify(body) : null,
                onload: (res) => {
                    try { resolve(res.responseText ? JSON.parse(res.responseText) : null); }
                    catch (e) { resolve(null); }
                },
                onerror: () => resolve(null)
            });
        });
    }

    function getDismissedAlerts() {
        try {
            return new Set(JSON.parse(localStorage.getItem('bb_dismissed_alerts') || '[]'));
        } catch (e) { return new Set(); }
    }

    function saveDismissedAlert(id) {
        const set = getDismissedAlerts();
        set.add(String(id));
        localStorage.setItem('bb_dismissed_alerts', JSON.stringify([...set]));
    }


    async function cloudSyncSession(session) {
        if (!session || !session.sessionId) return;
        const payload = {
            session_id: String(session.sessionId),
            pvz_id: CURRENT_PVZ,
            client_id: session.clientId || '',
            client_name: session.clientName || '',
            pickup_code: session.pickupCode || '',
            operator: session.operator || '',
            shelves: session.shelves || '',
            found_at: session.foundAt,
            closed_at: session.closedAt,
            duration_sec: session.durationSec || 0,
            close_reason: session.closeReason || 'active',
            postings: session.postings || [],
            timeline: session.timeline || [],
            alien_scans: session.alienScans || [],
            updated_at: new Date().toISOString()
        };
        supabaseReq('sessions?on_conflict=session_id', 'POST', payload);
    }

    async function cloudSyncScan(scan) {
        if (!scan) return;
        const payload = {
            pvz_id: CURRENT_PVZ,
            barcode: scan.barcode,
            session_id: scan.sessionId || null,
            client_name: scan.clientName || '',
            operator: scan.operator || '',
            time: scan.time,
            is_alien: Boolean(scan.isAlien)
        };
        supabaseReq('scans_history', 'POST', payload);
    }

    async function cloudSyncTagsPull() {
        const cloudData = await supabaseReq('client_tags?select=*', 'GET');
        if (Array.isArray(cloudData)) {
            for (let item of cloudData) {
                if (item.client_id) {
                    await dbPut('client_tags', {
                        clientId: String(item.client_id),
                        tags: item.tags || []
                    });
                }
            }
        }
    }

    async function cloudSyncTagPush(clientId, tags) {
        const payload = {
            client_id: String(clientId),
            tags: tags || [],
            updated_at: new Date().toISOString()
        };
        supabaseReq('client_tags?on_conflict=client_id', 'POST', payload);
    }

    async function sendDeviceHeartbeat() {
        let usageMb = 0, quotaMb = 0, percent = 0;
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const est = await navigator.storage.estimate();
                usageMb = Number((est.usage / (1024 * 1024)).toFixed(2));
                quotaMb = Number((est.quota / (1024 * 1024)).toFixed(2));
                percent = Number(Math.min(100, (est.usage / est.quota) * 100).toFixed(2));
            } catch (e) {}
        }

        const payload = {
            device_id: DEVICE_ID,
            pvz_id: CURRENT_PVZ,
            current_operator: getOperatorLogin() || 'Не авторизован',
            disk_usage_mb: usageMb,
            disk_quota_mb: quotaMb,
            disk_percent: percent,
            tab_id: TAB_ID,
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        supabaseReq('devices?on_conflict=device_id', 'POST', payload);
    }

    function recordInboundRelay(barcode, cell, op) {
        const payload = {
            pvz_id: CURRENT_PVZ,
            barcode: barcode || '—',
            cell: cell || '—',
            operator: op || getOperatorLogin() || 'Склад',
            time: Date.now()
        };
        supabaseReq('inbounds', 'POST', payload);
    }

    async function checkRemoteAlerts() {
        const dismissed = getDismissedAlerts();
        const query = `alerts?is_active=eq.true&or=(target_scope.eq.ALL,and(target_scope.eq.PVZ,target_value.eq.${CURRENT_PVZ}),and(target_scope.eq.DEVICE,target_value.eq.${DEVICE_ID}))`;
        const alerts = await supabaseReq(query, 'GET');
        
        if (Array.isArray(alerts) && alerts.length > 0) {
            for (let a of alerts) {
                if (!dismissed.has(String(a.id))) {
                    renderOzonNativeAlert(a);
                    break; // Показываем по одному, чтобы не спамить экран
                }
            }
        }
    }


    function renderOzonNativeAlert(alertObj) {
        if (document.getElementById(`bb-alert-${alertObj.id}`)) return;

        let container = document.getElementById('bb-notifications-root');
        if (!container) {
            container = document.createElement('div');
            container.id = 'bb-notifications-root';
            container.style.cssText = 'position: fixed !important; top: 20px !important; right: 24px !important; z-index: 9999999 !important; display: flex !important; flex-direction: column !important; gap: 8px !important; pointer-events: none !important;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.id = `bb-alert-${alertObj.id}`;
        toast.style.cssText = 'pointer-events: auto !important; animation: slideUpPanel 0.25s ease-out !important;';
        toast.innerHTML = `
            <div style="background: #0f172a !important; color: #fff !important; border: 1.5px solid #ef4444 !important; border-radius: 12px !important; padding: 12px 16px !important; display: flex !important; align-items: flex-start !important; gap: 12px !important; box-shadow: 0 10px 35px rgba(0,0,0,0.7) !important; max-width: 380px !important; box-sizing: border-box !important;">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="#ef4444" style="flex-shrink:0; margin-top: 2px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <div style="flex: 1;">
                    <div style="font-weight: 800; font-size: 13px; color: #f87171; margin-bottom: 2px;">${alertObj.title}</div>
                    <div style="font-size: 12px; color: #e2e8f0; line-height: 1.35;">${alertObj.message}</div>
                </div>
                <span id="bb-close-alert-btn" style="cursor: pointer; color: #94a3b8; font-size: 18px; font-weight: bold; line-height: 1; padding: 0 4px; user-select: none;">✕</span>
            </div>
        `;
        container.appendChild(toast);

        toast.querySelector('#bb-close-alert-btn').onclick = () => {
            saveDismissedAlert(alertObj.id);
            toast.remove();
        };
    }

    // ================= INDEXEDDB =================
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
                if (!d.objectStoreNames.contains('client_tags')) {
                    d.createObjectStore('client_tags', { keyPath: 'clientId' });
                }
            };
            req.onsuccess = (e) => {
                db = e.target.result;
                if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
                purgeExpiredData();
                cloudSyncTagsPull();
                sendDeviceHeartbeat();
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

            sStore.index('by_closedAt').openCursor(IDBKeyRange.upperBound(expireTs)).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { sStore.delete(cursor.primaryKey); cursor.continue(); }
            };
            scStore.index('by_time').openCursor(IDBKeyRange.upperBound(expireTs)).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { scStore.delete(cursor.primaryKey); cursor.continue(); }
            };
        } catch (e) {}
    }

    function dbPut(storeName, data) {
        if (!db) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).put(data);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            } catch (e) { resolve(); }
        });
    }

    function dbGet(storeName, key) {
        if (!db) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    function dbGetAll(storeName) {
        if (!db) return Promise.resolve([]);
        return new Promise((resolve) => {
            try {
                const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } catch (e) { resolve([]); }
        });
    }

    function clearEntireDB() {
        if (!db) return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(['sessions', 'scans_history', 'client_tags'], 'readwrite');
                tx.objectStore('sessions').clear();
                tx.objectStore('scans_history').clear();
                tx.objectStore('client_tags').clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    async function getClientTags(clientId) {
        if (!clientId) return [];
        const record = await dbGet('client_tags', String(clientId));
        if (!record || !Array.isArray(record.tags)) return [];
        return record.tags.map(t => typeof t === 'string' ? { title: t, desc: '', author: '—', date: Date.now(), color: 'purple' } : t);
    }

    async function addClientTag(clientId, tagObj) {
        if (!clientId || !tagObj || !tagObj.title) return;
        let record = await dbGet('client_tags', String(clientId));
        if (!record) record = { clientId: String(clientId), tags: [] };
        record.tags = record.tags.filter(t => (t.title || t) !== tagObj.title);
        record.tags.push(tagObj);
        await dbPut('client_tags', record);
        cloudSyncTagPush(clientId, record.tags);
    }

    async function removeClientTag(clientId, tagTitle) {
        if (!clientId || !tagTitle) return;
        let record = await dbGet('client_tags', String(clientId));
        if (record && Array.isArray(record.tags)) {
            record.tags = record.tags.filter(t => (t.title || t) !== tagTitle);
            await dbPut('client_tags', record);
            cloudSyncTagPush(clientId, record.tags);
        }
    }

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
        if (!bar && Array.isArray(p.barcodes) && p.barcodes.length > 0) bar = p.barcodes.find(b => !b.startsWith('%')) || p.barcodes[0];
        if (!bar && p.items?.[0]?.exemplars?.[0]?.barcodes?.[0]) bar = p.items[0].exemplars[0].barcodes[0];
        if (!bar) bar = String(p.id);

        // Индивидуальная ячейка конкретного отправления
        let specificShelf = p.shelfAddress || p.address || '';
        if (!specificShelf && Array.isArray(p.postingShelves) && p.postingShelves.length > 0) {
            specificShelf = p.postingShelves.join(', ');
        }
        if (!specificShelf) specificShelf = 'Основная';

        return {
            id: String(p.id),
            name: title,
            barcode: bar,
            shelf: specificShelf, // ТОЧНАЯ ЯЧЕЙКА ЭТОГО ТОВАРА
            allBarcodes: (p.barcodes || []).map(b => String(b).toLowerCase()),
            price: p.price || 0,
            status: 'storage',
            isScanned: false,         // Был ли реальный скан?
            scannedAt: null,          // Точный timestamp
            scannedTimeFormatted: '', // Время вида 14:28:05
            scannedBy: '',            // Кто именно пикнул
            reasonText: '',
            inbound: null
        };
    }

    function parseAndRecordInboundNetwork(data) {
        if (!data) return;
        let address = data.articlePositions?.[0]?.address || data.state?.address || data.article?.address || data.address || '';
        let barcode = data.articlePositions?.[0]?.barcode || data.state?.barcode || data.article?.barcode || data.barcode || '';
        if (barcode && address) {
            recordInboundRelay(barcode, address, getOperatorLogin());
        }
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

    function interceptPayload(url, reqBody, resData, status = 200) {
        if (url.includes('/Movement/put') || url.includes('/clearing/articles/receive') || url.includes('/Resolver/GetResolveEntity')) {
            try { parseAndRecordInboundNetwork(typeof resData === 'string' ? JSON.parse(resData) : resData); } catch (e) {}
        }

        if (url.includes('/api2/giveout/Sessions/close')) {
            let closedId = null;
            if (typeof reqBody === 'string') { try { closedId = JSON.parse(reqBody).sessionId; } catch (e) {} } else if (reqBody && reqBody.sessionId) closedId = reqBody.sessionId;
            finalizeActiveSession(closedId, 'completed');
        }

        // 2. Обработка выдачи giveout-v3
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

                    // Фикс: ловим taskId в любых вариациях Озона (id / taskId)
                    const taskList = parsedRes?.tasks || parsedRes?.data?.tasks;
                    if (Array.isArray(taskList) && taskList.length > 0) {
                        taskList.forEach(t => {
                            const taskIdStr = String(t.taskId || t.id);
                            pendingGiveoutTasks.set(taskIdStr, { sessionId: sId });
                        });
                    } else {
                        // Если тасок нет или статус сразу выполнен — закрываем немедленно
                        finalizeActiveSession(sId, 'completed');
                    }
                }
            } catch (e) {
                // Если парсинг упал — страхуем по текущей активной сессии
                finalizeActiveSession(null, 'completed');
            }
        }

        // 3. Статусы тасок giveout-v2-tasks-statuses
        if (url.includes('/api2/giveout/Postings/giveout-v2-tasks-statuses') || url.includes('/tasks-statuses')) {
            try {
                const parsedRes = typeof resData === 'string' ? JSON.parse(resData) : resData;
                const statusList = parsedRes?.statuses || parsedRes?.data?.statuses;

                if (Array.isArray(statusList)) {
                    statusList.forEach(st => {
                        const tId = String(st.id || st.taskId);
                        const isDone = st.status === 'Processed' || st.status === 'Success' || st.status === 'Completed';

                        if (isDone && pendingGiveoutTasks.has(tId)) {
                            const taskInfo = pendingGiveoutTasks.get(tId);
                            pendingGiveoutTasks.delete(tId);

                            let hasActive = false;
                            for (let entry of pendingGiveoutTasks.values()) {
                                if (entry.sessionId === taskInfo.sessionId) { hasActive = true; break; }
                            }
                            if (!hasActive) {
                                finalizeActiveSession(taskInfo.sessionId, 'completed');
                            }
                        }
                    });
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
                            let hasActiveTasks = false;
                            for (let entry of pendingGiveoutTasks.values()) { if (entry.sessionId === taskInfo.sessionId) { hasActiveTasks = true; break; } }
                            if (!hasActiveTasks) finalizeActiveSession(taskInfo.sessionId, 'completed');
                        }
                    });
                }
            } catch (e) {}
        }

        if (url.includes('/api2/giveout/Postings?sessionId=')) {
            const match = url.match(/sessionId=(\d+)/);
            if (match && resData) {
                const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                handleSessionPostingsData(match[1], parsed);
            }
        }

        if (url.includes('/api2/giveout/Sessions') && !url.includes('/close')) {
            const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
            if (parsed && Array.isArray(parsed.sessions)) {
                parsed.sessions.forEach(s => {
                    const sId = String(s.sessionId);
                    const realOp = (s.userName || '').replace('PVZ_', '').trim();
                    if (realOp) sessionStorage.setItem('session_operator_' + sId, realOp);
                    if (s.clientId) sessionStorage.setItem('client_id_' + sId, String(s.clientId));
                    const code = s.clientBarcode || s.verifyCode || s.code || s.pickupCode;
                    if (code && typeof code === 'string' && !code.includes('----')) sessionStorage.setItem('client_code_' + sId, code);
                });
            }
        }
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) { this._bUrl = typeof url === 'string' ? url : ''; this._bHeaders = {}; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) { if (this._bHeaders) this._bHeaders[name.toLowerCase()] = value; return origSetRequestHeader.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body) {
        if (this._bHeaders) captureAuthToken(this._bHeaders);
        const self = this;
        this.addEventListener('load', function() { try { interceptPayload(self._bUrl, body, self.responseText, self.status); } catch (e) {} });
        return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        try { const config = args[1]; if (config && config.headers) captureAuthToken(new Headers(config.headers)); } catch (e) {}
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const response = await origFetch.apply(this, args);
        try {
            const reqBody = args[1]?.body;
            response.clone().text().then(resText => interceptPayload(url, reqBody, resText, response.status)).catch(() => {});
        } catch (e) {}
        return response;
    };

    async function handleSessionPostingsData(sessionId, data) {
        if (!data || !data.postings) return;
        const sId = String(sessionId);
        const readyPostings = (data.postings || []).filter(p => p.pvzState === 'ReadyToGiveout' || !p.pvzState);
        currentPostingsList = readyPostings;

        const clientId = data.client?.ozonClientId || data.client?.clientId || '';
        const clientName = data.client?.clientShortName || '';
        const shelves = Array.isArray(data.postingsShelves) ? data.postingsShelves.join(', ') : '';

        if (clientId) sessionStorage.setItem('client_id_' + sId, String(clientId));

        let session = await dbGet('sessions', sId);

        // 1. Ищем настоящий код в sessionStorage, памяти сессии или кэше
        let realCode = sessionStorage.getItem('client_code_' + sId) || 
                       sessionStorage.getItem('client_code_pending');

        // Если в сохраненной сессии уже был валидный код без дефисов — НИКОГДА его не затираем
        if (!realCode && session && session.pickupCode && !session.pickupCode.includes('----')) {
            realCode = session.pickupCode;
        }

        // Если кода все еще нет, проверяем по общему clientId
        if (!realCode && clientId) {
            const cachedByCid = sessionStorage.getItem('client_code_cid_' + clientId);
            if (cachedByCid) realCode = cachedByCid;
        }

        // И только если кода ВООБЩЕ нигде нет в природе — ставим заглушку
        const currentCode = realCode || (clientId ? `${clientId}*----` : '');

        if (realCode && !realCode.includes('----')) {
            sessionStorage.setItem('client_code_' + sId, realCode);
            if (clientId) sessionStorage.setItem('client_code_cid_' + clientId, realCode);
            sessionStorage.removeItem('client_code_pending');
        }

        const apiOperator = sessionStorage.getItem('session_operator_' + sId) || '';

        const postingsList = readyPostings.map(extractPostingDetails);

        if (!session) {
            session = {
                sessionId: sId, clientId: String(clientId), clientName: clientName, pickupCode: currentCode,
                foundAt: Date.now(), closedAt: null, durationSec: 0,
                operator: apiOperator || getOperatorLogin(),
                shelves: shelves, closeReason: 'active', postings: postingsList,
                timeline: [{ time: Date.now(), type: 'start', text: 'Сессия открыта' }],
                alienScans: [], tabId: TAB_ID, pvzId: CURRENT_PVZ
            };
        } else {
            if (clientId) session.clientId = String(clientId);
            if (clientName) session.clientName = clientName;
            if (shelves) session.shelves = shelves;
            if (currentCode && !currentCode.includes('----')) session.pickupCode = currentCode;
            if (apiOperator) session.operator = apiOperator;
            if (!session.postings || session.postings.length === 0) session.postings = postingsList;
        }

        activeSession = session;
        await dbPut('sessions', session);
        cloudSyncSession(session);
    }

    async function finalizeActiveSession(sId, reason = 'completed') {
        const targetId = sId ? String(sId) : (activeSession ? activeSession.sessionId : getActiveSessionIdOnTab());
        if (!targetId) return;

        let session = await dbGet('sessions', String(targetId));
        if (!session) return;

        if (session.closedAt && session.closeReason !== 'active') return;

        session.closedAt = Date.now();
        session.durationSec = Math.max(1, Math.round((session.closedAt - session.foundAt) / 1000));
        session.closeReason = reason;

        const apiOperator = sessionStorage.getItem('session_operator_' + targetId);
        if (apiOperator) session.operator = apiOperator;

        let issuedCount = 0, annulatedCount = 0, storageCount = 0;
        const apiGiveoutData = sessionGiveoutPayloads.get(String(targetId));

        session.postings.forEach(pObj => {
            const pIdStr = String(pObj.id);

            // 1. ПРОВЕРКА ПО ПЕРЕХВАЧЕННОМУ СЕТЕВОМУ GIVE-OUT ПАКЕТУ
            if (apiGiveoutData) {
                if (apiGiveoutData.has(pIdStr)) {
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
                    // Товара не было в запросе выдачи — он остался на складе!
                    pObj.status = 'storage';
                    storageCount++;
                }
            } 
            // 2. ФОЛЛБЭК: АНАЛИЗ DOM КАРТОЧКИ ТОВАРА НА ЭКРАНЕ
            else {
                const cardWrapper = document.querySelector(`[data-testid="${pObj.id}"]`) || 
                                    Array.from(document.querySelectorAll('[class*="_card_"]')).find(c => c.textContent.includes(pObj.name) || (pObj.barcode && c.textContent.includes(pObj.barcode)));

                if (cardWrapper) {
                    const txt = cardWrapper.textContent;
                    if (txt.includes('К аннуляции') || txt.includes('Отказ')) {
                        pObj.status = 'annulated';
                        const reasonBtn = Array.from(cardWrapper.querySelectorAll('button')).find(b => b.textContent.includes('К аннуляции'));
                        pObj.reasonText = reasonBtn ? reasonBtn.textContent.replace('К аннуляции:', '').trim() : 'Отказ';
                        annulatedCount++;
                    } else if (txt.includes('К выдаче') && !txt.includes('На хранении')) {
                        pObj.status = 'issued';
                        issuedCount++;
                    } else {
                        pObj.status = 'storage';
                        storageCount++;
                    }
                } else {
                    // Если карточки нет в DOM и запроса не было — товар точно на хранении
                    pObj.status = 'storage';
                    storageCount++;
                }
            }
        });

        let summaryText = 'Сессия завершена';
        if (reason === 'completed') summaryText = 'Выдача проведена';
        else if (reason === 'manual_dock') summaryText = 'Закрыто вручную через Dock';
        else if (reason === 'manual_back') summaryText = 'Выход назад на /orders';
        else if (reason === 'tab_unloaded') summaryText = 'Вкладка закрыта/обновлена';

        summaryText += ` (Выдано: ${issuedCount}, Отказ: ${annulatedCount}, Хранение: ${storageCount})`;
        session.timeline.push({ time: Date.now(), type: 'finish', text: summaryText });

        await dbPut('sessions', session);
        cloudSyncSession(session);

        sessionGiveoutPayloads.delete(String(targetId));
        pendingGiveoutTasks.delete(String(targetId));

        if (activeSession && String(activeSession.sessionId) === String(targetId)) {
            activeSession = null;
        }

        const listEl = document.getElementById('bb-sessions-list');
        if (listEl) renderTabContent('sessions');
    }
    // ================= ГЛОБАЛЬНЫЙ СЛУШАТЕЛЬ КЛАВИАТУРЫ И СКАНИРОВАНИЯ =================
    window.addEventListener('keydown', function(e) {
        // Хоткей открытия инспектора BlackBox
        if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyB') {
            e.preventDefault();
            e.stopPropagation();
            toggleInspectorModal();
            return;
        }

        // Закрытие окон по Escape
        if (e.key === 'Escape') {
            const tModal = document.getElementById('bb-tag-creator-modal');
            if (tModal) { e.preventDefault(); e.stopPropagation(); tModal.remove(); return; }
            const modal = document.getElementById('blackbox-modal-root');
            if (modal) { e.preventDefault(); e.stopPropagation(); closeInspectorModal(); return; }
        }

        const now = Date.now();
        if (now - lastScanTime > 150) scanBuffer = '';
        lastScanTime = now;

        if (e.key === 'Enter') {
            const raw = scanBuffer.trim();
            scanBuffer = '';
            if (raw.length >= 4) processBarcodeScan(translit(raw));
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            scanBuffer += e.key;
        }
    }, true);

    async function processBarcodeScan(barcode) {
        const clean = barcode.toLowerCase();
        const now = Date.now();
        const activeId = getActiveSessionIdOnTab();
        const currentOp = (activeId && sessionStorage.getItem('session_operator_' + activeId)) || getOperatorLogin();
        let currentClientName = '';

        const isClientBarcode = /^\d{5,12}\*\d{3,6}$/.test(clean);
        if (isClientBarcode) {
            const parts = clean.split('*');
            const cId = parts[0];
            sessionStorage.setItem('client_code_pending', barcode);
            sessionStorage.setItem('client_code_cid_' + cId, barcode);
            if (activeId) {
                sessionStorage.setItem('client_code_' + activeId, barcode);
                const s = await dbGet('sessions', String(activeId));
                if (s) {
                    s.pickupCode = barcode;
                    s.clientId = cId;
                    await dbPut('sessions', s);
                    cloudSyncSession(s);
                }
            }
            return;
        }


        let isMatchInCurrent = false;
        if (activeId) {
            const session = await dbGet('sessions', String(activeId));
            if (session) {
                currentClientName = session.clientName || 'Без имени';
                if (session.postings) {
                    const targetPosting = session.postings.find(p => {
                        const pId = String(p.id).toLowerCase();
                        const pBar = (p.barcode || '').toLowerCase();
                        const bList = (p.allBarcodes || []).map(b => String(b).toLowerCase());
                        return pId.includes(clean) || clean.includes(pId) || pBar.includes(clean) || clean.includes(pBar) || bList.some(b => b.includes(clean));
                    });

                    if (targetPosting) {
                        isMatchInCurrent = true;
                        const nowTs = Date.now();
                        const timeStr = new Date(nowTs).toLocaleTimeString('ru-RU');

                        // Фиксируем физический скан намертво в объекте товара
                        targetPosting.isScanned = true;
                        targetPosting.scannedAt = nowTs;
                        targetPosting.scannedTimeFormatted = timeStr;
                        targetPosting.scannedBy = currentOp;

                        recordTimelineEvent(activeId, 'scan', `Отсканирован товар: ${targetPosting.name} [Яч. ${targetPosting.shelf}] оператором ${currentOp} в ${timeStr}`, false, { 
                            barcode, 
                            postingId: targetPosting.id,
                            shelf: targetPosting.shelf,
                            operator: currentOp,
                            exactTime: nowTs
                        });

                        // Сохраняем сессию с обновленными данными товара
                        await dbPut('sessions', session);
                        cloudSyncSession(session);
                    } else {
                        verifyOzonArticle(barcode).then(res => {
                            if (res.isOzonArticle) recordTimelineEvent(activeId, 'alien_scan', `⚠️ ЧУЖОЙ ТОВАР СО СКЛАДА: ${barcode} (${res.name})`, true, { barcode, isRealParcel: true, operator: currentOp });
                            else recordTimelineEvent(activeId, 'junk_scan', `ℹ️ Служебный/Внешний ШК: ${barcode}`, false, { barcode, isRealParcel: false, operator: currentOp });
                        });
                    }
                }
            }
        }

        const scanRecord = {
            barcode: barcode, sessionId: activeId, operator: currentOp, clientName: currentClientName, time: now, isAlien: activeId ? !isMatchInCurrent : false
        };
        dbPut('scans_history', scanRecord);
        cloudSyncScan(scanRecord);
    }

    // ================= МОДАЛКА СОЗДАНИЯ МЕТКИ =================
    function openTagCreatorModal(clientId, onCreated) {
        let ex = document.getElementById('bb-tag-creator-modal');
        if (ex) ex.remove();

        const activeId = getActiveSessionIdOnTab();
        const currentOp = (activeId && sessionStorage.getItem('session_operator_' + activeId)) || getOperatorLogin() || 'Оператор';

        const modal = document.createElement('div');
        modal.id = 'bb-tag-creator-modal';
        modal.innerHTML = `
            <div class="bb-tag-dialog">
                <div class="bb-tag-dialog-head">
                    <span>Метка для клиента: <b>#${clientId}</b></span>
                    <span class="bb-tag-dialog-close" id="bb-tag-cancel">✕</span>
                </div>
                <div class="bb-tag-dialog-body">
                    <label class="bb-tag-label">Название метки</label>
                    <input type="text" class="bb-input" id="bb-tag-title-inp" placeholder="..." autofocus>

                    <label class="bb-tag-label">Описание</label>
                    <textarea class="bb-input" id="bb-tag-desc-inp" rows="2" placeholder="Заметка операторам при выдаче..."></textarea>

                    <label class="bb-tag-label">Цвет</label>
                    <div class="bb-tag-colors">
                        <label class="bb-color-opt"><input type="radio" name="tagColor" value="purple" checked><span class="bb-color-dot" style="background: #a855f7;"></span><span>Фиолетовый</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagColor" value="amber"><span class="bb-color-dot" style="background: #f59e0b;"></span><span>Оранжевый</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagColor" value="red"><span class="bb-color-dot" style="background: #ef4444;"></span><span>Красный</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagColor" value="emerald"><span class="bb-color-dot" style="background: #10b981;"></span><span>Зеленый</span></label>
                    </div>
                </div>
                <div class="bb-tag-dialog-foot">
                    <button class="bb-btn-save-tag" id="bb-tag-save-btn">Сохранить</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('#bb-tag-cancel').onclick = () => modal.remove();
        modal.querySelector('#bb-tag-save-btn').onclick = async () => {
            const title = modal.querySelector('#bb-tag-title-inp').value.trim();
            const desc = modal.querySelector('#bb-tag-desc-inp').value.trim();
            const color = modal.querySelector('input[name="tagColor"]:checked').value;

            if (!title) {
                modal.querySelector('#bb-tag-title-inp').focus();
                return;
            }

            const tagObj = { title, desc, color, author: currentOp, date: Date.now() };
            await addClientTag(clientId, tagObj);
            modal.remove();
            if (onCreated) onCreated();
        };
    }

    function injectDomTags() {
        if (!window.location.pathname.includes('/orders/session')) return;
        const activeId = getActiveSessionIdOnTab();
        if (!activeId) return;

        const nameEl = document.querySelector('[class*="_clientName_"]');
        if (!nameEl) return;

        let wrap = nameEl.parentElement.querySelector('.bb-client-tags-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'bb-client-tags-wrap';
            nameEl.insertAdjacentElement('afterend', wrap);
        }

        const clientId = sessionStorage.getItem('client_id_' + activeId);
        if (!clientId) return;

        if (wrap.dataset.loadedClientId === clientId) return;
        wrap.dataset.loadedClientId = clientId;

        async function renderDomTags() {
            const tags = await getClientTags(clientId);

            // Рендерим ТОЛЬКО сами метки без кнопки добавления
            wrap.innerHTML = tags.map(t => {
                const dateStr = new Date(t.date || Date.now()).toLocaleDateString('ru-RU');
                return `
                    <div class="bb-dom-tag-badge color-${t.color || 'purple'}">
                        <span>${t.title}</span>
                        <span class="bb-dom-tag-rm" data-tag="${t.title}" title="Удалить метку">×</span>
                        <div class="bb-tag-tooltip">
                            <div class="bb-tt-title">${t.title}</div>
                            ${t.desc ? `<div class="bb-tt-desc">${t.desc}</div>` : ''}
                            <div class="bb-tt-meta">Автор: <b>${t.author}</b> · ${dateStr}</div>
                        </div>
                    </div>
                `;
            }).join('');

            wrap.querySelectorAll('.bb-dom-tag-rm').forEach(rm => {
                rm.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm(`Удалить метку "${rm.dataset.tag}"?`)) {
                        await removeClientTag(clientId, rm.dataset.tag);
                        renderDomTags();
                    }
                };
            });
        }
        renderDomTags();
    }
    setInterval(injectDomTags, 400);

    // ================= BLACKBOX INSPECTOR CSS =================
    const modalStyle = document.createElement('style');
    modalStyle.innerHTML = `
        #blackbox-modal-root, #bb-tag-creator-modal {
            position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.8) !important; backdrop-filter: blur(20px) saturate(180%) !important;
            z-index: 10000000 !important; display: flex !important; align-items: center !important; justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important; color: #f8fafc !important;
        }

        .bb-window { width: 1080px !important; max-width: 96vw !important; height: 780px !important; max-height: 92vh !important; background: #0f172a !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 16px !important; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; }
        .bb-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 14px 20px !important; border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important; background: rgba(255, 255, 255, 0.02) !important; }
        .bb-title { font-size: 15px !important; font-weight: 800 !important; letter-spacing: 0.5px !important; display: flex !important; align-items: center !important; gap: 8px !important; }
        .bb-title span { color: #38bdf8 !important; }

        .bb-pvz-badge {
            background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);
            padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; font-family: monospace;
        }

        .bb-tabs { display: flex !important; gap: 6px !important; }
        .bb-tab-btn { background: transparent !important; border: 1px solid transparent !important; color: #94a3b8 !important; padding: 5px 12px !important; border-radius: 8px !important; font-size: 12px !important; font-weight: 600 !important; cursor: pointer !important; transition: all 0.15s !important; }
        .bb-tab-btn:hover { color: #fff !important; background: rgba(255, 255, 255, 0.05) !important; }
        .bb-tab-btn.active { color: #38bdf8 !important; background: rgba(56, 189, 248, 0.12) !important; border-color: rgba(56, 189, 248, 0.3) !important; }
        .bb-close { color: #64748b !important; cursor: pointer !important; font-size: 18px !important; padding: 2px 6px !important; }
        .bb-close:hover { color: #fff !important; }

        .bb-body { flex: 1 1 auto !important; display: flex !important; overflow: hidden !important; }
        .bb-main-view { flex: 1 1 auto !important; padding: 16px !important; overflow-y: auto !important; display: flex !important; flex-direction: column !important; gap: 10px !important; }
        .bb-replay-view { width: 440px !important; min-width: 440px !important; border-left: 1px solid rgba(255, 255, 255, 0.08) !important; background: #090d16 !important; padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 10px !important; overflow-y: auto !important; }

        .bb-input { background: rgba(255, 255, 255, 0.05) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; color: #fff !important; padding: 8px 12px !important; border-radius: 8px !important; font-size: 13px !important; outline: none !important; box-sizing: border-box !important; }
        .bb-input:focus { border-color: #38bdf8 !important; }
        textarea.bb-input { resize: vertical !important; max-width: 100% !important; min-height: 56px !important; }

        .bb-date-divider { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; margin-top: 10px; background: rgba(56, 189, 248, 0.07); border-radius: 8px; border-left: 3px solid #38bdf8; font-size: 12px; font-weight: 700; color: #38bdf8; cursor: pointer; user-select: none; }
        .bb-date-divider:hover { background: rgba(56, 189, 248, 0.12); }
        .bb-day-accordion { border: none; }
        .bb-day-accordion summary { list-style: none; }
        .bb-day-accordion summary::-webkit-details-marker { display: none; }

        .bb-tree-root { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
        .bb-thread-children { margin-left: 16px; padding-left: 10px; border-left: 2px solid rgba(255, 255, 255, 0.12); display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }

        .bb-card { background: rgba(255, 255, 255, 0.03) !important; border: 1px solid rgba(255, 255, 255, 0.06) !important; border-radius: 10px !important; padding: 10px 12px !important; cursor: pointer !important; transition: all 0.15s !important; display: flex !important; flex-direction: column !important; gap: 5px !important; }
        .bb-card:hover { background: rgba(255, 255, 255, 0.06) !important; border-color: rgba(255, 255, 255, 0.15) !important; }
        .bb-card.has-alien { border-left: 3px solid #ef4444 !important; }

        .bb-card-head { display: flex !important; justify-content: space-between !important; align-items: center !important; }
        .bb-card-name { font-weight: 700; font-size: 13px; color: #f8fafc; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .bb-card-time { font-size: 11px; color: #64748b; font-family: monospace; }
        .bb-card-sub { font-size: 12px; color: #94a3b8; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

        .bb-tag { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
        .bb-tag-warn { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .bb-tag-repeat { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }

        .bb-btn { background: #1c3557; color: #38bdf8; border: 1px solid #2b4260; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 5px;}
        .bb-btn:hover { background: #007aff; color: #fff; }
        .bb-btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }
        .bb-btn-danger:hover { background: #ef4444; color: #fff; }

        /* Диалог создания метки */
        .bb-tag-dialog { width: 400px; background: #0f172a; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 14px; box-shadow: 0 20px 50px rgba(0,0,0,0.85); display: flex; flex-direction: column; overflow: hidden; }
        .bb-tag-dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); font-size: 13px; font-weight: 700; }
        .bb-tag-dialog-close { cursor: pointer; color: #64748b; font-size: 16px; }
        .bb-tag-dialog-close:hover { color: #fff; }
        .bb-tag-dialog-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
        .bb-tag-label { font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
        .bb-tag-colors { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 2px; }
        .bb-color-opt { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; user-select: none; }
        .bb-color-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .bb-tag-dialog-foot { padding: 12px 16px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: flex-end; }
        .bb-btn-save-tag { background: #005bff; color: #ffffff; border: none; padding: 7px 18px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; transition: background 0.15s; }
        .bb-btn-save-tag:hover { background: #004ecc; }

        /* ВЫСОКОКОНТРАСТНЫЕ ПЛОТНЫЕ МЕТКИ */
        .bb-client-tags-wrap { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-left: 6px; }
        .bb-dom-tag-badge {
            position: relative; padding: 3px 8px !important; border-radius: 6px !important; font-size: 12px !important;
            font-weight: 700 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important;
            gap: 6px !important; cursor: default !important; user-select: none !important; line-height: 1 !important; box-sizing: border-box !important;
        }
        .bb-dom-tag-badge span:first-child { display: inline-block; vertical-align: middle; transform: translateY(-0.5px); }

        .bb-dom-tag-badge.color-purple { background: #f3e8ff !important; color: #7e22ce !important; border: 1px solid #d8b4fe !important; }
        .bb-dom-tag-badge.color-amber  { background: #fef3c7 !important; color: #b45309 !important; border: 1px solid #fde68a !important; }
        .bb-dom-tag-badge.color-red    { background: #fee2e2 !important; color: #b91c1c !important; border: 1px solid #fecaca !important; }
        .bb-dom-tag-badge.color-emerald{ background: #d1fae5 !important; color: #047857 !important; border: 1px solid #a7f3d0 !important; }

        .bb-dom-tag-rm { cursor: pointer !important; opacity: 0.5 !important; padding: 0 1px !important; font-weight: 800 !important; font-size: 12px !important; line-height: 1 !important; display: inline-flex !important; align-items: center !important; }
        .bb-dom-tag-rm:hover { opacity: 1 !important; }

        .bb-dom-tag-add {
            background: #f1f5f9 !important; color: #475569 !important; border: 1px solid #cbd5e1 !important;
            padding: 3px 8px !important; border-radius: 6px !important; font-size: 11px !important; font-weight: 600 !important;
            cursor: pointer !important; transition: all 0.15s !important; line-height: 1 !important; display: inline-flex !important;
            align-items: center !important; justify-content: center !important;
        }
        .bb-dom-tag-add:hover { background: #e2e8f0 !important; color: #0284c7 !important; border-color: #94a3b8 !important; }

        .bb-panel-tag-add {
            background: #1c3557 !important; color: #38bdf8 !important; border: 1px solid #0284c7 !important;
            padding: 4px 10px !important; border-radius: 6px !important; font-size: 11px !important; font-weight: 700 !important;
            cursor: pointer !important; transition: all 0.15s !important; line-height: 1 !important; display: inline-flex !important;
            align-items: center !important; gap: 4px !important;
        }
        .bb-panel-tag-add:hover { background: #007aff !important; color: #ffffff !important; }

        .bb-tag-tooltip {
            position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); width: 220px;
            max-height: 180px; overflow-y: auto; background: #090d16; border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px; padding: 8px 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.85); pointer-events: none; opacity: 0;
            transition: opacity 0.15s ease; z-index: 8999 !important; text-align: left;
        }
        .bb-tag-tooltip::after { content: ''; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); border-width: 5px; border-style: solid; border-color: transparent transparent #090d16 transparent; }
        .bb-dom-tag-badge:hover .bb-tag-tooltip { opacity: 1; }
        .bb-tt-title { font-size: 12px; font-weight: 800; color: #f8fafc; margin-bottom: 2px; }
        .bb-tt-desc { font-size: 11px; color: #cbd5e1; line-height: 1.3; margin-bottom: 4px; word-break: break-word; }
        .bb-tt-meta { font-size: 9px; color: #64748b; font-family: monospace; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; }

        .bb-stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
        .bb-stat-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 4px; }
        .bb-stat-title { font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;}
        .bb-stat-value { font-size: 22px; font-weight: 800; color: #f8fafc; }
        .bb-progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-top: 6px;}
        .bb-progress-fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #818cf8); }

        .bb-timeline-node { position: relative; padding-left: 18px; border-left: 2px solid rgba(255, 255, 255, 0.1); margin-left: 6px; padding-bottom: 12px; }
        .bb-timeline-node::before { content: ''; position: absolute; left: -5px; top: 2px; width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
        .bb-timeline-node.alien::before { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
        .bb-timeline-time { font-size: 10px; color: #64748b; font-family: monospace; }
        .bb-timeline-text { font-size: 12px; color: #e2e8f0; font-weight: 500; }
    `;
    document.head.appendChild(modalStyle);

    function toggleInspectorModal() {
        let m = document.getElementById('blackbox-modal-root');
        if (m) closeInspectorModal(); else openInspector();
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
                    <div class="bb-title">
                        ⬛ BLACKBOX <span>// АУДИТ 5.1</span>
                        <span class="bb-pvz-badge">${CURRENT_PVZ}</span>
                    </div>
                    <div class="bb-tabs">
                        <button class="bb-tab-btn active" data-tab="sessions">Журнал смены</button>
                        <button class="bb-tab-btn" data-tab="lookup">Поиск «Потеряшки»</button>
                        <button class="bb-tab-btn" data-tab="aliens">⚠️ Аномалии</button>
                        <button class="bb-tab-btn" data-tab="storage">База данных</button>
                    </div>
                    <span class="bb-close" id="bb-close-btn">✕</span>
                </div>
                <div class="bb-body">
                    <div class="bb-main-view" id="bb-main-content"></div>
                    <div class="bb-replay-view" id="bb-replay-sidebar"><div style="color: #64748b; text-align: center; margin-top: 40px;">Выберите сессию для реконструкции</div></div>
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
        const d = new Date(timestamp), now = new Date();
        if (d.toDateString() === now.toDateString()) return 'Сегодня';
        const yest = new Date(now); yest.setDate(now.getDate() - 1);
        if (d.toDateString() === yest.toDateString()) return 'Вчера';
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function buildSessionTrees(sessions) {
        const sorted = [...sessions].sort((a, b) => a.foundAt - b.foundAt);
        const roots = [];

        function insertIntoNode(node, s, currentDepth) {
            const start = node.session.foundAt;
            const end = node.session.closedAt || Infinity;
            if (s.foundAt >= start && s.foundAt <= end) {
                if (currentDepth >= MAX_TREE_DEPTH) {
                    node.children.push({ session: s, children: [] });
                    return true;
                }
                for (let i = node.children.length - 1; i >= 0; i--) {
                    if (insertIntoNode(node.children[i], s, currentDepth + 1)) return true;
                }
                node.children.push({ session: s, children: [] });
                return true;
            }
            return false;
        }

        for (const s of sorted) {
            let inserted = false;
            for (let i = roots.length - 1; i >= 0; i--) {
                if (insertIntoNode(roots[i], s, 1)) { inserted = true; break; }
            }
            if (!inserted) roots.push({ session: s, children: [] });
        }
        return currentSortOrder === 'desc' ? roots.reverse() : roots;
    }

    async function renderTabContent(tab) {
        const container = document.getElementById('bb-main-content');
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!container) return;

        // 1. ЖУРНАЛ СМЕНЫ
        if (tab === 'sessions') {
            sidebar.style.display = 'flex';
            let sessions = externalDumpData ? externalDumpData.sessions : await dbGetAll('sessions');

            container.innerHTML = `
                <div style="display: flex; gap: 8px; width: 100%;">
                    <input type="text" class="bb-input" id="bb-session-search" placeholder="Поиск по клиенту, штрихкоду..." style="flex: 1;">
                    <input type="text" class="bb-input" id="bb-shelf-search" placeholder="Ячейка..." style="width: 110px;">
                    <button class="bb-btn" id="bb-sort-toggle">
                        ${currentSortOrder === 'desc' ? 'Сначала новые ↓' : 'Сначала старые ↑'}
                    </button>
                </div>
                <div id="bb-sessions-list"></div>
            `;

            const listEl = container.querySelector('#bb-sessions-list');

            async function populate(items) {
                listEl.innerHTML = '';
                if (items.length === 0) {
                    listEl.innerHTML = '<div style="color:#64748b; padding:30px; text-align:center;">Сессий не найдено</div>';
                    return;
                }

                const grouped = {};
                items.forEach((s) => {
                    const key = formatDateKey(s.foundAt);
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(s);
                });

                const allTagsList = await dbGetAll('client_tags');
                const tagsMap = new Map();
                allTagsList.forEach(t => tagsMap.set(String(t.clientId), t.tags || []));

                function renderTreeHtml(nodes) {
                    let html = '';
                    for (const node of nodes) {
                        const s = node.session;
                        const hasAlien = s.alienScans && s.alienScans.some(a => a.isRealParcel);
                        const isRepeat = s.clientId && items.some(other => other.sessionId !== s.sessionId && other.clientId === s.clientId && Math.abs(s.foundAt - other.foundAt) < (24 * 3600 * 1000));
                        const timeStr = `${String(new Date(s.foundAt).getHours()).padStart(2, '0')}:${String(new Date(s.foundAt).getMinutes()).padStart(2, '0')}`;
                        const cTags = tagsMap.get(String(s.clientId)) || [];

                        let cardHtml = `
                            <div class="bb-card ${hasAlien ? 'has-alien' : ''}" data-sid="${s.sessionId}">
                                <div class="bb-card-head">
                                    <div class="bb-card-name">
                                        <span>${s.clientName || 'Без имени'}</span>
                                        ${cTags.map(t => `<span class="bb-dom-tag-badge color-${t.color || 'purple'}">${t.title}</span>`).join('')}
                                    </div>
                                    <span class="bb-card-time">${timeStr} (${s.durationSec || 0}с)</span>
                                </div>
                                <div class="bb-card-sub">
                                    <span>📦 ${s.postings?.length || 0} тов.</span>
                                    <span>Яч. ${s.shelves || '—'}</span>
                                    <span>👤 ${s.operator || '—'}</span>
                                    ${hasAlien ? `<span class="bb-tag bb-tag-warn">⚠️ Чужой пик</span>` : ''}
                                    ${isRepeat ? `<span class="bb-tag bb-tag-repeat">🔄 Повтор за 24ч</span>` : ''}
                                </div>
                            </div>
                        `;

                        html += cardHtml;
                        if (node.children.length > 0) {
                            html += `<div class="bb-thread-children">${renderTreeHtml(node.children)}</div>`;
                        }
                    }
                    return html;
                }

                const todayKey = formatDateKey(Date.now());
                const sortedDays = Object.keys(grouped).sort((a,b) => currentSortOrder === 'desc' ? b.localeCompare(a) : a.localeCompare(b));

                sortedDays.forEach(k => {
                    const groupItems = grouped[k];
                    const dateTitle = formatDateDivider(groupItems[0].foundAt);
                    const isToday = (k === todayKey);

                    const wrapper = document.createElement('div');

                    if (isToday) {
                        const trees = buildSessionTrees(groupItems);
                        wrapper.innerHTML = `
                            <div class="bb-date-divider" style="cursor: default;">
                                <span>📅 ${dateTitle}</span>
                                <span style="opacity: 0.7; font-size: 11px;">${groupItems.length} сессий</span>
                            </div>
                            <div class="bb-tree-root">${renderTreeHtml(trees)}</div>
                        `;
                    } else {
                        wrapper.innerHTML = `
                            <details class="bb-day-accordion">
                                <summary class="bb-date-divider">
                                    <span>📅 ${dateTitle} ▾</span>
                                    <span style="opacity: 0.7; font-size: 11px;">${groupItems.length} сессий</span>
                                </summary>
                                <div class="bb-tree-root" data-lazy-day="${k}" style="padding-top: 4px;">
                                    <div style="color: #64748b; font-size: 11px; padding: 6px;">Нажмите, чтобы развернуть ветку...</div>
                                </div>
                            </details>
                        `;

                        const detailsEl = wrapper.querySelector('details');
                        detailsEl.addEventListener('toggle', function() {
                            if (detailsEl.open) {
                                const targetRoot = detailsEl.querySelector('.bb-tree-root');
                                if (!targetRoot.dataset.rendered) {
                                    targetRoot.dataset.rendered = 'true';
                                    const trees = buildSessionTrees(groupItems);
                                    targetRoot.innerHTML = renderTreeHtml(trees);
                                    attachCardClickHandlers(targetRoot, items);
                                }
                            }
                        }, { once: true });
                    }

                    attachCardClickHandlers(wrapper, items);
                    listEl.appendChild(wrapper);
                });
            }

            function attachCardClickHandlers(containerEl, items) {
                containerEl.querySelectorAll('.bb-card').forEach(c => {
                    c.onclick = (e) => {
                        e.stopPropagation();
                        const target = items.find(x => x.sessionId === c.dataset.sid);
                        if (target) renderSessionReplay(target);
                    };
                });
            }

            function applyFilters() {
                const q = container.querySelector('#bb-session-search').value.toLowerCase().trim();
                const sh = container.querySelector('#bb-shelf-search').value.toLowerCase().trim();

                const filtered = sessions.filter(s => {
                    const matchQ = (s.clientName || '').toLowerCase().includes(q) || (s.clientId || '').toLowerCase().includes(q) ||
                                   (s.pickupCode || '').toLowerCase().includes(q) ||
                                   s.postings?.some(p => (p.barcode && p.barcode.toLowerCase().includes(q)) || p.allBarcodes?.some(b => b.includes(q)));
                    const matchShelf = !sh || (s.shelves || '').toLowerCase().includes(sh);
                    return matchQ && matchShelf;
                });
                populate(filtered);
            }

            container.querySelector('#bb-session-search').oninput = applyFilters;
            container.querySelector('#bb-shelf-search').oninput = applyFilters;

            container.querySelector('#bb-sort-toggle').onclick = () => {
                currentSortOrder = currentSortOrder === 'desc' ? 'asc' : 'desc';
                renderTabContent('sessions');
            };

            applyFilters();
        }

        // 2. ПОИСК ПОТЕРЯШКИ
        if (tab === 'lookup') {
            sidebar.style.display = 'none';
            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8;">Поиск перемещений штрихкода по всей базе сканирований:</div>
                <input type="text" class="bb-input" id="bb-lookup-input" placeholder="Введите или отсканируйте ШК товара...">
                <div id="bb-lookup-results" style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;"></div>
            `;

            const input = container.querySelector('#bb-lookup-input');
            const resEl = container.querySelector('#bb-lookup-results');

            input.oninput = async () => {
                const val = translit(input.value.trim().toLowerCase());
                if (val.length < 3) { resEl.innerHTML = ''; return; }

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
                                <span>Сессия: <b>${m.clientName || 'Вне сессии'}</b></span>
                                <span>Оператор: <b>${m.operator || '—'}</b></span>
                                ${m.isAlien ? '<span class="bb-tag bb-tag-warn">⚠️ ПИКНУТ В ЧУЖОМ ЗАКАЗЕ</span>' : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            };
        }

        // 3. АНОМАЛИИ
        if (tab === 'aliens') {
            sidebar.style.display = 'none';
            const sessions = externalDumpData ? externalDumpData.sessions : await dbGetAll('sessions');
            const alienSessions = (sessions || []).filter(s => s.alienScans && s.alienScans.some(a => a.isRealParcel));

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов товаров Ozon не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold;">Опасные сканы (сканирование посылок других клиентов во время активной выдачи):</div>
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
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
                            <div style="margin-top: 4px; font-size: 12px; color: #f87171;">
                                ${s.alienScans.filter(a => a.isRealParcel).map(a => `<div>• [${new Date(a.time).toLocaleTimeString()}] ${a.text}</div>`).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // 4. БАЗА ДАННЫХ
        if (tab === 'storage') {
            sidebar.style.display = 'none';
            const sessions = await dbGetAll('sessions');
            const scans = await dbGetAll('scans_history');

            let usageMb = '0.00', quotaMb = '0.00', percent = 0;
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                usageMb = (est.usage / (1024 * 1024)).toFixed(2);
                quotaMb = (est.quota / (1024 * 1024)).toFixed(2);
                percent = Math.min(100, (est.usage / est.quota) * 100).toFixed(2);
            }

            container.innerHTML = `
                <div class="bb-stat-grid">
                    <div class="bb-stat-card">
                        <span class="bb-stat-title">Сессий в базе</span>
                        <span class="bb-stat-value">${sessions.length}</span>
                    </div>
                    <div class="bb-stat-card">
                        <span class="bb-stat-title">Сканов в реестре</span>
                        <span class="bb-stat-value">${scans.length}</span>
                    </div>
                    <div class="bb-stat-card">
                        <span class="bb-stat-title">Занято памяти</span>
                        <span class="bb-stat-value">${usageMb} <span style="font-size: 14px; color: #94a3b8;">/ ${quotaMb} МБ</span></span>
                        <div class="bb-progress-bar"><div class="bb-progress-fill" style="width: ${percent}%"></div></div>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="bb-btn" id="bb-export-json">💾 Экспорт JSON</button>
                    <button class="bb-btn" id="bb-import-btn">📥 Слияние баз</button>
                    <button class="bb-btn" id="bb-change-pvz-btn" style="background:#0284c7; color:#fff;">🏢 Сменить ПВЗ (${CURRENT_PVZ})</button>
                    <input type="file" id="bb-import-file" accept=".json" style="display: none;">
                </div>

                ${ENABLE_DEV_PURGE ? `
                <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid rgba(239, 68, 68, 0.2);">
                    <button class="bb-btn bb-btn-danger" id="bb-purge-btn">⚠️ Очистить локальную базу данных (DEV)</button>
                </div>` : ''}
                <div id="bb-storage-status" style="font-size: 12px; color: #10b981; margin-top: 10px;"></div>
            `;

            container.querySelector('#bb-change-pvz-btn').onclick = () => {
                const next = prompt(`Выберите ПВЗ для этого компьютера:\n${PVZ_LIST.join(', ')}`, CURRENT_PVZ);
                if (next && PVZ_LIST.includes(next)) {
                    localStorage.setItem('bb_current_pvz', next);
                    location.reload();
                }
            };

            container.querySelector('#bb-export-json').onclick = () => {
                const dump = { sessions, scans, exportedAt: Date.now() };
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
                a.download = `blackbox_dump_${Date.now()}.json`;
                a.click();
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
                        if (Array.isArray(imported.sessions)) for (let s of imported.sessions) await dbPut('sessions', s);
                        if (Array.isArray(imported.scans)) for (let sc of imported.scans) { delete sc.id; await dbPut('scans_history', sc); }
                        container.querySelector('#bb-storage-status').textContent = '✅ Базы успешно объединены!';
                    } catch (err) { container.querySelector('#bb-storage-status').textContent = '❌ Ошибка чтения файла дампа'; }
                };
                reader.readAsText(file);
            };

            if (ENABLE_DEV_PURGE) {
                container.querySelector('#bb-purge-btn').onclick = async () => {
                    if (confirm('Стереть ВСЕ данные из базы? Восстановление будет невозможно.')) {
                        await clearEntireDB();
                        renderTabContent('storage');
                    }
                };
            }
        }
    }

    async function renderSessionReplay(session) {
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!sidebar) return;
        const hasCode = session.pickupCode && session.pickupCode.includes('*');

        const clientTags = await getClientTags(session.clientId);

        sidebar.innerHTML = `
            <div style="font-weight: 800; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                <span>Реконструкция: ${session.clientName || 'Без имени'}</span>
                ${hasCode ? `<button class="bb-btn" id="bb-reopen-order-btn" style="padding: 2px 8px; font-size: 11px;">Повторить выдачу</button>` : ''}
            </div>
            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px; margin-top: 8px;">
                <div>Штрихкод / ID: <b>${session.pickupCode || session.clientId || '—'}</b></div>
                <div>Оператор: <b>${session.operator || '—'}</b> · Ячейки: <b>${session.shelves || '—'}</b></div>
                <div>Длительность: <b>${session.durationSec || 0} сек</b> (${session.closeReason || 'завершено'})</div>
            </div>

            <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
                <div style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px;">Метки клиента:</div>
                <div class="bb-client-tags-wrap" id="bb-replay-tags-wrap" style="margin-left: 0;">
                    ${clientTags.map(t => `
                        <div class="bb-dom-tag-badge color-${t.color || 'purple'}">
                            <span>${t.title}</span>
                            <span class="bb-dom-tag-rm" data-rm-tag="${t.title}" title="Удалить">×</span>
                        </div>
                    `).join('')}
                    <button type="button" class="bb-panel-tag-add" id="bb-replay-add-tag-btn">+ Добавить</button>
                </div>
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 12px; color: #38bdf8;">Товары заказа (${session.postings?.length || 0}):</div>
            <div style="display: flex; flex-direction: column; gap: 6px;" id="bb-postings-list-wrap">
                ${(session.postings || []).map(p => {
                    const ib = p.inbound;
                    const scanStatusHtml = p.isScanned 
                        ? `<span style="color: #34d399; font-weight: 700;">✓ Пикнут в ${p.scannedTimeFormatted} (${p.scannedBy})</span>`
                        : `<span style="color: #f59e0b; font-weight: 600;">⚠ Не сканировался (выдан кликом)</span>`;

                    return `
                        <div style="font-size: 11px; background: rgba(255,255,255,0.02); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);" data-posting-card-id="${p.id}">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
                                <div style="font-weight: 600; color: #f8fafc;">${p.name}</div>
                                <span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 1px 6px; border-radius: 4px; font-weight: 700; white-space: nowrap; font-size: 10px;">
                                    Яч. ${p.shelf || '—'}
                                </span>
                            </div>
                            <div style="color: #64748b; margin-top: 3px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                <span>${p.barcode}</span> · 
                                <span>${p.price} ₽</span> · 
                                <span style="font-weight: 700; color: ${p.status === 'issued' ? '#10b981' : (p.status === 'annulated' ? '#ef4444' : '#94a3b8')}">
                                    ${p.status === 'issued' ? 'Выдан' : (p.status === 'annulated' ? 'Отказ (' + p.reasonText + ')' : 'На хранении')}
                                </span>
                            </div>
                            <!-- СТАТУС СКАНА И ПРИЕМКИ -->
                            <div style="margin-top: 5px; display: flex; flex-direction: column; gap: 3px; font-size: 10px;">
                                <div>${scanStatusHtml}</div>
                                <div class="bb-inbound-slot">
                                    ${ib ? `
                                        <div class="bb-posting-placement-badge">
                                            📥 <b>${ib.text}</b> · ${ib.time} · <span style="opacity:0.7">${ib.operator}</span>
                                        </div>
                                    ` : `<div style="color: #475569;">История приемки синхронизируется...</div>`}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 12px; color: #38bdf8;">Хронология событий:</div>
            <div style="display: flex; flex-direction: column; margin-top: 4px;">
                ${(session.timeline || []).map(ev => `
                    <div class="bb-timeline-node ${ev.isAlien ? 'alien' : ''}">
                        <div class="bb-timeline-time">${new Date(ev.time).toLocaleTimeString()}</div>
                        <div class="bb-timeline-text" style="${ev.isAlien ? 'color: #f87171; font-weight: bold;' : ''}">${ev.text}</div>
                    </div>
                `).join('')}
            </div>
        `;

        sidebar.querySelectorAll('[data-rm-tag]').forEach(rm => {
            rm.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`Удалить метку "${rm.dataset.rmTag}"?`)) {
                    await removeClientTag(session.clientId, rm.dataset.rmTag);
                    renderSessionReplay(session);
                    renderTabContent('sessions');
                }
            };
        });

        const addTagBtn = sidebar.querySelector('#bb-replay-add-tag-btn');
        if (addTagBtn) {
            addTagBtn.onclick = () => {
                openTagCreatorModal(session.clientId, () => {
                    renderSessionReplay(session);
                    renderTabContent('sessions');
                });
            };
        }

        if (hasCode) {
            sidebar.querySelector('#bb-reopen-order-btn').onclick = () => {
                closeInspectorModal();
                sessionStorage.setItem('pending_client_scan', session.pickupCode);
                window.location.href = '/orders';
            };
        }
    }

    setInterval(sendDeviceHeartbeat, 30000);
    setInterval(cloudSyncTagsPull, 8000);
    setInterval(checkRemoteAlerts, 10000);

    // Фоллбэк-детектор завершения выдачи по кнопкам и смене URL
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const txt = btn.textContent.trim();

        if (txt === 'Выдать' || txt.startsWith('Выдать ') || txt === 'Завершить' || txt.startsWith('Завершить ')) {
            const activeId = getActiveSessionIdOnTab();
            if (activeId) {
                setTimeout(() => {
                    finalizeActiveSession(activeId, 'completed');
                }, 350);
            }
        }
    }, true);

    // Детектор ухода со страницы сессии на /orders
    let lastUrlPath = window.location.pathname;
    setInterval(() => {
        const curPath = window.location.pathname;
        if (lastUrlPath.includes('/orders/session') && !curPath.includes('/orders/session')) {
            const match = lastUrlPath.match(/\/orders\/session(?:-new)?\/(\d+)/);
            if (match && match[1]) {
                finalizeActiveSession(match[1], 'completed');
            }
        }
        lastUrlPath = curPath;
    }, 300);

    initDB();
})();
