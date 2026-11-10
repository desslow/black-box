// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Ozon BlackBox
// @author       desslow
// @match        https://*.ozon.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = 'OzonBlackBoxDB';
    const DB_VERSION = 2;
    let db = null;

    let scanBuffer = '';
    let lastScanTime = Date.now();
    let currentOperator = '';

    const TAB_ID = Math.random().toString(36).slice(2, 9);

    const RUS_TO_ENG = {
        'й':'q','ц':'w','у':'e','к':'r','е':'t','н':'y','г':'u','ш':'i','щ':'o','з':'p',
        'х':'[','ъ':']','ф':'a','ы':'s','в':'d','а':'f','п':'g','р':'h','о':'j','л':'k',
        'д':'l','ж':';','э':"'",'я':'z','ч':'x','с':'c','м':'v','и':'b','т':'n','ь':'m',
        'б':',','ю':'.','.':'/','ё':'`','?':',','/':'.'
    };

    function translit(str) {
        return str.split('').map(ch => {
            const low = ch.toLowerCase();
            return RUS_TO_ENG[low] || ch;
        }).join('');
    }

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
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
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

        const clientId = data.client?.ozonClientId || (data.client?.clientId) || '';
        const clientName = data.client?.clientShortName || '';
        const shelves = Array.isArray(data.postingsShelves) ? data.postingsShelves.join(', ') : '';
        const currentCode = sessionStorage.getItem('client_code_' + sId) || (clientId ? `${clientId}*----` : '');

        let existing = await dbGet('sessions', sId);

        if (!existing) {
            existing = {
                sessionId: sId,
                clientId: String(clientId),
                clientName: clientName,
                pickupCode: currentCode,
                foundAt: Date.now(),
                closedAt: null,
                durationSec: 0,
                operator: getOperatorLogin(),
                shelves: shelves,
                postings: readyPostings.map(extractPostingDetails),
                timeline: [
                    { time: Date.now(), type: 'start', text: 'Сессия открыта' }
                ],
                alienScans: [],
                tabId: TAB_ID
            };
        } else {
            if (clientId) existing.clientId = String(clientId);
            if (clientName) existing.clientName = clientName;
            if (shelves) existing.shelves = shelves;
            if (currentCode) existing.pickupCode = currentCode;
            existing.postings = readyPostings.map(extractPostingDetails);
        }

        await dbPut('sessions', existing);
    }

    async function recordTimelineEvent(sId, type, text, isAlien = false, extraData = {}) {
        if (!sId) return;
        const session = await dbGet('sessions', String(sId));
        if (!session) return;

        const ev = { time: Date.now(), type, text, isAlien, ...extraData };
        session.timeline.push(ev);
        if (isAlien) {
            session.alienScans.push(ev);
        }
        await dbPut('sessions', session);
    }

    async function finalizeActiveSession(sId) {
        const targetId = sId ? String(sId) : getActiveSessionIdOnTab();
        if (!targetId) return;

        const session = await dbGet('sessions', targetId);
        if (!session || session.closedAt) return;

        session.closedAt = Date.now();
        session.durationSec = Math.max(1, Math.round((session.closedAt - session.foundAt) / 1000));
        session.operator = getOperatorLogin() || session.operator;

        session.postings.forEach(pObj => {
            const cardWrapper = document.querySelector(`[data-testid="${pObj.id}"]`);
            if (cardWrapper) {
                const txt = cardWrapper.textContent;
                if (txt.includes('К выдаче') && !txt.includes('К аннуляции') && !txt.includes('Отказ')) {
                    pObj.status = 'issued';
                } else if (txt.includes('К аннуляции') || txt.includes('Отказ')) {
                    pObj.status = 'annulated';
                    const reasonBtn = Array.from(cardWrapper.querySelectorAll('button')).find(b => b.textContent.includes('К аннуляции'));
                    pObj.reasonText = reasonBtn ? reasonBtn.textContent.replace('К аннуляции:', '').trim() : 'Отказ';
                } else {
                    pObj.status = 'storage';
                }
            }
        });

        session.timeline.push({ time: Date.now(), type: 'finish', text: 'Сессия завершена' });

        await dbPut('sessions', session);
    }

    async function verifyOzonArticle(barcode) {
        try {
            const res = await fetch('https://turbo-pvz.ozon.ru/p-api/article-tracking/Entity/Find', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
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

    function interceptPayload(url, data) {
        if (url.includes('/api2/giveout/Sessions/close')) {
            let closedId = null;
            if (typeof data === 'string') {
                try { closedId = JSON.parse(data).sessionId; } catch (e) {}
            } else if (data && data.sessionId) {
                closedId = data.sessionId;
            }
            finalizeActiveSession(closedId);
        }

        if (url.includes('/api2/giveout/Postings?sessionId=')) {
            const match = url.match(/sessionId=(\d+)/);
            if (match && data) {
                handleSessionPostingsData(match[1], data);
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

    XMLHttpRequest.prototype.open = function(method, url) {
        this._bUrl = typeof url === 'string' ? url : '';
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
        const body = arguments[0];
        this.addEventListener('load', function() {
            try {
                if (this._bUrl.includes('/api2/giveout/Sessions/close')) {
                    interceptPayload(this._bUrl, body);
                }
                if (this._bUrl.includes('/api2/giveout/Postings?sessionId=')) {
                    interceptPayload(this._bUrl, JSON.parse(this.responseText));
                }
                if (this._bUrl.includes('/api2/giveout/Sessions')) {
                    interceptPayload(this._bUrl, JSON.parse(this.responseText));
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const response = await origFetch.apply(this, args);

        try {
            if (url.includes('/api2/giveout/Sessions/close')) {
                interceptPayload(url, args[1]?.body);
            }
            if (url.includes('/api2/giveout/Postings?sessionId=')) {
                response.clone().json().then(data => interceptPayload(url, data)).catch(() => {});
            }
            if (url.includes('/api2/giveout/Sessions')) {
                response.clone().json().then(data => interceptPayload(url, data)).catch(() => {});
            }
        } catch (e) {}

        return response;
    };

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
                modal.remove();
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

        if (clean.includes('*')) {
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
                            recordTimelineEvent(activeId, 'junk_scan', `ℹ️ Случайный/Внешний ШК: ${barcode}`, false, { barcode, isRealParcel: false });
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

    const modalStyle = document.createElement('style');
    modalStyle.innerHTML = `
        #blackbox-modal-root {
            position: fixed !important;
            top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            background: rgba(2, 6, 23, 0.78) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            z-index: 10000000 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif !important;
            color: #f8fafc !important;
        }

        .bb-window {
            width: 960px !important;
            max-width: 95vw !important;
            height: 740px !important;
            max-height: 90vh !important;
            background: #0f172a !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 16px !important;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7) !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
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

        .bb-body { flex: 1 1 auto !important; display: flex !important; overflow: hidden !important; }
        .bb-main-view { flex: 1 1 auto !important; padding: 16px !important; overflow-y: auto !important; display: flex !important; flex-direction: column !important; gap: 10px !important; }
        .bb-replay-view { width: 420px !important; min-width: 420px !important; border-left: 1px solid rgba(255, 255, 255, 0.08) !important; background: #090d16 !important; padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 10px !important; overflow-y: auto !important; }

        .bb-input {
            background: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            color: #fff !important;
            padding: 8px 12px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            outline: none !important;
            width: 100% !important;
            box-sizing: border-box !important;
        }
        .bb-input:focus { border-color: #38bdf8 !important; }

        .bb-date-divider {
            font-size: 11px !important;
            font-weight: 800 !important;
            text-transform: uppercase !important;
            letter-spacing: 0.6px !important;
            color: #38bdf8 !important;
            background: rgba(56, 189, 248, 0.08) !important;
            padding: 4px 10px !important;
            border-radius: 6px !important;
            margin-top: 6px !important;
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

        .bb-card-head { display: flex !important; justify-content: space-between !important; align-items: center !important; }
        .bb-card-name { font-weight: 700; font-size: 14px; color: #f8fafc; }
        .bb-card-time { font-size: 11px; color: #64748b; font-family: monospace; }
        .bb-card-sub { font-size: 12px; color: #94a3b8; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

        .bb-tag { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
        .bb-tag-warn { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .bb-tag-repeat { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
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
    `;
    document.head.appendChild(modalStyle);

    function toggleInspectorModal() {
        let m = document.getElementById('blackbox-modal-root');
        if (m) {
            m.remove();
            return;
        }
        openInspector();
    }

    async function openInspector() {
        const modal = document.createElement('div');
        modal.id = 'blackbox-modal-root';
        modal.innerHTML = `
            <div class="bb-window">
                <div class="bb-header">
                    <div class="bb-title">⬛ BLACKBOX <span>// АУДИТ</span></div>
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
                    <div class="bb-replay-view" id="bb-replay-sidebar">
                        <div style="color: #64748b; font-size: 13px; text-align: center; margin-top: 40px;">Выберите сессию для посекундной реконструкции</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('#bb-close-btn').onclick = () => modal.remove();

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

    function formatDateDivider(timestamp) {
        const d = new Date(timestamp);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const isYesterday = d.toDateString() === yesterday.toDateString();

        if (isToday) return 'Сегодня';
        if (isYesterday) return 'Вчера';
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    async function renderTabContent(tab) {
        const container = document.getElementById('bb-main-content');
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!container) return;

        if (tab === 'sessions') {
            sidebar.style.display = 'flex';
            const sessions = await dbGetAll('sessions');
            sessions.sort((a, b) => b.foundAt - a.foundAt);

            container.innerHTML = `
                <input type="text" class="bb-input" id="bb-session-search" placeholder="Поиск по клиенту или штрихкоду...">
                <div id="bb-sessions-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
            `;

            const listEl = container.querySelector('#bb-sessions-list');

            function populate(items) {
                listEl.innerHTML = '';
                if (items.length === 0) {
                    listEl.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">Нет данных</div>';
                    return;
                }

                let lastDateHeader = '';

                items.forEach((s, idx) => {
                    const dateHeader = formatDateDivider(s.foundAt);
                    if (dateHeader !== lastDateHeader) {
                        lastDateHeader = dateHeader;
                        const divEl = document.createElement('div');
                        divEl.className = 'bb-date-divider';
                        divEl.textContent = dateHeader;
                        listEl.appendChild(divEl);
                    }

                    const hasAlien = s.alienScans && s.alienScans.some(a => a.isRealParcel);
                    
                    const isRepeat = s.clientId && items.some((other, oIdx) => {
                        return oIdx !== idx && other.clientId === s.clientId && Math.abs(s.foundAt - other.foundAt) < (24 * 3600 * 1000);
                    });

                    const isParallel = items.some((other, oIdx) => {
                        if (oIdx === idx || !s.closedAt || !other.closedAt) return false;
                        return (s.foundAt >= other.foundAt && s.foundAt <= other.closedAt) || (other.foundAt >= s.foundAt && other.foundAt <= s.closedAt);
                    });

                    const date = new Date(s.foundAt);
                    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

                    const card = document.createElement('div');
                    card.className = `bb-card ${hasAlien ? 'has-alien' : ''}`;
                    card.innerHTML = `
                        <div class="bb-card-head">
                            <span class="bb-card-name">${s.clientName || 'Без имени'}</span>
                            <span class="bb-card-time">${timeStr} (${s.durationSec}с)</span>
                        </div>
                        <div class="bb-card-sub">
                            <span>📦 ${s.postings?.length || 0} тов.</span>
                            <span>Яч. ${s.shelves || '—'}</span>
                            <span>👤 ${s.operator || '—'}</span>
                            ${hasAlien ? `<span class="bb-tag bb-tag-warn">⚠️ Чужой пик</span>` : ''}
                            ${isRepeat ? `<span class="bb-tag bb-tag-repeat">🔄 Повтор за 24ч</span>` : ''}
                            ${isParallel ? `<span class="bb-tag bb-tag-parallel">⚡ Параллельно</span>` : ''}
                        </div>
                    `;
                    card.onclick = () => renderSessionReplay(s);
                    listEl.appendChild(card);
                });
            }

            populate(sessions);

            container.querySelector('#bb-session-search').oninput = (e) => {
                const query = e.target.value.toLowerCase().trim();
                const filtered = sessions.filter(s => {
                    const matchName = (s.clientName || '').toLowerCase().includes(query);
                    const matchId = (s.clientId || '').toLowerCase().includes(query);
                    const matchCode = (s.pickupCode || '').toLowerCase().includes(query);
                    const matchBarcode = s.postings?.some(p => (p.barcode && p.barcode.toLowerCase().includes(query)) || p.allBarcodes?.some(b => b.includes(query)));
                    return matchName || matchId || matchCode || matchBarcode;
                });
                populate(filtered);
            };
        }

        if (tab === 'lookup') {
            sidebar.style.display = 'none';
            container.innerHTML = `
                <div style="font-size: 13px; color: #94a3b8; margin-bottom: 4px;">Введите штрихкод потерянного товара для поиска в истории сканов:</div>
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

                const allScans = await dbGetAll('scans_history');
                const matched = allScans.filter(sc => (sc.barcode || '').toLowerCase().includes(val));

                if (matched.length === 0) {
                    resEl.innerHTML = '<div style="color: #64748b; padding: 15px;">Штрихкод ни разу не сканировался на этом ПК</div>';
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
            const sessions = await dbGetAll('sessions');
            const alienSessions = sessions.filter(s => s.alienScans && s.alienScans.some(a => a.isRealParcel));

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов и аномалий не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold; margin-bottom: 6px;">Реестр опасных сканов (товар со склада не принадлежал клиенту на момент пика):</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${alienSessions.map(s => `
                        <div class="bb-card has-alien">
                            <div class="bb-card-head">
                                <span class="bb-card-name">${s.clientName} (Код: ${s.pickupCode || '—'})</span>
                                <span class="bb-card-time">${new Date(s.foundAt).toLocaleString('ru-RU')}</span>
                            </div>
                            <div class="bb-card-sub">
                                <span>Оператор: <b>${s.operator}</b></span>
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
                <div style="display: flex; flex-direction: column; gap: 14px; max-width: 500px;">
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 14px; border-radius: 10px;">
                        <div style="font-weight: bold; margin-bottom: 6px;">Статистика локальной базы IndexedDB</div>
                        <div style="font-size: 12px; color: #94a3b8;">Сохранено сессий: <b>${sessions.length}</b></div>
                        <div style="font-size: 12px; color: #94a3b8;">Всего сканов в реестре: <b>${scans.length}</b></div>
                        <div style="font-size: 12px; color: #94a3b8;">Занято дискового пространства: <b>${estSize} МБ</b></div>
                    </div>

                    <div style="display: flex; gap: 10px;">
                        <button class="bb-tab-btn active" id="bb-export-btn" style="padding: 10px 16px;">💾 Выгрузить дамп (JSON)</button>
                        <button class="bb-tab-btn" id="bb-import-btn" style="padding: 10px 16px;">📥 Слияние со вторым ПК</button>
                        <input type="file" id="bb-import-file" accept=".json" style="display: none;">
                    </div>
                    <div id="bb-import-status" style="font-size: 12px; color: #10b981;"></div>
                </div>
            `;

            container.querySelector('#bb-export-btn').onclick = () => {
                const dump = { sessions, scans, exportedAt: Date.now() };
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `blackbox_dump_${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
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
                        container.querySelector('#bb-import-status').textContent = `✅ Успешно объединено! Добавлено/обновлено сессий: ${addedSessions}`;
                    } catch (err) {
                        container.querySelector('#bb-import-status').textContent = '❌ Ошибка чтения файла';
                    }
                };
                reader.readAsText(file);
            };
        }
    }

    function renderSessionReplay(session) {
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!sidebar) return;

        sidebar.innerHTML = `
            <div style="font-weight: 800; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
                Реконструкция: ${session.clientName || 'Без имени'}
            </div>
            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px;">
                <div>Штрихкод / ID: <b>${session.pickupCode || session.clientId || '—'}</b></div>
                <div>Оператор: <b>${session.operator || '—'}</b> · Ячейки: <b>${session.shelves || '—'}</b></div>
                <div>Длительность: <b>${session.durationSec} сек</b></div>
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 10px; color: #38bdf8;">Товары к выдаче (${session.postings?.length || 0}):</div>
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
    }

    initDB();

})();
