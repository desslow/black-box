// ==UserScript==
// @name         Ozon BlackBox
// @namespace    http://tampermonkey.net/
// @version      5.4
// @description  -
// @author       desslow
// @match        https://turbo-pvz.ozon.ru/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      prsstkodpfugnyazrxrp.supabase.co
// ==/UserScript==

(function() {
    'use strict';

    if (!window.location.hostname.includes('turbo-pvz.ozon.ru')) return;

    const SUPABASE_URL = '';
    const SUPABASE_KEY = '';
    const PVZ_LIST = ['PVZ_2210', 'PVZ_2379', 'PVZ_3021', 'PVZ_3228', 'PVZ_3239'];

    function getPvzId() {
        let saved = localStorage.getItem('bb_current_pvz');
        if (!saved || !PVZ_LIST.includes(saved)) {
            saved = prompt(`[BlackBox 5.4] Выберите ПВЗ для этого компьютера:\n${PVZ_LIST.join(', ')}`, PVZ_LIST[0]);
            if (!PVZ_LIST.includes(saved)) saved = PVZ_LIST[0];
            localStorage.setItem('bb_current_pvz', saved);
        }
        return saved;
    }
    const CURRENT_PVZ = getPvzId();

    function getDeterministicDeviceId() {
        let dId = localStorage.getItem('bb_device_id_v2');
        if (!dId) {
            const shortHash = Math.random().toString(36).slice(2, 6).toUpperCase();
            dId = `${CURRENT_PVZ}-PC-${shortHash}`;
            localStorage.setItem('bb_device_id_v2', dId);
        }
        return dId;
    }
    const DEVICE_ID = getDeterministicDeviceId();

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

    const TAB_ID = Math.random().toString(36).slice(2, 9);
    function getTwoHourPasscode() {
        const slot = Math.floor(Date.now() / (2 * 3600 * 1000));
        let hash = 0;
        const str = slot + "_blackbox_pvz_secret_salt";
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return String(Math.abs(hash) % 9000 + 1000);
    }
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
        try { return new Set(JSON.parse(localStorage.getItem('bb_dismissed_alerts_v2') || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveDismissedAlert(id) {
        const set = getDismissedAlerts();
        set.add(String(id));
        localStorage.setItem('bb_dismissed_alerts_v2', JSON.stringify([...set]));
    }

    async function checkRemoteAlerts() {
        const nowIso = new Date().toISOString();
        const query = `alerts?is_active=eq.true&expires_at=gt.${nowIso}&or=(target_scope.eq.ALL,and(target_scope.eq.PVZ,target_value.eq.${CURRENT_PVZ}),and(target_scope.eq.DEVICE,target_value.eq.${DEVICE_ID}))`;
        const alerts = await supabaseReq(query, 'GET');
        if (Array.isArray(alerts) && alerts.length > 0) {
            const dismissed = getDismissedAlerts();
            const freshAlert = alerts.find(a => !dismissed.has(String(a.id)));
            if (freshAlert) renderCentralAlertModal(freshAlert);
        }
    }

    function renderCentralAlertModal(alertObj) {
        if (document.getElementById(`bb-alert-modal-root`)) return;
        const modal = document.createElement('div');
        modal.id = `bb-alert-modal-root`;
        modal.innerHTML = `
            <div class="bb-alert-window">
                <div class="bb-alert-head">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="bb-alert-dot"></span>
                        <span class="bb-alert-title">${alertObj.title || 'Служебное уведомление'}</span>
                    </div>
                    <span class="bb-alert-scope-pill">${alertObj.target_scope === 'ALL' ? 'Вся сеть' : CURRENT_PVZ}</span>
                </div>
                <div class="bb-alert-body">${alertObj.message}</div>
                <div class="bb-alert-foot">
                    <button class="bb-alert-btn" id="bb-dismiss-alert-btn">Ознакомлен</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#bb-dismiss-alert-btn').onclick = () => {
            saveDismissedAlert(alertObj.id);
            modal.remove();
        };
    }

    // Реле остатков на складе
    function sendWarehouseRemainsRelay(count) {
        if (count === null || count === undefined) return;
        const payload = {
            pvz_id: CURRENT_PVZ,
            items_count: parseInt(count, 10) || 0,
            updated_at: new Date().toISOString()
        };
        supabaseReq('warehouse_remains?on_conflict=pvz_id', 'POST', payload);
    }

    // Реле рейтингов и оценок (без themes)
    function sendRatingDetailsRelay(items) {
        if (!Array.isArray(items) || items.length === 0) return;
        const payload = items.map(it => {
            const opDate = it.operationDate || new Date().toISOString();
            const uniqueId = `${CURRENT_PVZ}_${opDate}_${it.userAlias || 'none'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            return {
                id: uniqueId,
                pvz_id: CURRENT_PVZ,
                score: it.score || 5,
                user_alias: (it.userAlias || '').replace('PVZ_', '').trim(),
                comment: it.comment || '',
                weight: Number(it.weight || 0),
                claim: Boolean(it.claim),
                operation_date: it.operationDate || null,
                rating_date: it.date || null
            };
        });
        supabaseReq('ratings_feed?on_conflict=id', 'POST', payload);
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
                    await dbPut('client_tags', { clientId: String(item.client_id), tags: item.tags || [] });
                }
            }
        }
    }

    async function cloudSyncTagPush(clientId, tags) {
        const payload = { client_id: String(clientId), tags: tags || [], updated_at: new Date().toISOString() };
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
            current_operator: getOperatorLogin() || 'Ожидание смены',
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
        if (!barcode) return;
        const payload = {
            pvz_id: CURRENT_PVZ,
            barcode: String(barcode).trim(),
            cell: cell ? String(cell).trim() : 'Основная',
            operator: op || getOperatorLogin() || 'Склад',
            time: Date.now()
        };
        supabaseReq('inbounds', 'POST', payload);
    }

    function parseAndRecordInboundNetwork(data) {
        if (!data) return;
        let address = data.targetAddress || data.shelfAddress || data.address || data.articlePositions?.[0]?.address || data.state?.address || data.article?.address || data.cell || '';
        let barcode = data.barcode || data.articlePositions?.[0]?.barcode || data.state?.barcode || data.article?.barcode || data.article?.name || '';

        if (barcode && address) {
            recordInboundRelay(barcode, address, getOperatorLogin());
            return;
        }

        if (Array.isArray(data.articlePositions)) {
            data.articlePositions.forEach(pos => {
                if (pos.barcode && (pos.address || address)) {
                    recordInboundRelay(pos.barcode, pos.address || address, getOperatorLogin());
                }
            });
        }
    }

    async function fetchPostingInboundHistory(postingId) {
        if (!postingId) return null;
        const pIdStr = String(postingId);
        if (postingsInboundCache.has(pIdStr)) return postingsInboundCache.get(pIdStr);

        try {
            const headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'x-o3-app-name': 'turbo-pvz-ui'
            };
            if (window._ozonAuthHeaders) Object.assign(headers, window._ozonAuthHeaders);

            const res = await fetch(`https://turbo-pvz.ozon.ru/api2/article-tracking/Entity/operation-history-v2?entityId=${pIdStr}&entityType=Article&entitySubType=ArticlePosting`, {
                headers, credentials: 'same-origin'
            });

            if (res.ok) {
                const data = await res.json();
                const inboundInfo = extractPlacementFromHistory(data);
                if (inboundInfo) {
                    postingsInboundCache.set(pIdStr, inboundInfo);
                    return inboundInfo;
                }
            }
        } catch (e) {}

        return { text: 'Принят на баланс пункта выдачи', time: '—', operator: 'Склад' };
    }

    function extractPlacementFromHistory(historyData) {
        if (!historyData || !Array.isArray(historyData.operationSteps)) return null;
        for (let step of historyData.operationSteps) {
            if (step.operationStepType === 'OnStore' && Array.isArray(step.operations)) {
                for (let opGroup of step.operations) {
                    if (Array.isArray(opGroup)) {
                        for (let op of opGroup) {
                            if (op.description && (op.description.includes('Разместили') || op.description.includes('Приняли на баланс'))) {
                                const d = new Date(op.momentUtc);
                                const timeStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                                return {
                                    text: op.description.replace('Разместили в ячейку', 'Яч.').replace('Разместили', 'Размещен').trim(),
                                    time: timeStr,
                                    operator: (op.userName || '').replace('PVZ_', '').trim() || 'Склад'
                                };
                            }
                        }
                    }
                }
            }
        }
        return null;
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

        let specificShelf = p.shelfAddress || p.address || '';
        if (!specificShelf && Array.isArray(p.postingShelves) && p.postingShelves.length > 0) {
            specificShelf = p.postingShelves.join(', ');
        }
        if (!specificShelf) specificShelf = 'Основная';

        return {
            id: String(p.id),
            name: title,
            barcode: bar,
            shelf: specificShelf,
            allBarcodes: (p.barcodes || []).map(b => String(b).toLowerCase()),
            price: p.price || 0,
            status: 'storage',
            isScanned: false,
            scannedAt: null,
            scannedTimeFormatted: '',
            scannedBy: '',
            reasonText: '',
            inbound: null
        };
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

    // ================= ПЕРЕХВАТЧИК СЕТИ (ОСТАТКИ, РЕЙТИНГИ, ПРИЕМКА, ВЫДАЧА) =================
    function interceptPayload(url, reqBody, resData, status = 200) {
        // 1. Перехват остатков склада
        if (url.includes('/WarehouseRemains/GetWarehouseRemains')) {
            try {
                const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                if (parsed && typeof parsed.count === 'number') {
                    sendWarehouseRemainsRelay(parsed.count);
                }
            } catch (e) {}
        }

        // 2. Перехват оценок и рейтинга
        if (url.includes('/analytics/rating/details')) {
            try {
                const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
                if (parsed && Array.isArray(parsed.items)) {
                    sendRatingDetailsRelay(parsed.items);
                }
            } catch (e) {}
        }

        // 3. Перехват приемки всех типов
        if (url.includes('/Movement/put') || 
            url.includes('/clearing/articles/receive') || 
            url.includes('/Resolver/GetResolveEntity') ||
            url.includes('/receive-by-cell') ||
            url.includes('/clearing/postings/receive')) {
            try { parseAndRecordInboundNetwork(typeof resData === 'string' ? JSON.parse(resData) : resData); } catch (e) {}
        }

        if (url.includes('/api2/giveout/Sessions/close')) {
            let closedId = null;
            if (typeof reqBody === 'string') { try { closedId = JSON.parse(reqBody).sessionId; } catch (e) {} } else if (reqBody && reqBody.sessionId) closedId = reqBody.sessionId;
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

                    const taskList = parsedRes?.tasks || parsedRes?.data?.tasks;
                    if (Array.isArray(taskList) && taskList.length > 0) {
                        taskList.forEach(t => {
                            const taskIdStr = String(t.taskId || t.id);
                            pendingGiveoutTasks.set(taskIdStr, { sessionId: sId });
                        });
                    } else {
                        finalizeActiveSession(sId, 'completed');
                    }
                }
            } catch (e) {
                finalizeActiveSession(null, 'completed');
            }
        }

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

        let realCode = sessionStorage.getItem('client_code_' + sId) || sessionStorage.getItem('client_code_pending');
        if (!realCode && session && session.pickupCode && !session.pickupCode.includes('----')) realCode = session.pickupCode;
        if (!realCode && clientId) {
            const cachedByCid = sessionStorage.getItem('client_code_cid_' + clientId);
            if (cachedByCid) realCode = cachedByCid;
        }

        const currentCode = realCode || (clientId ? `${clientId}*----` : '');
        if (realCode && !realCode.includes('----')) {
            sessionStorage.setItem('client_code_' + sId, realCode);
            if (clientId) sessionStorage.setItem('client_code_cid_' + clientId, realCode);
            sessionStorage.removeItem('client_code_pending');
        }

        const apiOperator = sessionStorage.getItem('session_operator_' + sId) || '';
        const postingsList = readyPostings.map(extractPostingDetails);

        // Сохраняем флаги сканов, если они уже были в сессии
        if (session && Array.isArray(session.postings)) {
            postingsList.forEach(newP => {
                const oldP = session.postings.find(x => String(x.id) === String(newP.id));
                if (oldP && oldP.isScanned) {
                    newP.isScanned = true;
                    newP.scannedAt = oldP.scannedAt;
                    newP.scannedTimeFormatted = oldP.scannedTimeFormatted;
                    newP.scannedBy = oldP.scannedBy;
                }
            });
        }

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
            session.postings = postingsList;
        }

        activeSession = session;
        await dbPut('sessions', session);
        cloudSyncSession(session);

        session.postings.forEach(p => {
            fetchPostingInboundHistory(p.id).then(ib => {
                if (ib) { p.inbound = ib; dbPut('sessions', session); }
            });
        });
    }

    // Финализация сессии без затирания флагов скана
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

            // Если товар отсканирован в таймлайне, подтверждаем флаг
            const wasScannedInTimeline = (session.timeline || []).some(t => t.type === 'scan' && t.postingId === pObj.id);
            if (wasScannedInTimeline) pObj.isScanned = true;

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
                    pObj.status = 'storage';
                    storageCount++;
                }
            } else {
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

        if (activeSession && String(activeSession.sessionId) === String(targetId)) activeSession = null;

        const listEl = document.getElementById('bb-sessions-list');
        if (listEl) renderTabContent('sessions');
    }

    // ================= СЛУШАТЕЛЬ КЛАВИАТУРЫ =================
    window.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyB') {
            e.preventDefault();
            e.stopPropagation();
            toggleInspectorModal();
            return;
        }

        if (e.key === 'Escape') {
            const modalRoot = document.getElementById('bb-alert-modal-root');
            if (modalRoot) { e.preventDefault(); e.stopPropagation(); modalRoot.remove(); return; }
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

    // ================= ТОЧНЫЙ ТРЕКИНГ СКАНЕРА =================
    async function processBarcodeScan(barcode) {
        const clean = barcode.toLowerCase().trim();
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

                        if (clean.includes(pId) || pId.includes(clean)) return true;
                        if (pBar && (clean.includes(pBar) || pBar.includes(clean))) return true;
                        if (bList.some(b => clean.includes(b) || b.includes(clean))) return true;

                        if (clean.startsWith('01') && clean.length > 14) {
                            const gtin = clean.slice(2, 16);
                            if (pBar.includes(gtin) || bList.some(b => b.includes(gtin))) return true;
                        }
                        return false;
                    });

                    if (targetPosting) {
                        isMatchInCurrent = true;
                        const nowTs = Date.now();
                        const timeStr = new Date(nowTs).toLocaleTimeString('ru-RU');

                        // Фиксируем флаг скана в объекте товара
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
        cloudSyncSession(session);
    }

    async function verifyOzonArticle(barcode) {
        try {
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
            if (window._ozonAuthHeaders) Object.assign(headers, window._ozonAuthHeaders);
            const res = await fetch('https://turbo-pvz.ozon.ru/p-api/article-tracking/Entity/Find', { method: 'POST', headers: headers, body: JSON.stringify({ isManualInput: false, name: barcode }), credentials: 'same-origin' });
            if (res.ok) {
                const data = await res.json();
                if (data.entity && data.entity.id) return { isOzonArticle: true, name: data.entity.name || '' };
            }
        } catch (e) {}
        return { isOzonArticle: false };
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
            const clientName = nameEl.textContent.trim();

            wrap.innerHTML = tags.map(t => {
                const dateStr = new Date(t.date || Date.now()).toLocaleDateString('ru-RU');
                return `
                    <div class="bb-dom-tag-badge color-${t.color || 'purple'}">
                        <span>${t.title}</span>
                        <span class="bb-dom-tag-rm" data-tag="${t.title}" title="Запросить удаление метки">×</span>
                        <div class="bb-tag-tooltip">
                            <div class="bb-tt-title">${t.title}</div>
                            ${t.desc ? `<div class="bb-tt-desc">${t.desc}</div>` : ''}
                            <div class="bb-tt-meta">Автор: <b>${t.author}</b> · ${dateStr}</div>
                        </div>
                    </div>
                `;
            }).join('') + `<button type="button" class="bb-dom-tag-add" id="bb-request-add-tag-btn">+ Метка</button>`;

            // Запрос на УДАЛЕНИЕ через сервер
            wrap.querySelectorAll('.bb-dom-tag-rm').forEach(rm => {
                rm.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm(`Отправить запрос руководству на снятие метки "${rm.dataset.tag}"?`)) {
                        await supabaseReq('tag_requests', 'POST', {
                            pvz_id: CURRENT_PVZ,
                            device_id: DEVICE_ID,
                            operator: getOperatorLogin() || 'Оператор',
                            client_id: String(clientId),
                            client_name: clientName,
                            action: 'REMOVE',
                            tag_data: { title: rm.dataset.tag },
                            status: 'PENDING'
                        });
                        alert('📨 Запрос на снятие метки передан руководству в панель управления.');
                    }
                };
            });

            // Запрос на ДОБАВЛЕНИЕ через сервер
            const addBtn = wrap.querySelector('#bb-request-add-tag-btn');
            if (addBtn) {
                addBtn.onclick = (e) => {
                    e.stopPropagation();
                    openTagRequestModal(clientId, clientName);
                };
            }
        }
        renderDomTags();
    }
    setInterval(injectDomTags, 400);

    function openTagRequestModal(clientId, clientName) {
        let ex = document.getElementById('bb-tag-request-modal');
        if (ex) ex.remove();

        const modal = document.createElement('div');
        modal.id = 'bb-tag-request-modal';
        modal.innerHTML = `
            <div class="bb-tag-dialog">
                <div class="bb-tag-dialog-head">
                    <span>Запрос метки для клиента: <b>#${clientId}</b></span>
                    <span class="bb-tag-dialog-close" id="bb-req-cancel">✕</span>
                </div>
                <div class="bb-tag-dialog-body">
                    <label class="bb-tag-label">Название метки</label>
                    <input type="text" class="bb-input" id="bb-req-title-inp" placeholder="Скандалист, Проверяет всё, VIP..." autofocus>

                    <label class="bb-tag-label">Причина (заметка руководству)</label>
                    <textarea class="bb-input" id="bb-req-desc-inp" rows="2" placeholder="Опишите ситуацию с клиентом..."></textarea>

                    <label class="bb-tag-label">Цвет</label>
                    <div class="bb-tag-colors">
                        <label class="bb-color-opt"><input type="radio" name="tagReqColor" value="purple" checked><span class="bb-color-dot" style="background:#a855f7;"></span><span>Фиолетовый</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagReqColor" value="amber"><span class="bb-color-dot" style="background:#f59e0b;"></span><span>Оранжевый</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagReqColor" value="red"><span class="bb-color-dot" style="background:#ef4444;"></span><span>Красный</span></label>
                        <label class="bb-color-opt"><input type="radio" name="tagReqColor" value="emerald"><span class="bb-color-dot" style="background:#10b981;"></span><span>Зеленый</span></label>
                    </div>
                </div>
                <div class="bb-tag-dialog-foot">
                    <button class="bb-btn-save-tag" id="bb-req-send-btn">Отправить запрос</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('#bb-req-cancel').onclick = () => modal.remove();
        modal.querySelector('#bb-req-send-btn').onclick = async () => {
            const title = modal.querySelector('#bb-req-title-inp').value.trim();
            const desc = modal.querySelector('#bb-req-desc-inp').value.trim();
            const color = modal.querySelector('input[name="tagReqColor"]:checked').value;

            if (!title) {
                modal.querySelector('#bb-req-title-inp').focus();
                return;
            }

            modal.remove();

            await supabaseReq('tag_requests', 'POST', {
                pvz_id: CURRENT_PVZ,
                device_id: DEVICE_ID,
                operator: getOperatorLogin() || 'Оператор',
                client_id: String(clientId),
                client_name: clientName || '',
                action: 'ADD',
                tag_data: { title, desc, color },
                status: 'PENDING'
            });

            alert('📨 Запрос на добавление метки отправлен руководству. После одобрения метка автоматически появится на всех ПВЗ.');
        };
    }function openTagRequestModal(clientId, clientName) {
        let ex = document.getElementById('bb-tag-request-modal');
        if (ex) ex.remove();

        let selectedColor = 'purple';

        const modal = document.createElement('div');
        modal.id = 'bb-tag-request-modal';
        modal.innerHTML = `
            <div class="bb-custom-modal-window">
                <div class="bb-custom-modal-head">
                    <span>Запрос метки для #${clientId}</span>
                    <span class="bb-custom-modal-close" id="bb-req-modal-close">✕</span>
                </div>
                <div class="bb-custom-modal-body">
                    <label>Название метки</label>
                    <input type="text" id="bb-req-title-inp" placeholder="Скандалист, VIP, Проверяет..." autofocus>

                    <label>Причина запроса (руководству)</label>
                    <textarea id="bb-req-desc-inp" rows="3" placeholder="Опишите поведение клиента..."></textarea>

                    <label>Категория</label>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:2px;" id="bb-req-colors-row">
                        <span class="color-btn selected" data-color="purple" style="width:20px; height:20px; border-radius:50%; background:#c084fc; cursor:pointer; outline:2px solid #fff;"></span>
                        <span class="color-btn" data-color="amber" style="width:20px; height:20px; border-radius:50%; background:#fbbf24; cursor:pointer;"></span>
                        <span class="color-btn" data-color="red" style="width:20px; height:20px; border-radius:50%; background:#f87171; cursor:pointer;"></span>
                        <span class="color-btn" data-color="emerald" style="width:20px; height:20px; border-radius:50%; background:#34d399; cursor:pointer;"></span>
                    </div>
                </div>
                <div class="bb-custom-modal-foot">
                    <button class="bb-btn" id="bb-req-send-btn" style="background:#005bff !important; color:#fff !important; padding:6px 16px;">Отправить запрос</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('#bb-req-colors-row .color-btn').forEach(btn => {
            btn.onclick = () => {
                modal.querySelectorAll('#bb-req-colors-row .color-btn').forEach(b => b.style.outline = 'none');
                btn.style.outline = '2px solid #fff';
                selectedColor = btn.dataset.color;
            };
        });

        modal.querySelector('#bb-req-modal-close').onclick = () => modal.remove();
        modal.querySelector('#bb-req-send-btn').onclick = async () => {
            const title = modal.querySelector('#bb-req-title-inp').value.trim();
            const desc = modal.querySelector('#bb-req-desc-inp').value.trim();

            if (!title) {
                modal.querySelector('#bb-req-title-inp').focus();
                return;
            }

            modal.remove();

            await supabaseReq('tag_requests', 'POST', {
                pvz_id: CURRENT_PVZ,
                device_id: DEVICE_ID,
                operator: getOperatorLogin() || 'Оператор',
                client_id: String(clientId),
                client_name: clientName || '',
                action: 'ADD',
                tag_data: { title, desc, color: selectedColor },
                status: 'PENDING'
            });

            // Ненавязчивое всплывающее подтверждение оператору
            renderCentralAlertModal({
                id: 'local_req_confirm',
                title: 'Запрос передан руководству',
                message: `Заявка на добавление метки "${title}" отправлена в управляющий центр. После одобрения она появится на всех филиалах.`,
                target_scope: 'DEVICE'
            });
        };
    }

    

    // ================= СТИЛИ ИНСПЕКТОРА С ТОНКИМ СКРОЛЛБАРОМ =================
    const modalStyle = document.createElement('style');
    modalStyle.innerHTML = `
        #blackbox-modal-root {
            position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.8) !important; backdrop-filter: blur(20px) saturate(180%) !important;
            z-index: 10000000 !important; display: flex !important; align-items: center !important; justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important; color: #f8fafc !important;
        }

        .bb-dom-tag-add {
            background: #ffffff !important;
            color: #0f172a !important;
            border: 1px solid #cbd5e1 !important;
            padding: 3px 8px !important;
            border-radius: 6px !important;
            font-size: 11px !important;
            font-weight: 700 !important;
            cursor: pointer !important;
            transition: all 0.15s ease !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            line-height: 1 !important;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05) !important;
            user-select: none !important;
            vertical-align: middle !important;
        }
        .bb-dom-tag-add:hover {
            background: #f1f5f9 !important;
            border-color: #94a3b8 !important;
            color: #0284c7 !important;
            transform: translateY(-1px) !important;
        }
        .bb-dom-tag-add:active {
            transform: translateY(0) !important;
        }

        /* МОДАЛЬНЫЕ ОКНА: ВВОД ПАРОЛЯ И ЗАПРОС МЕТКИ (ЖЕСТКИЙ ФИКС СЕТКИ) */
        #bb-password-modal-root, #bb-tag-request-modal {
            position: fixed !important;
            top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.85) !important;
            backdrop-filter: blur(12px) !important;
            z-index: 10000005 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important;
        }

        .bb-custom-modal-window {
            background: #0f172a !important;
            border: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-radius: 14px !important;
            width: 400px !important;
            max-width: 92vw !important;
            box-shadow: 0 25px 60px rgba(0, 0, 0, 0.85) !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
            box-sizing: border-box !important;
        }

        .bb-custom-modal-head {
            display: flex !important;
            justify-content: space-between !important;
            align-items: center !important;
            padding: 12px 16px !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
            background: rgba(255, 255, 255, 0.02) !important;
            font-size: 13px !important;
            font-weight: 800 !important;
            color: #f8fafc !important;
        }
        .bb-custom-modal-close {
            cursor: pointer !important;
            color: #64748b !important;
            font-size: 16px !important;
            font-weight: bold !important;
            line-height: 1 !important;
            padding: 2px 4px !important;
        }
        .bb-custom-modal-close:hover { color: #fff !important; }

        .bb-custom-modal-body {
            padding: 16px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 10px !important;
            box-sizing: border-box !important;
        }
        .bb-custom-modal-body label {
            font-size: 10px !important;
            font-weight: 700 !important;
            text-transform: uppercase !important;
            color: #94a3b8 !important;
            letter-spacing: 0.5px !important;
            margin-bottom: -4px !important;
        }
        .bb-custom-modal-body input, .bb-custom-modal-body textarea {
            background: #1e293b !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            color: #fff !important;
            padding: 8px 12px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            outline: none !important;
            width: 100% !important;
            box-sizing: border-box !important;
        }
        .bb-custom-modal-body input:focus, .bb-custom-modal-body textarea:focus {
            border-color: #38bdf8 !important;
        }

        .bb-custom-modal-foot {
            padding: 12px 16px !important;
            border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
            display: flex !important;
            justify-content: flex-end !important;
            gap: 8px !important;
        }

        /* КАСТОМНЫЙ ТОНКИЙ СКРОЛЛБАР ВЕЗДЕ ВНУТРИ ИНСПЕКТОРА */
        #blackbox-modal-root *::-webkit-scrollbar { width: 4px !important; height: 4px !important; }
        #blackbox-modal-root *::-webkit-scrollbar-track { background: transparent !important; }
        #blackbox-modal-root *::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16) !important; border-radius: 4px !important; }
        #blackbox-modal-root *::-webkit-scrollbar-thumb:hover { background: rgba(56, 189, 248, 0.45) !important; }

        #bb-alert-modal-root {
            position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.85) !important; backdrop-filter: blur(12px) !important;
            z-index: 10000005 !important; display: flex !important; align-items: center !important; justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important;
        }
        .bb-alert-window {
            background: #0f172a !important; border: 1.5px solid #ef4444 !important; border-radius: 14px !important;
            width: 440px !important; max-width: 90vw !important; box-shadow: 0 25px 60px rgba(0,0,0,0.85) !important;
            display: flex !important; flex-direction: column !important; overflow: hidden !important;
        }
        .bb-alert-head {
            display: flex !important; justify-content: space-between !important; align-items: center !important;
            padding: 12px 18px !important; border-bottom: 1px solid rgba(255,255,255,0.08) !important; background: rgba(239, 68, 68, 0.08) !important;
        }
        .bb-alert-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 8px #ef4444; display: inline-block; }
        .bb-alert-title { font-weight: 800; font-size: 13px; color: #f87171; letter-spacing: 0.3px; }
        .bb-alert-scope-pill { font-size: 10px; font-weight: 800; font-family: monospace; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: #cbd5e1; }
        .bb-alert-body { padding: 18px !important; font-size: 13px !important; line-height: 1.45 !important; color: #f8fafc !important; }
        .bb-alert-foot { padding: 12px 18px !important; border-top: 1px solid rgba(255,255,255,0.08) !important; display: flex !important; justify-content: flex-end !important; }
        .bb-alert-btn {
            background: #005bff !important; color: #ffffff !important; border: none !important; padding: 8px 20px !important;
            border-radius: 8px !important; font-weight: 700 !important; font-size: 12px !important; cursor: pointer !important;
        }
        .bb-alert-btn:hover { background: #004ecc !important; }

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

        .bb-card { background: rgba(255, 255, 255, 0.03) !important; border: 1px solid rgba(255, 255, 255, 0.06) !important; border-radius: 10px !important; padding: 10px 12px !important; cursor: pointer !important; transition: all 0.15s !important; display: flex !important; flex-direction: column !important; gap: 5px !important; }
        .bb-card:hover { background: rgba(255, 255, 255, 0.06) !important; border-color: rgba(255, 255, 255, 0.15) !important; }
        .bb-card.has-alien { border-left: 3px solid #ef4444 !important; }

        .bb-card-head { display: flex !important; justify-content: space-between !important; align-items: center !important; }
        .bb-card-name { font-weight: 700; font-size: 13px; color: #f8fafc; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .bb-card-time { font-size: 11px; color: #64748b; font-family: monospace; }
        .bb-card-sub { font-size: 12px; color: #94a3b8; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

        .bb-btn {
            background: #1c3557 !important; color: #38bdf8 !important; border: 1px solid #2b4260 !important;
            padding: 6px 12px !important; border-radius: 8px !important; font-size: 12px !important; font-weight: 600 !important;
            cursor: pointer !important; transition: all 0.15s !important; display: inline-flex !important; align-items: center !important; gap: 5px !important;
        }
        .bb-btn:hover { background: #007aff !important; color: #fff !important; }
        .bb-btn-danger { background: rgba(239, 68, 68, 0.15) !important; color: #f87171 !important; border-color: rgba(239, 68, 68, 0.3) !important; }
        .bb-btn-danger:hover { background: #ef4444 !important; color: #fff !important; }

        .bb-posting-placement-badge {
            background: rgba(16, 185, 129, 0.12) !important; border: 1px solid rgba(16, 185, 129, 0.3) !important;
            color: #34d399 !important; padding: 3px 8px !important; border-radius: 6px !important; font-size: 10px !important;
            margin-top: 5px !important; display: inline-flex !important; align-items: center !important; gap: 6px !important;
        }

        .bb-dom-tag-badge {
            position: relative; padding: 3px 8px !important; border-radius: 6px !important; font-size: 12px !important;
            font-weight: 700 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important;
            gap: 6px !important; cursor: default !important; user-select: none !important; line-height: 1 !important; box-sizing: border-box !important;
        }
        .bb-dom-tag-badge.color-purple { background: #f3e8ff !important; color: #7e22ce !important; border: 1px solid #d8b4fe !important; }
        .bb-dom-tag-badge.color-amber  { background: #fef3c7 !important; color: #b45309 !important; border: 1px solid #fde68a !important; }
        .bb-dom-tag-badge.color-red    { background: #fee2e2 !important; color: #b91c1c !important; border: 1px solid #fecaca !important; }
        .bb-dom-tag-badge.color-emerald{ background: #d1fae5 !important; color: #047857 !important; border: 1px solid #a7f3d0 !important; }

        .bb-dom-tag-rm { cursor: pointer !important; opacity: 0.5 !important; padding: 0 1px !important; font-weight: 800 !important; font-size: 12px !important; line-height: 1 !important; display: inline-flex !important; align-items: center !important; }
        .bb-dom-tag-rm:hover { opacity: 1 !important; }

        .bb-tag-tooltip {
            position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); width: 220px;
            max-height: 180px; overflow-y: auto; background: #090d16; border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px; padding: 8px 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.85); pointer-events: none; opacity: 0;
            transition: opacity 0.15s ease; z-index: 8999 !important; text-align: left;
        }
        .bb-dom-tag-badge:hover .bb-tag-tooltip { opacity: 1; }
        .bb-tt-title { font-size: 12px; font-weight: 800; color: #f8fafc; margin-bottom: 2px; }
        .bb-tt-desc { font-size: 11px; color: #cbd5e1; line-height: 1.3; margin-bottom: 4px; word-break: break-word; }
        .bb-tt-meta { font-size: 9px; color: #64748b; font-family: monospace; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; }
    `;
    document.head.appendChild(modalStyle);

    function closeInspectorModal() {
        const m = document.getElementById('blackbox-modal-root');
        if (m) m.remove();
        document.body.style.overflow = '';
    }

    function toggleInspectorModal() {
        let m = document.getElementById('blackbox-modal-root');
        if (m) {
            closeInspectorModal();
            return;
        }

        const authKey = 'bb_inspector_authed_slot';
        const currentSlot = String(Math.floor(Date.now() / (2 * 3600 * 1000)));

        
        if (sessionStorage.getItem(authKey) === currentSlot) {
            openInspector();
            return;
        }

        renderPasswordPromptModal(currentSlot);
    }

    function renderPasswordPromptModal(currentSlot) {
        if (document.getElementById('bb-password-modal-root')) return;

        // Если фоновое окно инспектора случайно создалось — удаляем его намертво
        const existingInspector = document.getElementById('blackbox-modal-root');
        if (existingInspector) existingInspector.remove();

        const modal = document.createElement('div');
        modal.id = 'bb-password-modal-root';
        modal.innerHTML = `
            <div class="bb-custom-modal-window">
                <div class="bb-custom-modal-head">
                    <span style="display:flex; align-items:center; gap:6px;">
                        <span style="color:#38bdf8;">🔒</span> Вход в BlackBox
                    </span>
                    <span class="bb-custom-modal-close" id="bb-pass-modal-close">✕</span>
                </div>
                <div class="bb-custom-modal-body">
                    <label>Динамический пароль доступа (2 часа)</label>
                    <input type="password" id="bb-pass-input" placeholder="4-значный код из админки..." maxlength="8" autofocus autocomplete="off">
                    <div id="bb-pass-error-msg" style="color:#ef4444; font-size:11px; font-weight:bold; display:none;">Неверный код доступа</div>
                </div>
                <div class="bb-custom-modal-foot">
                    <button class="bb-btn" id="bb-pass-submit-btn" style="background:#005bff !important; color:#fff !important; padding:6px 16px;">Войти</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const passInput = modal.querySelector('#bb-pass-input');
        const errorMsg = modal.querySelector('#bb-pass-error-msg');

        const abortLogin = () => {
            modal.remove();
            closeInspectorModal(); // Гарантированное закрытие инспектора
        };

        const verifyAndLogin = () => {
            const entered = passInput.value.trim();
            const correctPass = getTwoHourPasscode();

            if (entered === correctPass) {
                sessionStorage.setItem('bb_inspector_authed_slot', currentSlot);
                modal.remove();
                openInspector(); // Открываем ТОЛЬКО при правильном пароле
            } else {
                errorMsg.style.display = 'block';
                passInput.style.borderColor = '#ef4444';
                passInput.value = '';
                passInput.focus();
            }
        };

        modal.querySelector('#bb-pass-modal-close').onclick = abortLogin;
        modal.querySelector('#bb-pass-submit-btn').onclick = verifyAndLogin;
        passInput.onkeydown = (e) => {
            if (e.key === 'Enter') verifyAndLogin();
            if (e.key === 'Escape') abortLogin();
        };
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
                            html += `<div class="tree-children" style="margin-left: 16px; padding-left: 10px; border-left: 2px solid rgba(255,255,255,0.12);">${renderTreeHtml(node.children)}</div>`;
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

                    // СЕГОДНЯ: Открыто сразу со всеми сессиями
                    if (isToday) {
                        const trees = buildSessionTrees(groupItems);
                        wrapper.innerHTML = `
                            <div style="display:flex; justify-content:space-between; padding:6px 10px; margin-top:8px; background:rgba(56,189,248,0.06); border-radius:6px; font-size:11px; font-weight:bold; color:#38bdf8;">
                                <span>📅 ${dateTitle}</span>
                                <span style="opacity:0.6;">${groupItems.length} сессий</span>
                            </div>
                            <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">${renderTreeHtml(trees)}</div>
                        `;
                    } 
                    // ВСЕ ОСТАЛЬНЫЕ ДНИ: Полностью скрыты в аккордеон, строятся строго по первому клику
                    else {
                        wrapper.innerHTML = `
                            <details class="bb-day-accordion" style="margin-top:6px;">
                                <summary style="cursor:pointer; display:flex; justify-content:space-between; padding:6px 10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:6px; font-size:11px; font-weight:bold; color:#94a3b8; user-select:none;">
                                    <span>📅 ${dateTitle} ▾ (Скрыто)</span>
                                    <span style="opacity:0.6;">${groupItems.length} сессий</span>
                                </summary>
                                <div class="bb-tree-root-lazy" style="display:flex; flex-direction:column; gap:6px; margin-top:4px; padding-left:4px;">
                                    <div style="font-size:11px; color:#64748b; padding:6px;">Нажмите, чтобы развернуть дерево...</div>
                                </div>
                            </details>
                        `;

                        const detailsEl = wrapper.querySelector('details');
                        detailsEl.addEventListener('toggle', function() {
                            if (detailsEl.open) {
                                const targetContainer = detailsEl.querySelector('.bb-tree-root-lazy');
                                if (!targetContainer.dataset.loaded) {
                                    targetContainer.dataset.loaded = 'true';
                                    const trees = buildSessionTrees(groupItems);
                                    targetContainer.innerHTML = renderTreeHtml(trees);
                                    attachCardClickHandlers(targetContainer, items);
                                }
                            }
                        }, { once: true });
                    }

                    attachCardClickHandlers(wrapper, items);
                    listEl.appendChild(wrapper);
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
                <div style="display: flex; flex-direction: column; gap: 10px; max-width: 500px;">
                    <div style="font-size: 12px; color: #94a3b8;">Локальный ПК: <b>${DEVICE_ID}</b> (${CURRENT_PVZ})</div>
                    <div style="font-size: 12px; color: #94a3b8;">Сессий в локальной базе: <b>${sessions.length}</b></div>
                    <div style="font-size: 12px; color: #94a3b8;">Занято диска: <b>${usageMb} / ${quotaMb} МБ (${percent}%)</b></div>
                    <button class="bb-btn" id="bb-change-pvz-btn" style="background:#0284c7; color:#fff; width: fit-content;">🏢 Сменить ПВЗ</button>
                    ${ENABLE_DEV_PURGE ? `<button class="bb-btn bb-btn-danger" id="bb-purge-btn" style="width: fit-content; margin-top: 10px;">⚠️ Очистить локальную БД</button>` : ''}
                </div>
            `;

            container.querySelector('#bb-change-pvz-btn').onclick = () => {
                const next = prompt(`Выберите ПВЗ для этого компьютера:\n${PVZ_LIST.join(', ')}`, CURRENT_PVZ);
                if (next && PVZ_LIST.includes(next)) {
                    localStorage.setItem('bb_current_pvz', next);
                    location.reload();
                }
            };

            if (ENABLE_DEV_PURGE) {
                container.querySelector('#bb-purge-btn').onclick = async () => {
                    if (confirm('Стереть ВСЕ данные из базы этого ПК?')) {
                        await clearEntireDB();
                        renderTabContent('storage');
                    }
                };
            }
        }
    }

    // ================= РЕКОНСТРУКЦИЯ С ТОЧНЫМ СТАТУСОМ СКАНА =================
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
                <div class="bb-client-tags-wrap" id="bb-replay-tags-wrap" style="margin-left: 0; display:flex; gap:4px; flex-wrap:wrap;">
                    ${clientTags.length ? clientTags.map(t => `
                        <div class="bb-dom-tag-badge color-${t.color || 'purple'}">
                            <span>${t.title}</span>
                            <span class="bb-dom-tag-rm" data-rm-tag="${t.title}" title="Удалить">×</span>
                        </div>
                    `).join('') : '<span style="font-size:10px; color:#64748b;">Нет меток</span>'}
                </div>
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 12px; color: #38bdf8;">Товары заказа (${session.postings?.length || 0}):</div>
            <div style="display: flex; flex-direction: column; gap: 6px;" id="bb-postings-list-wrap">
                ${(session.postings || []).map(p => {
                    const ib = p.inbound;

                    // ПРОВЕРКА СКАНА: из объекта товара ИЛИ из таймлайна
                    const isPhysicallyScanned = p.isScanned || (session.timeline || []).some(t => t.type === 'scan' && t.postingId === p.id);
                    const scanTimeText = p.scannedTimeFormatted || (session.timeline || []).find(t => t.type === 'scan' && t.postingId === p.id)?.time ? new Date((session.timeline || []).find(t => t.type === 'scan' && t.postingId === p.id).time).toLocaleTimeString() : '';

                    const scanStatusHtml = isPhysicallyScanned 
                        ? `<span style="color: #34d399; font-weight: 700;">✓ Отсканирован${scanTimeText ? ' в ' + scanTimeText : ''} (${p.scannedBy || session.operator})</span>`
                        : `<span style="color: #f59e0b; font-weight: 600;">⚠️ Не сканировался (выдан кликом)</span>`;

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
                            <div style="margin-top: 5px; display: flex; flex-direction: column; gap: 3px; font-size: 10px;">
                                <div>${scanStatusHtml}</div>
                                <div class="bb-inbound-slot">
                                    ${ib ? `
                                        <div class="bb-posting-placement-badge">
                                            📥 <b>${ib.text}</b> · ${ib.time} · <span style="opacity:0.7">${ib.operator}</span>
                                        </div>
                                    ` : `<div style="color: #475569;">Загрузка истории приемки...</div>`}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 12px; color: #38bdf8;">Хронология событий:</div>
            <div style="display: flex; flex-direction: column; margin-top: 4px;">
                ${(session.timeline || []).map(ev => `
                    <div style="position: relative; padding-left: 14px; border-left: 2px solid ${ev.isAlien ? '#ef4444' : '#38bdf8'}; margin-left: 4px; padding-bottom: 8px;">
                        <div style="font-size: 10px; color: #64748b; font-family: monospace;">${new Date(ev.time).toLocaleTimeString()}</div>
                        <div style="font-size: 12px; color: ${ev.isAlien ? '#f87171; font-weight: bold;' : '#e2e8f0;'}">${ev.text}</div>
                    </div>
                `).join('')}
            </div>
        `;

        (session.postings || []).forEach(async (p) => {
            if (!p.inbound) {
                const ib = await fetchPostingInboundHistory(p.id);
                if (ib) {
                    p.inbound = ib;
                    await dbPut('sessions', session);
                    const slot = sidebar.querySelector(`[data-posting-card-id="${p.id}"] .bb-inbound-slot`);
                    if (slot) {
                        slot.innerHTML = `
                            <div class="bb-posting-placement-badge">
                                📥 <b>${ib.text}</b> · ${ib.time} · <span style="opacity:0.7">${ib.operator}</span>
                            </div>
                        `;
                    }
                }
            }
        });

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

        if (hasCode) {
            sidebar.querySelector('#bb-reopen-order-btn').onclick = () => {
                closeInspectorModal();
                sessionStorage.setItem('pending_client_scan', session.pickupCode);
                window.location.href = '/orders';
            };
        }
    }

    // Фоновые служебные циклы
    setInterval(sendDeviceHeartbeat, 30000);
    setInterval(cloudSyncTagsPull, 15000);
    setInterval(checkRemoteAlerts, 10000);

    // Фоллбэк завершения выдачи
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const txt = btn.textContent.trim();

        if (txt === 'Выдать' || txt.startsWith('Выдать ') || txt.startsWith('Провести ') || txt === 'Завершить' || txt.startsWith('Завершить ')) {
            const activeId = getActiveSessionIdOnTab();
            if (activeId) {
                setTimeout(() => {
                    finalizeActiveSession(activeId, 'completed');
                }, 350);
            }
        }
    }, true);

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

    async function checkMyTagRequestsStatus() {
        const query = `tag_requests?device_id=eq.${DEVICE_ID}&status=neq.PENDING&resolved_at=gt.${new Date(Date.now() - 60000).toISOString()}`;
        const res = await supabaseReq(query, 'GET');

        if (Array.isArray(res) && res.length > 0) {
            for (let req of res) {
                const isApproved = req.status === 'APPROVED';
                const actionText = req.action === 'ADD' ? 'добавление' : 'снятие';
                const statusEmoji = isApproved ? '✅ ОДОБРЕНО' : '❌ ОТКЛОНЕНО';

                renderCentralAlertModal({
                    id: req.id,
                    title: `Запрос на метку: ${statusEmoji}`,
                    message: `Руководство рассмотрело запрос на ${actionText} метки "${req.tag_data?.title}" для клиента #${req.client_id}.\nРешение: ${isApproved ? 'Метка успешно синхронизирована!' : 'Запрос отклонен.'}`,
                    target_scope: 'DEVICE'
                });
            }
        }
    }
    setInterval(checkMyTagRequestsStatus, 15000);

    initDB();
})();
