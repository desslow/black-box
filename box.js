// ==UserScript==
// @name         Ozon BlackBox (Forensics & Audit Core)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Ozon BlackBox
// @author       desslow
// @match        https://*.ozon.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const DB_NAME = 'OzonBlackBoxDB';
    const DB_VERSION = 1;
    let db = null;

    let activeSession = null;
    let currentPostingsList = [];
    let scanBuffer = '';
    let lastScanTime = Date.now();
    let currentOperator = '';

    function initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('sessions')) {
                    const sStore = d.createObjectStore('sessions', { keyPath: 'sessionId' });
                    sStore.createIndex('by_closedAt', 'closedAt', { unique: false });
                    sStore.createIndex('by_clientName', 'clientName', { unique: false });
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
                    let closedId = null;
                    if (typeof body === 'string') {
                        try { closedId = JSON.parse(body).sessionId; } catch (e) {}
                    }
                    finalizeActiveSession(closedId);
                }

                if (this._bUrl.includes('/api2/giveout/Postings?sessionId=')) {
                    const match = this._bUrl.match(/sessionId=(\d+)/);
                    if (match) {
                        const sId = match[1];
                        const data = JSON.parse(this.responseText);
                        handleSessionPostingsData(sId, data);
                    }
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    function handleSessionPostingsData(sessionId, data) {
        const sId = String(sessionId);
        currentPostingsList = Array.isArray(data.postings) ? data.postings : [];

        const clientName = data.client?.clientShortName || '';
        const shelves = Array.isArray(data.postingsShelves) ? data.postingsShelves.join(', ') : '';

        if (!activeSession || String(activeSession.sessionId) !== sId) {
            if (activeSession) finalizeActiveSession();

            activeSession = {
                sessionId: sId,
                clientName: clientName,
                pickupCode: sessionStorage.getItem('client_code_' + sId) || '',
                foundAt: Date.now(),
                closedAt: null,
                durationSec: 0,
                operator: getOperatorLogin(),
                shelves: shelves,
                postings: currentPostingsList.map(p => ({
                    id: p.id,
                    name: p.name || p.displayName,
                    barcode: p.barcode,
                    allBarcodes: p.barcodes || [],
                    price: p.price,
                    clientAmount: p.clientAmount,
                    status: 'storage',
                    reasonText: ''
                })),
                timeline: [
                    { time: Date.now(), type: 'start', text: 'Сессия открыта' }
                ],
                alienScans: []
            };
        } else {
            activeSession.shelves = shelves;
            activeSession.clientName = clientName || activeSession.clientName;
        }
    }

    function recordTimelineEvent(type, text, isAlien = false, extraData = {}) {
        if (!activeSession) return;
        const ev = { time: Date.now(), type, text, isAlien, ...extraData };
        activeSession.timeline.push(ev);
        if (isAlien) {
            activeSession.alienScans.push(ev);
        }
    }

    function finalizeActiveSession(sId) {
        if (!activeSession) return;
        if (sId && String(activeSession.sessionId) !== String(sId)) return;

        activeSession.closedAt = Date.now();
        activeSession.durationSec = Math.max(1, Math.round((activeSession.closedAt - activeSession.foundAt) / 1000));
        activeSession.operator = getOperatorLogin() || activeSession.operator;

        const cards = Array.from(document.querySelectorAll('[data-testid="postingContentWrapper"]')).map(w => w.closest('[class*="_card_"]')).filter(Boolean);
        cards.forEach(c => {
            const txt = c.textContent;
            const barcodeMatch = txt.match(/ii\d+/i);
            const foundBarcode = barcodeMatch ? barcodeMatch[0].toLowerCase() : '';

            const pObj = activeSession.postings.find(p => p.barcode && p.barcode.toLowerCase() === foundBarcode);
            if (pObj) {
                if (txt.includes('К выдаче') && !txt.includes('К аннуляции') && !txt.includes('Отказ')) {
                    pObj.status = 'issued';
                } else if (txt.includes('К аннуляции') || txt.includes('Отказ')) {
                    pObj.status = 'annulated';
                    const reasonBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('К аннуляции'));
                    pObj.reasonText = reasonBtn ? reasonBtn.textContent.replace('К аннуляции:', '').trim() : 'Отказ';
                } else {
                    pObj.status = 'storage';
                }
            }
        });

        activeSession.timeline.push({ time: Date.now(), type: 'finish', text: 'Сессия завершена' });

        dbPut('sessions', activeSession);
        activeSession = null;
        currentPostingsList = [];
    }

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
        if (now - lastScanTime > 80) scanBuffer = '';
        lastScanTime = now;

        if (e.key === 'Enter') {
            const scanned = scanBuffer.trim();
            scanBuffer = '';

            if (scanned.length >= 4) {
                processBarcodeScan(scanned);
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            scanBuffer += e.key;
        }
    }, true);

    function processBarcodeScan(barcode) {
        const clean = barcode.toLowerCase();
        const now = Date.now();
        const currentOp = getOperatorLogin();

        if (clean.includes('*')) {
            sessionStorage.setItem('client_code_pending', barcode);
            return;
        }

        let isMatchInCurrent = false;

        if (activeSession && currentPostingsList.length > 0) {
            isMatchInCurrent = currentPostingsList.some(p => {
                const pBar = (p.barcode || '').toLowerCase();
                const pId = String(p.id || '').toLowerCase();
                const bList = (p.barcodes || []).map(b => b.toLowerCase());
                return pBar.includes(clean) || clean.includes(pBar) || pId.includes(clean) || bList.some(b => b.includes(clean));
            });

            if (isMatchInCurrent) {
                recordTimelineEvent('scan', `Отсканирован товар: ${barcode}`, false, { barcode });
            } else {
                recordTimelineEvent('alien_scan', `⚠️ ЧУЖОЙ ПИК: ${barcode} (не принадлежит заказу)`, true, { barcode });
            }
        }

        dbPut('scans_history', {
            barcode: barcode,
            sessionId: activeSession ? activeSession.sessionId : null,
            clientName: activeSession ? activeSession.clientName : null,
            operator: currentOp,
            time: now,
            isAlien: activeSession ? !isMatchInCurrent : false
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
            width: 900px !important;
            max-width: 95vw !important;
            height: 720px !important;
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
        .bb-title span {
            color: #38bdf8 !important;
        }

        .bb-tabs {
            display: flex !important;
            gap: 6px !important;
        }
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
        .bb-tab-btn:hover {
            color: #fff !important;
            background: rgba(255, 255, 255, 0.05) !important;
        }
        .bb-tab-btn.active {
            color: #38bdf8 !important;
            background: rgba(56, 189, 248, 0.12) !important;
            border-color: rgba(56, 189, 248, 0.3) !important;
        }

        .bb-close {
            color: #64748b !important;
            cursor: pointer !important;
            font-size: 18px !important;
            padding: 2px 6px !important;
        }
        .bb-close:hover { color: #fff !important; }

        .bb-body {
            flex: 1 1 auto !important;
            display: flex !important;
            overflow: hidden !important;
        }

        .bb-main-view {
            flex: 1 1 auto !important;
            padding: 16px !important;
            overflow-y: auto !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 10px !important;
        }

        .bb-replay-view {
            width: 380px !important;
            min-width: 380px !important;
            border-left: 1px solid rgba(255, 255, 255, 0.08) !important;
            background: #090d16 !important;
            padding: 16px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 10px !important;
            overflow-y: auto !important;
        }

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
        .bb-card.has-alien {
            border-left: 3px solid #ef4444 !important;
        }

        .bb-card-head {
            display: flex !important;
            justify-content: space-between !important;
            align-items: center !important;
        }
        .bb-card-name { font-weight: 700; font-size: 14px; color: #f8fafc; }
        .bb-card-time { font-size: 11px; color: #64748b; font-family: monospace; }
        .bb-card-sub { font-size: 12px; color: #94a3b8; display: flex; gap: 8px; align-items: center; }

        .bb-tag {
            font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px;
        }
        .bb-tag-warn { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .bb-tag-repeat { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }

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

    async function renderTabContent(tab) {
        const container = document.getElementById('bb-main-content');
        const sidebar = document.getElementById('bb-replay-sidebar');
        if (!container) return;

        if (tab === 'sessions') {
            sidebar.style.display = 'flex';
            const sessions = await dbGetAll('sessions');
            sessions.sort((a, b) => b.foundAt - a.foundAt);

            const clientOccurrences = {};
            sessions.forEach(s => {
                const k = (s.clientName || '').toLowerCase().trim();
                clientOccurrences[k] = (clientOccurrences[k] || 0) + 1;
            });

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
                items.forEach(s => {
                    const hasAlien = s.alienScans && s.alienScans.length > 0;
                    const isRepeat = clientOccurrences[(s.clientName || '').toLowerCase().trim()] > 1;
                    const date = new Date(s.foundAt);
                    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

                    const card = document.createElement('div');
                    card.className = `bb-card ${hasAlien ? 'has-alien' : ''}`;
                    card.innerHTML = `
                        <div class="bb-card-head">
                            <span class="bb-card-name">${s.clientName}</span>
                            <span class="bb-card-time">${timeStr} (${s.durationSec}с)</span>
                        </div>
                        <div class="bb-card-sub">
                            <span>📦 ${s.postings?.length || 0} тов.</span>
                            <span>Яч. ${s.shelves || '—'}</span>
                            <span>👤 ${s.operator}</span>
                            ${hasAlien ? `<span class="bb-tag bb-tag-warn">⚠️ Чужой пик (${s.alienScans.length})</span>` : ''}
                            ${isRepeat ? `<span class="bb-tag bb-tag-repeat">🔄 Повтор</span>` : ''}
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
                    const matchName = s.clientName.toLowerCase().includes(query);
                    const matchBarcode = s.postings?.some(p => p.barcode?.toLowerCase().includes(query));
                    return matchName || matchBarcode;
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
                const val = input.value.trim().toLowerCase();
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
                                <span>Сессия: <b>${m.clientName || 'Вне сессии'}</b></span>
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
            const alienSessions = sessions.filter(s => s.alienScans && s.alienScans.length > 0);

            if (alienSessions.length === 0) {
                container.innerHTML = '<div style="color: #10b981; font-weight: bold; text-align: center; padding: 40px;">✅ Чужих сканов и аномалий не зафиксировано!</div>';
                return;
            }

            container.innerHTML = `
                <div style="font-size: 13px; color: #ef4444; font-weight: bold; margin-bottom: 6px;">Реестр опасных сканов (товар не принадлежал клиенту на момент пика):</div>
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
                Реконструкция: ${session.clientName}
            </div>
            <div style="font-size: 11px; color: #94a3b8; display: flex; flex-direction: column; gap: 2px;">
                <div>Штрихкод: <b>${session.pickupCode || '—'}</b></div>
                <div>Оператор: <b>${session.operator}</b> · Ячейки: <b>${session.shelves || '—'}</b></div>
                <div>Длительность: <b>${session.durationSec} сек</b></div>
            </div>

            <div style="font-size: 12px; font-weight: 700; margin-top: 10px; color: #38bdf8;">Товары заказа (${session.postings?.length || 0}):</div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                ${(session.postings || []).map(p => `
                    <div style="font-size: 11px; background: rgba(255,255,255,0.02); padding: 4px 6px; border-radius: 4px;">
                        <div style="font-weight: 600;">${p.name}</div>
                        <div style="color: #64748b;">${p.barcode} · ${p.price} ₽ · <span style="color: ${p.status === 'issued' ? '#10b981' : (p.status === 'annulated' ? '#ef4444' : '#94a3b8')}">${p.status === 'issued' ? 'Выдан' : (p.status === 'annulated' ? 'Отказ (' + p.reasonText + ')' : 'На хранении')}</span></div>
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
